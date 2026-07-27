import { isMemoryCategory, type MemoryCategory, type MemoryScope } from "../domain.ts";
import {
  containsSecret as containsSecretValidation,
  resolveAutomaticScope,
} from "../validation.ts";
import type { ExtractionMessage, ExtractionSource } from "./source.ts";

const MAX_CANDIDATES = 10;
const MAX_TITLE_LENGTH = 120;
const MAX_CONTENT_LENGTH = 2_000;
const MAX_EVIDENCE_LENGTH = 500;

// Keep existing SECRET_PATTERNS for backward compatibility in redactSecrets.
// New code should import containsSecret / redactSecretsFromText from validation.ts.
const SECRET_PATTERNS = [
  /\b(?:sk|pk|api|key|token|secret)[-_][a-zA-Z0-9_-]{12,}\b/gi,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /\bAuthorization\s*:\s*Bearer\s+[^\s,;]+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:password|passwd|api[_-]?key|access[_-]?token|secret)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
];

export interface ExtractedCandidate {
  category: MemoryCategory;
  title: string;
  content: string;
  evidence: string;
  sourceEntryId: string;
  scope: MemoryScope;
}

export class CandidateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CandidateValidationError";
  }
}

export interface PreparedExtraction {
  redactedMessages: ExtractionMessage[];
  containedSecrets: boolean;
}

export function redactSecrets(messages: ExtractionMessage[]): PreparedExtraction {
  let containedSecrets = false;
  const redactedMessages = messages.map((message) => {
    let content = message.content;
    for (const pattern of SECRET_PATTERNS) {
      content = content.replace(pattern, () => {
        containedSecrets = true;
        return "[REDACTED_SECRET]";
      });
    }
    return { ...message, content };
  });
  return { redactedMessages, containedSecrets };
}

export function containsSecret(value: string): boolean {
  return containsSecretValidation(value);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateCandidates(raw: string, source: ExtractionSource): ExtractedCandidate[] {
  // Strip markdown fences — some models wrap JSON output
  const stripped = raw.trim().startsWith("```")
    ? raw.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "")
    : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    throw new CandidateValidationError("Extraction output is not valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_CANDIDATES) {
    throw new CandidateValidationError("Extraction output must be a bounded array");
  }

  const userMessages = new Map(
    source.messages.filter((message) => message.role === "user")
      .map((message) => [message.entryId, message]),
  );
  const candidates: ExtractedCandidate[] = [];

  for (const value of parsed) {
    if (!plainObject(value)) throw new CandidateValidationError("Extraction candidate failed strict validation");
    const keys = Object.keys(value).sort();
    const expected = ["category", "content", "evidence", "scope", "sourceEntryId", "title"];
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new CandidateValidationError("Extraction candidate failed strict validation");
    const { category, title, content, evidence, sourceEntryId, scope } = value;
    if (
      typeof category !== "string" || !isMemoryCategory(category) ||
      typeof title !== "string" || !title.trim() || title.length > MAX_TITLE_LENGTH ||
      typeof content !== "string" || !content.trim() || content.length > MAX_CONTENT_LENGTH ||
      typeof evidence !== "string" || !evidence.trim() || evidence.length > MAX_EVIDENCE_LENGTH ||
      typeof sourceEntryId !== "string" ||
      (scope !== "project" && scope !== "global")
    ) throw new CandidateValidationError("Extraction candidate failed strict validation");
    // Apply automatic scope guard — global candidates without explicit
    // cross-project evidence are deterministically downgraded to project.
    const validatedScope = resolveAutomaticScope(scope, evidence);
    const sourceMessage = userMessages.get(sourceEntryId);
    if (!sourceMessage || !sourceMessage.content.includes(evidence)) throw new CandidateValidationError("Extraction candidate failed strict validation");
    if (
      evidence.includes("[REDACTED_SECRET]") ||
      content.includes("[REDACTED_SECRET]") ||
      containsSecret(title) ||
      containsSecret(content) ||
      containsSecret(evidence)
    ) throw new CandidateValidationError("Extraction candidate contains secret material");

    candidates.push({
      category,
      title: title.trim(),
      content: content.trim(),
      evidence,
      sourceEntryId,
      scope: validatedScope,
    });
  }
  return candidates;
}
