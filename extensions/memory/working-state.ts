import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  buildExtractionSourceFromBranch,
  type ExtractionMessage,
  type ExtractionSource,
} from "./extraction/source.ts";
import { containsSecret, redactSecretsFromText } from "./validation.ts";

export const WORKING_CHECKPOINT_TYPE = "triple-pi-working-checkpoint";
export const WORKING_STATE_VERSION = 1;

/**
 * Character budgets for working-state projections.
 *
 * These are hard caps applied AFTER secret redaction.  Bump them via env if
 * your sessions routinely overflow the defaults.
 *
 *   TRIPLE_PI_WORKING_REQUEST_MAX_CHARS  — latest user message (default 4,000)
 *   TRIPLE_PI_WORKING_OUTCOME_MAX_CHARS  — latest assistant response (default 6,000)
 *   TRIPLE_PI_SCRATCHPAD_MAX_CHARS       — per-session scratchpad (default 8,000)
 *   TRIPLE_PI_DAILY_MAX_CHARS            — per-day daily roll-up (default 64,000)
 */

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const WORKING_REQUEST_MAX_CHARS = envInt("TRIPLE_PI_WORKING_REQUEST_MAX_CHARS", 4_000);
export const WORKING_OUTCOME_MAX_CHARS = envInt("TRIPLE_PI_WORKING_OUTCOME_MAX_CHARS", 6_000);
export const SCRATCHPAD_MAX_CHARS = envInt("TRIPLE_PI_SCRATCHPAD_MAX_CHARS", 8_000);
export const DAILY_MAX_CHARS = envInt("TRIPLE_PI_DAILY_MAX_CHARS", 64_000);

// ── Field semantic rename ──────────────────────────────────────
// currentRequest → userRequest (what the user typed)
// latestOutcome → assistantReportedOutcome (unverified assistant report)

export interface WorkingCheckpoint {
  version: typeof WORKING_STATE_VERSION;
  sourceHash: string;
  lastEntryId: string;
  branchLeafId: string | null;
  state?: WorkingStateUpdate;
}

export interface WorkingStateUpdate {
  version: typeof WORKING_STATE_VERSION;
  sourceHash: string;
  lastEntryId: string;
  branchLeafId: string | null;
  sessionId: string;
  updatedAt: string;
  date: string;
  /** @deprecated Renamed to userRequest — kept for backward compat parsing */
  currentRequest?: string;
  /** @deprecated Renamed to assistantReportedOutcome — kept for backward compat parsing */
  latestOutcome?: string;
  /** The user's current request (renamed from currentRequest) */
  userRequest: string;
  /** The assistant's latest reported outcome (renamed from latestOutcome) — unverified */
  assistantReportedOutcome: string;
  sourceEntryIds: string[];
}

// ── Validation error types ─────────────────────────────────────

export type WorkingValidationErrorCode =
  | "invalid-version"
  | "invalid-sourceHash"
  | "invalid-sessionId"
  | "invalid-lastEntryId"
  | "invalid-updatedAt"
  | "invalid-date"
  | "missing-userRequest"
  | "missing-assistantReportedOutcome"
  | "too-long-userRequest"
  | "too-long-assistantReportedOutcome"
  | "invalid-sourceEntryIds"
  | "sessionKey-mismatch"
  | "contains-secret";

export class WorkingValidationError extends Error {
  code: WorkingValidationErrorCode;
  constructor(code: WorkingValidationErrorCode, message: string) {
    super(message);
    this.name = "WorkingValidationError";
    this.code = code;
  }
}

// ═══════════════════════════════════════════════════════════════
// Strict parsers
// ═══════════════════════════════════════════════════════════════

const HEX64 = /^[a-f0-9]{64}$/;
const HEX24 = /^[a-f0-9]{24}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseString(value: unknown, label: string): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value;
}

