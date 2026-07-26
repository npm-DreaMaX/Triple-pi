import { describe, expect, it } from "vitest";
import { generateTraceId, summarizeTraces, type ExtractionTrace } from "../../eval/trace.ts";

function trace(overrides: Partial<ExtractionTrace>): ExtractionTrace {
  return {
    traceId: generateTraceId(),
    sessionId: "test",
    projectId: "test",
    sourceMessageCount: 4,
    sourceCharCount: 500,
    redactedSecretCount: 0,
    extractionRawLength: 200,
    candidateCount: 3,
    validationRejectedCount: 0,
    reviewerInputCount: 3,
    reviewerKeptCount: 2,
    reviewerRemovedCount: 1,
    savedCount: 2,
    createdCount: 2,
    replacedCount: 0,
    skippedCount: 0,
    extractionLatencyMs: 800,
    reviewLatencyMs: 600,
    commitLatencyMs: 20,
    totalLatencyMs: 1420,
    extractionInputTokens: 500,
    extractionOutputTokens: 200,
    reviewInputTokens: 800,
    reviewOutputTokens: 150,
    status: "success",
    timestamp: new Date().toISOString(),
    extractorVersion: 1,
    ...overrides,
  };
}

describe("ExtractionTrace", () => {
  it("generates unique trace IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateTraceId()));
    expect(ids.size).toBe(100);
  });

  it("summarizes a single success trace", () => {
    const summary = summarizeTraces([trace({})]);
    expect(summary.totalRuns).toBe(1);
    expect(summary.successRate).toBe(1);
    expect(summary.avgCandidates).toBe(3);
    expect(summary.avgReviewerFilterRatio).toBeCloseTo(1 / 3);
    expect(summary.avgLatencyMs).toBe(1420);
  });

  it("computes success rate correctly with mixed statuses", () => {
    const traces = [
      trace({ status: "success" }),
      trace({ status: "success" }),
      trace({ status: "success" }),
      trace({ status: "validation-failed", candidateCount: 0, savedCount: 0 }),
    ];
    const summary = summarizeTraces(traces);
    expect(summary.totalRuns).toBe(4);
    expect(summary.successRate).toBe(0.75);
    expect(summary.statuses["success"]).toBe(3);
    expect(summary.statuses["validation-failed"]).toBe(1);
  });

  it("handles empty trace array", () => {
    const summary = summarizeTraces([]);
    expect(summary.totalRuns).toBe(0);
    expect(summary.successRate).toBe(0);
    expect(summary.avgCandidates).toBe(0);
    expect(summary.avgLatencyMs).toBe(0);
  });

  it("computes P95 and P99 latency", () => {
    const traces = Array.from({ length: 100 }, (_, i) =>
      trace({ traceId: generateTraceId(), totalLatencyMs: i * 10 }),
    );
    const summary = summarizeTraces(traces);
    // P95 = floor(100 * 0.95) = index 95 → 95 × 10 = 950ms
    // P99 = floor(100 * 0.99) = index 99 → 99 × 10 = 990ms
    expect(summary.p95LatencyMs).toBe(950);
    expect(summary.p99LatencyMs).toBe(990);
  });
});
