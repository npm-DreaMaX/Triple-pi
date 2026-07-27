/**
 * EvalEvidenceV1 — versioned report contract for evaluation output.
 *
 * The summary is always derived from observations; it cannot be set
 * independently. This ensures invariants: summary numbers are reproducible
 * from the raw observations.
 */

// ── Observation types ────────────────────────────────────────────

export interface EvalObservation {
  /** Unique ID for this observation, e.g. "case-foo-run-3" */
  id: string;
  /** Eval case ID */
  caseId: string;
  /** Run number (0-based) */
  run: number;
  /** Extra group label, e.g. "live", "recorded", "with-memory", "without-memory" */
  group?: string;
  /** True positives counted */
  truePositive: number;
  /** False positives counted */
  falsePositive: number;
  /** False negatives counted */
  falseNegative: number;
  /** Was noise correctly rejected? */
  noiseRejected?: boolean;
  /** Is precision mathematically undefined (0/0)? */
  precisionUndefined?: boolean;
  /** List of human-readable failure descriptions */
  failures: string[];
  /** Pipeline/infra failure indicator */
  infraFailure?: boolean;
}

// ── Instrumentation metadata ────────────────────────────────────

export interface InstrumentationMeta {
  /** Commit SHA at eval time */
  commitSHA: string;
  /** Node.js version */
  nodeVersion: string;
  /** Model identifier, e.g. "deepseek/deepseek-v4-flash" */
  model?: string;
  /** Reviewer toggle state */
  reviewerEnabled?: boolean;
  /** Whether working tree was dirty */
  dirty?: boolean;
  /** submodule pinned SHA */
  submoduleSHA?: string;
  /** Case/prompt hash for reproducibility */
  caseHash?: string;
  /** Prompt hash for reproducibility */
  promptHash?: string;
}

// ── Summary (computed, NEVER set directly) ───────────────────────

export interface EvalSummary {
  totalObservations: number;
  meanPrecision: number | null;
  meanRecall: number;
  meanF1: number | null;
  varianceF1: number;
  worstF1: number;
  bestF1: number;
  infraFailureCount: number;
  semanticFailureCount: number;
  /** Fraction of observations that had any semantic failures */
  failureRate: number;
  /** Mean noise-rejection true-negative rate */
  noiseRejectionRate: number;
  /** Precision when excluding noise cases */
  positivePrecision: number | null;
  /** Recall when excluding noise cases */
  positiveRecall: number;
  /** Positive macro F1 */
  positiveF1: number | null;
}

// ── V1 report contract ──────────────────────────────────────────

export interface EvalEvidenceV1 {
  contractVersion: 1;
  metadata: InstrumentationMeta;
  observations: EvalObservation[];
  summary: EvalSummary;
  /** Additional per-case breakdown */
  perCase: Array<{
    caseId: string;
    totalObservations: number;
    meanF1: number;
    failureCount: number;
    fpCount: number;
  }>;
}

// ── Summary computation (the only way to produce EvalSummary) ────

export function computeSummary(observations: EvalObservation[]): EvalSummary {
  const totalObservations = observations.length;

  // Separate noise cases (expected=0 when TP+FP=0 is essentially "no records at all")
  const noiseObs = observations.filter((o) => o.noiseRejected === true);
  const positiveObs = observations.filter((o) => o.noiseRejected !== true);

  // Positive-only metrics
  const positivePrecisions = positiveObs.map((o) => {
    const denom = o.truePositive + o.falsePositive;
    return denom === 0 ? null : o.truePositive / denom;
  }).filter((p): p is number => p !== null);

  const positiveRecalls = positiveObs.map((o) => {
    const denom = o.truePositive + o.falseNegative;
    return denom === 0 ? 1 : o.truePositive / denom;
  });

  const positiveF1Values = positivePrecisions.map((p, i) => {
    const r = positiveRecalls[i];
    return p + r === 0 ? 0 : (2 * p * r) / (p + r);
  });

  // All-observation metrics (noise cases have P=R=F1=1 when noiseRejected)
  const precisions = observations.map((o) => {
    if (o.precisionUndefined) return o.noiseRejected ? 1 : null;
    const denom = o.truePositive + o.falsePositive;
    return denom === 0 ? null : o.truePositive / denom;
  }).filter((p): p is number => p !== null);

  const recalls = observations.map((o) => {
    const denom = o.truePositive + o.falseNegative;
    return denom === 0 ? 1 : o.truePositive / denom;
  });

  const f1Values = precisions.map((p, i) => {
    const r = recalls[i];
    return p + r === 0 ? 0 : (2 * p * r) / (p + r);
  });

  const meanPrecision = precisions.length > 0
    ? precisions.reduce((a, b) => a + b, 0) / precisions.length
    : null;
  const meanRecall = recalls.length > 0
    ? recalls.reduce((a, b) => a + b, 0) / recalls.length
    : 0;
  const meanF1 = f1Values.length > 0
    ? f1Values.reduce((a, b) => a + b, 0) / f1Values.length
    : null;

  const varianceF1 = f1Values.length > 0
    ? f1Values.reduce((s, v) => s + (v - (meanF1 ?? 0)) ** 2, 0) / f1Values.length
    : 0;

  const worstF1 = f1Values.length > 0 ? Math.min(...f1Values) : 0;
  const bestF1 = f1Values.length > 0 ? Math.max(...f1Values) : 0;

  const infraFailureCount = observations.filter((o) => o.infraFailure).length;
  const semanticFailureCount = observations.filter((o) => o.failures.length > 0 && !o.infraFailure).length;
  const failureRate = totalObservations > 0 ? semanticFailureCount / totalObservations : 0;
  const noiseRejectionRate = noiseObs.length > 0
    ? noiseObs.filter((o) => o.truePositive === 0 && o.falsePositive === 0).length / noiseObs.length
    : 0;

  const positivePrecision = positivePrecisions.length > 0
    ? positivePrecisions.reduce((a, b) => a + b, 0) / positivePrecisions.length
    : null;
  const positiveRecall = positiveRecalls.length > 0
    ? positiveRecalls.reduce((a, b) => a + b, 0) / positiveRecalls.length
    : 0;
  const positiveF1Val = positiveF1Values.length > 0
    ? positiveF1Values.reduce((a, b) => a + b, 0) / positiveF1Values.length
    : null;

  return {
    totalObservations,
    meanPrecision,
    meanRecall,
    meanF1,
    varianceF1,
    worstF1,
    bestF1,
    infraFailureCount,
    semanticFailureCount,
    failureRate,
    noiseRejectionRate,
    positivePrecision,
    positiveRecall,
    positiveF1: positiveF1Val,
  };
}
