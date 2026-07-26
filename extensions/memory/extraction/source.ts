import { createHash } from "node:crypto";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

type ReadonlySessionManager = ExtensionContext["sessionManager"];

export const MEMORY_CHECKPOINT_TYPE = "triple-pi-memory-checkpoint";
export const EXTRACTOR_VERSION = 1;

export interface ExtractionMessage {
  entryId: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export interface ExtractionCheckpoint {
  version: typeof EXTRACTOR_VERSION;
  sourceHash: string;
  lastEntryId: string;
  branchLeafId: string | null;
  savedCount: number;
}

export interface ExtractionSource {
  messages: ExtractionMessage[];
  sourceEntryIds: string[];
  sourceHash: string;
  lastEntryId: string;
  branchLeafId: string | null;
}

function messageText(entry: SessionEntry): ExtractionMessage | undefined {
  if (entry.type !== "message") return undefined;
  const message = entry.message;
  if (message.role !== "user" && message.role !== "assistant") return undefined;
  const blocks = typeof message.content === "string" ? [message.content] : message.content
    .filter((content): content is { type: "text"; text: string } => content.type === "text")
    .map((content) => content.text);
  const content = blocks.join("\n").trim();
  if (!content) return undefined;
  return { entryId: entry.id, role: message.role, content, timestamp: entry.timestamp };
}

export function findCheckpoint(branch: SessionEntry[]): ExtractionCheckpoint | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry.type !== "custom" || entry.customType !== MEMORY_CHECKPOINT_TYPE || !entry.data) continue;
    const checkpoint = entry.data as ExtractionCheckpoint;
    if (checkpoint.version === EXTRACTOR_VERSION && checkpoint.lastEntryId && checkpoint.sourceHash) {
      return checkpoint;
    }
  }
  return undefined;
}

export function buildExtractionSourceFromBranch(
  branch: SessionEntry[],
  branchLeafId: string | null,
  lastProcessedEntryId?: string,
): ExtractionSource | undefined {
  const checkpoint = findCheckpoint(branch);
  const checkpointEntryId = lastProcessedEntryId || checkpoint?.lastEntryId;
  const checkpointIndex = checkpointEntryId
    ? branch.findIndex((entry) => entry.id === checkpointEntryId)
    : -1;
  const entries = checkpointIndex >= 0 ? branch.slice(checkpointIndex + 1) : branch;
  const messages = entries.map(messageText).filter((message): message is ExtractionMessage => Boolean(message));
  if (messages.length < 2 || !messages.some((message) => message.role === "user")) return undefined;

  const sourceEntryIds = messages.map((message) => message.entryId);
  const sourceHash = createHash("sha256")
    .update(JSON.stringify({ version: EXTRACTOR_VERSION, sourceEntryIds, messages }))
    .digest("hex");
  return {
    messages,
    sourceEntryIds,
    sourceHash,
    lastEntryId: messages[messages.length - 1].entryId,
    branchLeafId,
  };
}

export function buildExtractionSource(sessionManager: ReadonlySessionManager): ExtractionSource | undefined {
  return buildExtractionSourceFromBranch(
    sessionManager.getBranch(),
    sessionManager.getLeafId(),
  );
}
