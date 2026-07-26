import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { redactSecrets } from "./extraction/pipeline.ts";
import {
  buildExtractionSourceFromBranch,
  type ExtractionMessage,
  type ExtractionSource,
} from "./extraction/source.ts";

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
  currentRequest: string;
  latestOutcome: string;
  sourceEntryIds: string[];
}

function isWorkingCheckpoint(value: unknown): value is WorkingCheckpoint {
  if (!value || typeof value !== "object") return false;
  const checkpoint = value as Record<string, unknown>;
  return checkpoint.version === WORKING_STATE_VERSION &&
    typeof checkpoint.sourceHash === "string" &&
    typeof checkpoint.lastEntryId === "string" &&
    (typeof checkpoint.branchLeafId === "string" || checkpoint.branchLeafId === null);
}

export function findWorkingCheckpoint(branch: SessionEntry[]): WorkingCheckpoint | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry.type === "custom" && entry.customType === WORKING_CHECKPOINT_TYPE && isWorkingCheckpoint(entry.data)) {
      return entry.data;
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
  const redacted = redactSecrets(source.messages).redactedMessages;
  const user = latest(redacted, "user");
  const assistant = latest(redacted, "assistant");
  if (!user || !assistant) return undefined;
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
    currentRequest: bounded(user.content, WORKING_REQUEST_MAX_CHARS),
    latestOutcome: bounded(assistant.content, WORKING_OUTCOME_MAX_CHARS),
    sourceEntryIds: [user.entryId, assistant.entryId],
  };
}

export function renderScratchpad(update: WorkingStateUpdate): string {
  return bounded([
    "# Working State",
    "",
    `Updated: ${update.updatedAt}`,
    `Session: ${update.sessionId}`,
    "",
    "## Current Request",
    "",
    update.currentRequest,
    "",
    "## Latest Outcome",
    "",
    update.latestOutcome,
    "",
    `Source entries: ${update.sourceEntryIds.join(", ")}`,
    "",
  ].join("\n"), SCRATCHPAD_MAX_CHARS) + "\n";
}

export function renderDailyEntry(update: WorkingStateUpdate): string {
  return [
    `## ${update.updatedAt} · ${update.sessionId}`,
    "",
    "### Request",
    "",
    update.currentRequest,
    "",
    "### Outcome",
    "",
    update.latestOutcome,
    "",
    `Source entries: ${update.sourceEntryIds.join(", ")}`,
    "",
  ].join("\n");
}
