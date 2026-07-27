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
  const usedExpected = new Set<number>();
  const usedRecordIndices = new Set<number>();

  for (let ei = 0; ei < testCase.expected.length; ei++) {
    if (usedExpected.has(ei)) continue;
    for (let ri = 0; ri < records.length; ri++) {
      if (usedRecordIndices.has(ri)) continue;
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
        usedExpected.add(ei);
        usedRecordIndices.add(ri);
        break;
      }
    }
  }

  // ── Phase 2: check TP records for forbidden content ──
  // Temporarily assume matched records are TP; then check each for forbidden.
  const tpRecordIndices = new Set(usedRecordIndices);
  const forbiddenLower = testCase.forbidden.map((f) => f.toLocaleLowerCase());

  for (const ri of usedRecordIndices) {
    const text = `${records[ri].title}\n${records[ri].content}`.toLocaleLowerCase();
    const hitForbidden = forbiddenLower.some((f) => text.includes(f));
    if (hitForbidden) {
      // Demote from TP: the matched record also violates policy
      tpRecordIndices.delete(ri);
      usedExpected.delete(
        [...usedExpected].find((ei) => matchesExpected(records[ri], testCase.expected[ei])) ?? -1,
      );
      failures.push(`Matched record also contains forbidden content: ${records[ri].title}`);
      break; // only one demotion needed — consistency of the set
    }
  }

  // ── Phase 3: count TP, FN, FP ──
  const truePositive = tpRecordIndices.size;
  const falseNegative = testCase.expected.length - usedExpected.size;

  // FP = unmatched records + one forbidden penalty if applicable
  const unmatchedRecords = records
    .map((r, i) => ({ r, i }))
    .filter(({ i }) => !usedRecordIndices.has(i))
    .map(({ r }) => r);

  let falsePositive = unmatchedRecords.length;
  const fpRecordTitles: string[] = unmatchedRecords.map((r) => r.title);

  // Check remaining records (including demoted ones) for forbidden content
  const forbiddenHitRecords = records.filter((r, ri) => {
    if (!tpRecordIndices.has(ri)) {
      const text = `${r.title}\n${r.content}`.toLocaleLowerCase();
      return forbiddenLower.some((f) => text.includes(f));
    }
    return false;
  });

  let forbiddenFP = false;
  if (forbiddenHitRecords.length > 0) {
    forbiddenFP = true;
    // Only add ONE prediction-level FP, not per-record or per-term
    falsePositive += 1;
  }

  for (const forbidden of testCase.forbidden) {
    const foundAnywhere = records.some((r) => {
      if (!tpRecordIndices.has(records.indexOf(r)) || !tpRecordIndices.size) {
        return `${r.title}\n${r.content}`.toLocaleLowerCase().includes(forbidden.toLocaleLowerCase());
      }
      return false;
    }) || records.some((r, ri) => {
      if (tpRecordIndices.has(ri)) return false;
      return `${r.title}\n${r.content}`.toLocaleLowerCase().includes(forbidden.toLocaleLowerCase());
    });
    if (foundAnywhere) {
      failures.push(`Forbidden content persisted: ${forbidden}`);
    }
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
