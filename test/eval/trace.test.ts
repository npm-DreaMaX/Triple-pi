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
    extractionStatus: "ok",
    status: "success",
    timestamp: new Date().toISOString(),
    extractorVersion: 1,
    ...overrides,
  };
}

describe("ExtractionTrace", () => {
  it("generates unique trace IDs using crypto.randomUUID", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateTraceId()));
    expect(ids.size).toBe(100);
    // Verify UUID v4 format
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    for (const id of ids) {
      expect(id).toMatch(uuidPattern);
    }
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
    expect(summary.p95LatencyMs).toBe(950);
    expect(summary.p99LatencyMs).toBe(990);
  });

  it("includes pipeline stage fields in the type", () => {
    const t = trace({
      extractionStatus: "failed",
      providerFailure: "timeout",
      reviewFailure: "schema error",
      commitFailure: "disk full",
      status: "infra-failure",
    });
    expect(t.extractionStatus).toBe("failed");
    expect(t.providerFailure).toBe("timeout");
    expect(t.reviewFailure).toBe("schema error");
    expect(t.commitFailure).toBe("disk full");
    expect(t.status).toBe("infra-failure");
  });
});
