import { createHash } from "node:crypto";
import type { MemoryScope } from "../domain.ts";
import type { ExtractedCandidate } from "./pipeline.ts";
import type { ExtractionMessage } from "./source.ts";

const CORRECTION_PATTERNS = [
  /\b(?:actually|correction|instead|no longer|replace .+ with|not .+ but)\b/i,
  /(?:更正|纠正|不是.+而是|不要再.+(?:改用|使用)|改成|以后用|应该改为|不再使用)/,
];

const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;

export interface CandidateSignals {
  fingerprint: string;
  correction: boolean;
  reinforcement: number;
  score: number;
}

function normalizedTokens(value: string): string[] {
  return (value.toLocaleLowerCase().match(TOKEN_PATTERN) || [])
    .filter((token) => token.length > 1)
    .sort();
}

export function semanticFingerprint(candidate: Pick<ExtractedCandidate, "category" | "scope" | "title" | "content">): string {
  const tokens = [...new Set(normalizedTokens(`${candidate.title} ${candidate.content}`))];
  return createHash("sha256")
    .update(`${candidate.scope}\0${candidate.category}\0${tokens.join("|")}`)
    .digest("hex");
}

export function isCorrectionEvidence(evidence: string): boolean {
  return CORRECTION_PATTERNS.some((pattern) => pattern.test(evidence));
}

export function scoreCandidate(
  candidate: ExtractedCandidate,
  messages: ExtractionMessage[],
  previousReinforcement: number,
): CandidateSignals {
  const correction = isCorrectionEvidence(candidate.evidence);
  const matchingUserMessages = messages.filter((message) =>
    message.role === "user" && message.content.toLocaleLowerCase().includes(candidate.evidence.toLocaleLowerCase()),
  ).length;
  const reinforcement = Math.max(1, previousReinforcement + matchingUserMessages);
  const evidenceRatio = Math.min(1, candidate.evidence.length / Math.max(1, candidate.content.length));
  const durableCategory = candidate.category === "rule" || candidate.category === "decision" || candidate.category === "preference";
  const score = Math.min(1,
    0.45 +
    Math.min(0.2, reinforcement * 0.05) +
    evidenceRatio * 0.15 +
    (durableCategory ? 0.1 : 0) +
    (correction ? 0.1 : 0),
  );
  return {
    fingerprint: semanticFingerprint(candidate),
    correction,
    reinforcement,
    score: Number(score.toFixed(4)),
  };
}

export function reinforcementKey(projectId: string, scope: MemoryScope, fingerprint: string): string {
  return `${scope === "global" ? "global" : projectId}:${fingerprint}`;
}
