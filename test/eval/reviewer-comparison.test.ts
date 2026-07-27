import { describe, expect, it } from "vitest";
import { runReviewerComparison } from "../../eval/reviewer-fixture-plumbing.ts";

describe("reviewer comparison", () => {
  const report = runReviewerComparison();

  it("covers all 10 cases", () => {
    expect(report.totalCases).toBe(10);
  });

  it("reviewer removal does not reduce recall on clean cases", () => {
    const cleanCases = report.details.filter(
      (d) => d.removedByReviewer === 0,
    );
    for (const c of cleanCases) {
      const wR = c.withReviewer.recall ?? 1;
      const woR = c.withoutReviewer.recall ?? 1;
      expect(wR).toBeGreaterThanOrEqual(woR - 0.01);
    }
  });

  it("reviewer correctly rejects all noise candidates", () => {
    const noiseCase = report.details.find((d) => d.caseId === "noise-only");
    expect(noiseCase).toBeDefined();
    expect(noiseCase!.removedByReviewer).toBeGreaterThan(0);
    expect(noiseCase!.withReviewer.falsePositive).toBe(0);
    expect(noiseCase!.withReviewer.noiseRejected).toBe(true);
    expect(noiseCase!.withoutReviewer.falsePositive).toBeGreaterThan(0);
  });

  it("reviewer removes build/CI noise from mixed-noise case", () => {
    const mixedCase = report.details.find((d) => d.caseId === "mixed-noise");
    expect(mixedCase).toBeDefined();
    expect(mixedCase!.removedByReviewer).toBeGreaterThanOrEqual(2);
    expect(mixedCase!.withReviewer.falsePositive).toBe(0);
  });

  it("reports overall improvement metrics", () => {
    expect(report.casesWithImprovement).toBeGreaterThanOrEqual(2);
    expect(report.casesWithPrecisionImprovement).toBeGreaterThanOrEqual(2);
    expect(report.casesWithCleanRemoval).toBeGreaterThanOrEqual(1);
  });
});
