/**
 * Eval Metrics — per-case evaluation of extracted MemoryRecords.
 *
 * Key rules:
 *  - Forbidden content contributes at most ONE prediction-level FP, not per-record.
 *  - A record that matches expected but ALSO contains forbidden content is
 *    demoted from TP (can't be both correct and contaminated).
 *  - Noise/empty cases report noiseRejected, but precision/recall/f1 remain
 *    null rather than faking 1.0 — positive macro must exclude them.
 *  - falseDiscoveryRate = FP / (TP + FP) when TP+FP > 0, else null.
 */

import type { MemoryRecord } from "../extensions/memory/domain.ts";
import type { EvalCase, ExpectedMemory } from "./cases.ts";

export interface EvalMetrics {
  /** True positives — records matching an expected slot */
  truePositive: number;
  /** False positives — extra records + one forbidden penalty if applicable */
  falsePositive: number;
  /** False negatives — expected slots left unfilled */
  falseNegative: number;
  /** Precision = TP / (TP + FP); null when TP+FP === 0 */
  precision: number | null;
  /** Recall = TP / expected.length; 1 when expected.length === 0 */
  recall: number | null;
  /** F1 = 2 * P * R / (P + R); null when either component is null */
  f1: number | null;
  /** True when expected=0 and predicted=0 —— noise correctly rejected */
  noiseRejected: boolean;
  /** True when TP+FP === 0 (precision mathematically undefined) */
  precisionUndefined: boolean;
  /** False discovery rate = FP / (TP + FP); null when TP+FP === 0 */
  falseDiscoveryRate: number | null;
  /** Titles of records that contributed to FP (for debugging) */
  caseFPIncidence: string[];
  /** Did any forbidden term trigger the prediction-level FP penalty? */
  forbiddenFP: boolean;
  /** For noise cases: was the noise correctly rejected (FP=0)? */
  noiseFPRejectionRate: boolean | null;
  /** Human-readable failure descriptions */
  failures: string[];
}

function includesAll(value: string, expected: string[]): boolean {
  const normalized = value.toLocaleLowerCase();
  return expected.every((part) => normalized.includes(part.toLocaleLowerCase()));
}

/**
 * Check whether a single record matches an ExpectedMemory slot (one-to-one).
 */
export function matchesExpected(record: MemoryRecord, expected: ExpectedMemory): boolean {
  return record.category === expected.category &&
    record.scope === expected.scope &&
    includesAll(record.title, expected.titleIncludes) &&
    includesAll(record.content, expected.contentIncludes) &&
    record.provenance.source === "extraction" &&
    record.provenance.sourceEntryIds?.includes(expected.sourceEntryId) === true &&
    typeof record.provenance.sessionId === "string" && record.provenance.sessionId.length > 0 &&
    typeof record.provenance.sourceHash === "string" && /^[a-f0-9]{64}$/.test(record.provenance.sourceHash);
}

/**
 * Evaluate a single case against extracted records.
 *
 * Rules applied:
 *  1. One-to-one matching: each expected slot maps to at most one record.
 *  2. A matched record that also contains forbidden text is demoted from TP.
 *  3. Forbidden content contributes at most ONE prediction-level FP.
 *  4. For noise cases (expected=0) with no predictions, noiseRejected=true
 *     and precision/recall/f1 are null (separated from positive macro).
 */
export function evaluateRecords(testCase: EvalCase, records: MemoryRecord[]): EvalMetrics {
  const failures: string[] = [];

  // ── Phase 1: one-to-one matching ──
  const matchedRecordIndices = new Set<number>();
  const recordToExpected = new Map<number, number>();

  for (let ei = 0; ei < testCase.expected.length; ei++) {
    for (let ri = 0; ri < records.length; ri++) {
      if (matchedRecordIndices.has(ri)) continue;
      if (matchesExpected(records[ri], testCase.expected[ei])) {
        // Evidence grounding: verify provenance.evidence contains quotes
        // that are verbatim substrings of user input
        const evidenceQuotes = records[ri].provenance.evidence
          ?.map((e) => e.quote)
          .filter(Boolean) ?? [];
        const evidenceGrounded = evidenceQuotes.length === 0 ||
          evidenceQuotes.some((q) => testCase.user.includes(q));
        if (!evidenceGrounded) {
          // Skip this match — evidence not grounded in user input
          continue;
        }
        matchedRecordIndices.add(ri);
        recordToExpected.set(ri, ei);
        break;
      }
    }
  }

  // ── Phase 2: find forbidden content and demote every contaminated match ──
  const forbiddenLower = testCase.forbidden.map((f) => f.toLocaleLowerCase());
  const forbiddenRecordIndices = new Set<number>();
  const forbiddenTermIndices = new Set<number>();

  records.forEach((record, ri) => {
    const text = `${record.title}\n${record.content}`.toLocaleLowerCase();
    forbiddenLower.forEach((forbidden, fi) => {
      if (text.includes(forbidden)) {
        forbiddenRecordIndices.add(ri);
        forbiddenTermIndices.add(fi);
      }
    });
  });

  for (const ri of forbiddenRecordIndices) {
    if (!recordToExpected.delete(ri)) continue;
    failures.push(`Matched record also contains forbidden content: ${records[ri].title}`);
  }

  // ── Phase 3: count TP, FN, FP ──
  const truePositive = recordToExpected.size;
  const falseNegative = testCase.expected.length - recordToExpected.size;

  // FP = unmatched records + one forbidden penalty if applicable. Contaminated
  // matches remain matched here: their corresponding expected slots already
  // count as FN, while forbidden content is penalized once at prediction level.
  const unmatchedRecords = records
    .filter((_, ri) => !matchedRecordIndices.has(ri));

  const forbiddenFP = forbiddenRecordIndices.size > 0;
  const falsePositive = unmatchedRecords.length + (forbiddenFP ? 1 : 0);
  const fpRecordTitles: string[] = unmatchedRecords.map((r) => r.title);

  for (const fi of forbiddenTermIndices) {
    failures.push(`Forbidden content persisted: ${testCase.forbidden[fi]}`);
  }

  // ── Phase 4: metrics ──
  const precisionUndefined = truePositive + falsePositive === 0;
  const precision = precisionUndefined ? null : truePositive / (truePositive + falsePositive);
  const recall = testCase.expected.length === 0 ? null : truePositive / testCase.expected.length;
  const f1 = (precision === null || recall === null) ? null
    : (precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall));

  const noiseRejected = testCase.expected.length === 0 && truePositive === 0 && falsePositive === 0;
  const falseDiscoveryRate = precisionUndefined ? null
    : (truePositive + falsePositive === 0 ? null : falsePositive / (truePositive + falsePositive));

  return {
    truePositive,
    falsePositive,
    falseNegative,
    precision,
    recall,
    f1,
    noiseRejected,
    precisionUndefined,
    falseDiscoveryRate,
    caseFPIncidence: [...new Set(fpRecordTitles)],
    forbiddenFP,
    noiseFPRejectionRate: testCase.expected.length === 0 ? (falsePositive === 0) : null,
    failures,
  };
}
