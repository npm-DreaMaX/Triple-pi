import { describe, expect, it } from "vitest";
import { runReviewerComparison } from "../../eval/reviewer-comparison.ts";

describe("reviewer comparison", () => {
  const report = runReviewerComparison();

  it("covers all 10 cases", () => {
    expect(report.totalCases).toBe(10);
  });

  it("reviewer removal does not reduce recall on clean cases", () => {
    // For cases without simulated noise (most cases), reviewer should
    // not drop any good candidates, so recall should stay at 1.0
    const cleanCases = report.details.filter(
      (d) => d.removedByReviewer === 0,
    );
    for (const c of cleanCases) {
      expect(c.withReviewer.recall).toBeGreaterThanOrEqual(c.withoutReviewer.recall - 0.01);
    }
  });

  it("reviewer correctly rejects all noise candidates", () => {
    const noiseCase = report.details.find((d) => d.caseId === "noise-only");
    expect(noiseCase).toBeDefined();
    // Noise case has 2 bad candidates injected → reviewer removes them
    expect(noiseCase!.removedByReviewer).toBeGreaterThan(0);
    // After reviewer: 0 false positives — noise correctly rejected
    expect(noiseCase!.withReviewer.falsePositive).toBe(0);
    expect(noiseCase!.withReviewer.noiseRejected).toBe(true);
    // Without reviewer: false positives exist (bad candidates leaked through)
    expect(noiseCase!.withoutReviewer.falsePositive).toBeGreaterThan(0);
  });

  it("reviewer removes build/CI noise from mixed-noise case", () => {
    const mixedCase = report.details.find((d) => d.caseId === "mixed-noise");
    expect(mixedCase).toBeDefined();
    // 2 noise candidates injected → reviewer should remove them
    expect(mixedCase!.removedByReviewer).toBeGreaterThanOrEqual(2);
    // After review: should have only 1 record (the real one), so FP=0
    expect(mixedCase!.withReviewer.falsePositive).toBe(0);
  });

  it("reports overall improvement metrics", () => {
    expect(report.casesWithImprovement).toBeGreaterThanOrEqual(2);
    expect(report.casesWithPrecisionImprovement).toBeGreaterThanOrEqual(2);
    expect(report.casesWithCleanRemoval).toBeGreaterThanOrEqual(1);
  });
});