function isValidISODate(value: string): boolean {
  return ISO_DATE.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * Strictly parse a WorkingStateUpdate from an untrusted value.
 * Returns the validated update or throws WorkingValidationError.
 */
export function parseWorkingStateUpdate(value: unknown): WorkingStateUpdate {
  if (!isObject(value)) throw new WorkingValidationError("invalid-version", "WorkingStateUpdate must be an object");

  const version = value["version"];
  if (version !== WORKING_STATE_VERSION) {
    throw new WorkingValidationError("invalid-version", `Expected version ${WORKING_STATE_VERSION}, got ${String(version)}`);
  }

  const sourceHash = parseString(value["sourceHash"], "sourceHash");
  if (!sourceHash || !HEX64.test(sourceHash)) {
    throw new WorkingValidationError("invalid-sourceHash", "sourceHash must be a 64-character hex string");
  }

  const lastEntryId = parseString(value["lastEntryId"], "lastEntryId");
  if (!lastEntryId) {
    throw new WorkingValidationError("invalid-lastEntryId", "lastEntryId must be non-empty");
  }

  const sessionId = parseString(value["sessionId"], "sessionId");
  if (!sessionId) {
    throw new WorkingValidationError("invalid-sessionId", "sessionId must be non-empty");
  }

  const updatedAt = parseString(value["updatedAt"], "updatedAt");
  if (!updatedAt || !isValidISODate(updatedAt)) {
    throw new WorkingValidationError("invalid-updatedAt", "updatedAt must be a valid ISO date string");
  }

  const date = parseString(value["date"], "date");
  if (!date || !DATE_ONLY.test(date)) {
    throw new WorkingValidationError("invalid-date", "date must be a YYYY-MM-DD string");
  }

  // Accept new field names with old names as fallback
  const userRequest = parseString(value["userRequest"], "userRequest") ||
    parseString(value["currentRequest"], "currentRequest");
  if (!userRequest) {
    throw new WorkingValidationError("missing-userRequest", "userRequest (or deprecated currentRequest) must be non-empty");
  }
  if (userRequest.length > WORKING_REQUEST_MAX_CHARS) {
    throw new WorkingValidationError("too-long-userRequest", `userRequest exceeds ${WORKING_REQUEST_MAX_CHARS} chars`);
  }

  const assistantReportedOutcome = parseString(value["assistantReportedOutcome"], "assistantReportedOutcome") ||
    parseString(value["latestOutcome"], "latestOutcome");
  if (!assistantReportedOutcome) {
    throw new WorkingValidationError("missing-assistantReportedOutcome", "assistantReportedOutcome (or deprecated latestOutcome) must be non-empty");
  }
  if (assistantReportedOutcome.length > WORKING_OUTCOME_MAX_CHARS) {
    throw new WorkingValidationError("too-long-assistantReportedOutcome", `assistantReportedOutcome exceeds ${WORKING_OUTCOME_MAX_CHARS} chars`);
  }

  // Check date consistency with updatedAt
  if (updatedAt.slice(0, 10) !== date) {
    throw new WorkingValidationError("invalid-date", `date ${date} does not match updatedAt date ${updatedAt.slice(0, 10)}`);
  }

  const sourceEntryIds = value["sourceEntryIds"];
  if (!Array.isArray(sourceEntryIds) || sourceEntryIds.length === 0 || sourceEntryIds.length > 10) {
    throw new WorkingValidationError("invalid-sourceEntryIds", "sourceEntryIds must be a non-empty array (max 10)");
  }
  for (const id of sourceEntryIds) {
    if (typeof id !== "string" || !id.trim()) {
      throw new WorkingValidationError("invalid-sourceEntryIds", "Each sourceEntryId must be a non-empty string");
    }
  }

  const branchLeafId = typeof value["branchLeafId"] === "string" ? value["branchLeafId"] as string : null;

  // Check for secrets in working state content
  if (containsSecret(userRequest) || containsSecret(assistantReportedOutcome)) {
    throw new WorkingValidationError("contains-secret", "Working state contains potential secrets");
  }

  return {
    version,
    sourceHash,
    lastEntryId,
    branchLeafId,
    sessionId,
    updatedAt,
    date,
    userRequest,
    assistantReportedOutcome,
    sourceEntryIds: sourceEntryIds as string[],
  };
}

/**
 * Strictly parse a WorkingCheckpoint from an untrusted value.
 * Returns the validated checkpoint or throws WorkingValidationError.
 */
export function parseWorkingCheckpoint(value: unknown): WorkingCheckpoint {
  if (!isObject(value)) throw new WorkingValidationError("invalid-version", "WorkingCheckpoint must be an object");

  const version = value["version"];
  if (version !== WORKING_STATE_VERSION) {
    throw new WorkingValidationError("invalid-version", `Expected version ${WORKING_STATE_VERSION}, got ${String(version)}`);
  }

  const sourceHash = parseString(value["sourceHash"], "sourceHash");
  if (!sourceHash || !HEX64.test(sourceHash)) {
    throw new WorkingValidationError("invalid-sourceHash", "sourceHash must be a 64-character hex string");
  }

  const lastEntryId = parseString(value["lastEntryId"], "lastEntryId");
  if (!lastEntryId) {
    throw new WorkingValidationError("invalid-lastEntryId", "lastEntryId must be non-empty");
  }

  const branchLeafId = typeof value["branchLeafId"] === "string" ? value["branchLeafId"] as string : null;

  let state: WorkingStateUpdate | undefined;
  if (value["state"] !== undefined && value["state"] !== null) {
    state = parseWorkingStateUpdate(value["state"]);
  }

  return {
    version,
    sourceHash,
    lastEntryId,
    branchLeafId,
    state,
  };
}

/**
 * Strictly parse a working latest.json value.
 * Returns { sessionKey, update } or throws WorkingValidationError.
 */
export function parseWorkingLatest(value: unknown): { sessionKey: string; update: WorkingStateUpdate } {
  if (!isObject(value)) throw new WorkingValidationError("invalid-version", "WorkingLatest must be an object");

  const sessionKey = parseString(value["sessionKey"], "sessionKey");
  if (!sessionKey || !HEX24.test(sessionKey)) {
    throw new WorkingValidationError("sessionKey-mismatch", "sessionKey must be a 24-character hex string");
  }

  const update = parseWorkingStateUpdate(value["update"]);

  // Verify sessionKey consistency with sessionId
  const expectedSessionKey = createHash("sha256").update(update.sessionId).digest("hex").slice(0, 24);
  if (sessionKey !== expectedSessionKey) {
    throw new WorkingValidationError("sessionKey-mismatch", "sessionKey does not match hash of sessionId");
  }

  return { sessionKey, update };
}

// ═══════════════════════════════════════════════════════════════
// Checkpoint finder (uses strict parser)
// ═══════════════════════════════════════════════════════════════

export function findWorkingCheckpoint(branch: SessionEntry[]): WorkingCheckpoint | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry.type === "custom" && entry.customType === WORKING_CHECKPOINT_TYPE && entry.data) {
      try {
        return parseWorkingCheckpoint(entry.data);
      } catch {
        // Corrupt checkpoint — skip and try older ones.
      }
    }
  }
  return undefined;
}

