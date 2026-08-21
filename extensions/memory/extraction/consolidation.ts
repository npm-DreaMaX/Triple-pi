import type { MemoryRecord } from "../domain.ts";
import type { ExtractedCandidate } from "./pipeline.ts";
import type { CandidateSignals } from "./signals.ts";
import { tokenize } from "./tokenize.ts";

export type ConsolidationAction = "create" | "replace" | "skip";

export interface ConsolidationPlan {
  action: ConsolidationAction;
  candidate: ExtractedCandidate;
  signals: CandidateSignals;
  existing?: MemoryRecord;
  reason: string;
}

export function similarity(left: string, right: string): number {
  const a = new Set(tokenize(left));
  const b = new Set(tokenize(right));
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

export function planConsolidation(
  candidate: ExtractedCandidate,
  signals: CandidateSignals,
  existing: MemoryRecord[],
): ConsolidationPlan {
  const sameCategory = existing.filter((record) =>
    record.scope === candidate.scope && record.category === candidate.category,
  );
  const exactIdentity = sameCategory.find((record) => record.title.trim().toLocaleLowerCase() === candidate.title.trim().toLocaleLowerCase());
  if (exactIdentity) {
    if (signals.correction) {
      return { action: "replace", candidate, signals, existing: exactIdentity, reason: "same-identity grounded correction" };
    }
    return { action: "skip", candidate, signals, existing: exactIdentity, reason: "same record identity" };
  }
  const fingerprintMatch = sameCategory.find((record) => record.provenance.fingerprint === signals.fingerprint);
  if (fingerprintMatch) {
    if (signals.correction) {
      return { action: "replace", candidate, signals, existing: fingerprintMatch, reason: "grounded correction" };
    }
    return { action: "skip", candidate, signals, existing: fingerprintMatch, reason: "same semantic fingerprint" };
  }

  const similar = sameCategory
    .map((record) => ({ record, score: similarity(`${candidate.title} ${candidate.content}`, `${record.title} ${record.content}`) }))
    .sort((left, right) => right.score - left.score)[0];
  if (similar && similar.score >= 0.72) {
    if (signals.correction) return { action: "replace", candidate, signals, existing: similar.record, reason: "similar grounded correction" };
    return { action: "skip", candidate, signals, existing: similar.record, reason: "deterministic near-duplicate" };
  }
  return { action: "create", candidate, signals, reason: "new durable memory" };
}
