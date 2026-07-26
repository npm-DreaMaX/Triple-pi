/**
 * ExtractionTrace — 每次提取的结构化观测数据
 *
 * 所有 trace 累积写入 JSONL 文件，后续可用于：
 *  - 回答面试中的"提取成功率多少"
 *  - 评审 reviewer 是否真的提升了 precision
 *  - 定位性能瓶颈
 *  - 统计 token 成本
 */

export interface ExtractionTrace {
  /** UUID v4 */
  traceId: string;
  /** 触发提取的 session ID */
  sessionId: string;
  /** eval case ID 或真实项目标识 */
  projectId: string;

  /** ── 输入规模 ── */
  sourceMessageCount: number;
  sourceCharCount: number;
  redactedSecretCount: number;

  /** ── 提取结果 ── */
  extractionRawLength: number;
  candidateCount: number;
  validationRejectedCount: number;

  /** ── Reviewer 过滤 ── */
  reviewerInputCount: number;
  reviewerKeptCount: number;
  reviewerRemovedCount: number;

  /** ── 最终持久化 ── */
  savedCount: number;
  createdCount: number;
  replacedCount: number;
  skippedCount: number;

  /** ── 耗时 (ms) ── */
  extractionLatencyMs: number;
  reviewLatencyMs: number;
  commitLatencyMs: number;
  totalLatencyMs: number;

  /** ── Token 用量（由 Provider 返回） ── */
  extractionInputTokens?: number;
  extractionOutputTokens?: number;
  reviewInputTokens?: number;
  reviewOutputTokens?: number;

  /** ── 状态 ── */
  status: "success" | "no-source" | "validation-failed" | "review-failed" | "commit-failed" | "aborted";
  errorMessage?: string;

  /** ── 元数据 ── */
  timestamp: string;
  extractorVersion: number;
}

export interface TraceSummary {
  /** 总运行次数 */
  totalRuns: number;
  /** 成功提取并持久化的次数 */
  successCount: number;
  /** 成功率 */
  successRate: number;

  /** 平均 / 最大 / 最小 候选数 */
  avgCandidates: number;
  maxCandidates: number;
  minCandidates: number;

  /** Reviewer 的平均过滤比例 */
  avgReviewerFilterRatio: number;

  /** 平均 / P95 / P99 延迟 (ms) */
  avgLatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;

  /** 平均 token 消耗 */
  avgExtractionInputTokens: number;
  avgExtractionOutputTokens: number;
  avgReviewInputTokens: number;
  avgReviewOutputTokens: number;
  avgTotalTokens: number;

  /** 各状态计数 */
  statuses: Record<string, number>;
}

/**
 * 对 trace 数组计算汇总指标。
 */
export function summarizeTraces(traces: ExtractionTrace[]): TraceSummary {
  const succeeded = traces.filter((t) => t.status === "success");
  const successRate = traces.length > 0 ? succeeded.length / traces.length : 0;

  const candidates = traces.map((t) => t.candidateCount).filter((c) => c >= 0);
  const reviewerRatios = traces
    .filter((t) => t.reviewerInputCount > 0)
    .map((t) => t.reviewerRemovedCount / t.reviewerInputCount);

  const latencies = traces.map((t) => t.totalLatencyMs).filter((l) => l > 0);
  latencies.sort((a, b) => a - b);
  const p95 = (arr: number[]) => arr[Math.floor(arr.length * 0.95)] || arr[arr.length - 1] || 0;
  const p99 = (arr: number[]) => arr[Math.floor(arr.length * 0.99)] || arr[arr.length - 1] || 0;

  const extractInputs = traces.map((t) => t.extractionInputTokens ?? 0);
  const extractOutputs = traces.map((t) => t.extractionOutputTokens ?? 0);
  const reviewInputs = traces.map((t) => t.reviewInputTokens ?? 0);
  const reviewOutputs = traces.map((t) => t.reviewOutputTokens ?? 0);
  const totals = traces.map((t) =>
    (t.extractionInputTokens ?? 0) + (t.extractionOutputTokens ?? 0) +
    (t.reviewInputTokens ?? 0) + (t.reviewOutputTokens ?? 0),
  );

  const statuses: Record<string, number> = {};
  for (const t of traces) {
    statuses[t.status] = (statuses[t.status] || 0) + 1;
  }

  return {
    totalRuns: traces.length,
    successCount: succeeded.length,
    successRate: Math.round(successRate * 10000) / 10000,
    avgCandidates: avg(candidates),
    maxCandidates: Math.max(...candidates, 0),
    minCandidates: Math.min(...candidates, 0),
    avgReviewerFilterRatio: avg(reviewerRatios),
    avgLatencyMs: Math.round(avg(latencies)),
    p95LatencyMs: p95(latencies),
    p99LatencyMs: p99(latencies),
    avgExtractionInputTokens: Math.round(avg(extractInputs)),
    avgExtractionOutputTokens: Math.round(avg(extractOutputs)),
    avgReviewInputTokens: Math.round(avg(reviewInputs)),
    avgReviewOutputTokens: Math.round(avg(reviewOutputs)),
    avgTotalTokens: Math.round(avg(totals)),
    statuses,
  };
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/**
 * 生成唯一的 trace ID。
 */
export function generateTraceId(): string {
  // 简单的 UUID v4-like ID，零依赖
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