function bounded(value: string, max: number): string {
  const normalized = value.trim().replace(/\n{3,}/g, "\n\n");
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1).trimEnd()}…`;
}

function latest(messages: ExtractionMessage[], role: "user" | "assistant"): ExtractionMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === role) return messages[index];
  }
  return undefined;
}

export function buildWorkingSource(
  branch: SessionEntry[],
  branchLeafId: string | null,
): ExtractionSource | undefined {
  return buildExtractionSourceFromBranch(
    branch,
    branchLeafId,
    findWorkingCheckpoint(branch)?.lastEntryId,
  );
}

export function buildWorkingStateUpdate(
  source: ExtractionSource,
  sessionId: string,
  now: Date,
): WorkingStateUpdate | undefined {
  const user = latest(source.messages, "user");
  const assistant = latest(source.messages, "assistant");
  if (!user || !assistant) return undefined;

  // Redact individual message content
  const { text: userRedacted } = redactSecretsFromText(user.content);
  const { text: assistantRedacted } = redactSecretsFromText(assistant.content);

  const sourceHash = createHash("sha256")
    .update(JSON.stringify({ version: WORKING_STATE_VERSION, sourceHash: source.sourceHash }))
    .digest("hex");

  return {
    version: WORKING_STATE_VERSION,
    sourceHash,
    lastEntryId: source.lastEntryId,
    branchLeafId: source.branchLeafId,
    sessionId,
    updatedAt: now.toISOString(),
    date: now.toISOString().slice(0, 10),
    userRequest: bounded(userRedacted, WORKING_REQUEST_MAX_CHARS),
    assistantReportedOutcome: bounded(assistantRedacted, WORKING_OUTCOME_MAX_CHARS),
    sourceEntryIds: [user.entryId, assistant.entryId],
  };
}

export function renderScratchpad(update: WorkingStateUpdate): string {
  const userRequest = update.userRequest || update.currentRequest || "";
  const assistantReportedOutcome = update.assistantReportedOutcome || update.latestOutcome || "";
  return bounded([
    "# Working State",
    "",
    `Updated: ${update.updatedAt}`,
    `Session: ${update.sessionId}`,
    "",
    "## Current Request",
    "",
    userRequest,
    "",
    "## Latest Outcome",
    "",
    assistantReportedOutcome,
    "",
    `Source entries: ${update.sourceEntryIds.join(", ")}`,
    "",
  ].join("\n"), SCRATCHPAD_MAX_CHARS) + "\n";
}

export function renderDailyEntry(update: WorkingStateUpdate): string {
  const userRequest = update.userRequest || update.currentRequest || "";
  const assistantReportedOutcome = update.assistantReportedOutcome || update.latestOutcome || "";
  return [
    `## ${update.updatedAt} · ${update.sessionId}`,
    "",
    "### Request",
    "",
    userRequest,
    "",
    "### Outcome",
    "",
    assistantReportedOutcome,
    "",
    `Source entries: ${update.sourceEntryIds.join(", ")}`,
    "",
  ].join("\n");
}
