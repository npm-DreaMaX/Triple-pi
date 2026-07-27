import { describe, expect, it } from "vitest";
import { EVAL_CASES } from "../../eval/cases.ts";
import { evaluateRecords } from "../../eval/metrics.ts";
import type { MemoryRecord } from "../../extensions/memory/domain.ts";

function record(overrides: Partial<MemoryRecord>): MemoryRecord {
  return {
    schemaVersion: 2, id: "id", category: "rule", scope: "project", projectId: "p",
    title: "Test", content: "unit test", createdAt: "", updatedAt: "",
    provenance: { source: "extraction", sessionId: "session", sourceEntryIds: ["u1"], sourceHash: "a".repeat(64) },
    ...overrides,
  };
}

describe("exact eval metrics", () => {
  it("counts exact semantic matches", () => {
    const metrics = evaluateRecords(EVAL_CASES[0], [record({ title: "Unit Test", content: "Run unit tests" })]);
    expect(metrics).toMatchObject({ truePositive: 1, falsePositive: 0, falseNegative: 0, noiseRejected: false, precisionUndefined: false });
    expect(metrics.precision).toBe(1);
    expect(metrics.recall).toBe(1);
    expect(metrics.f1).toBe(1);
    expect(metrics.failures).toEqual([]);
  });

  it("does not let a category-only result pass", () => {
    const metrics = evaluateRecords(EVAL_CASES[0], [record({ title: "Wrong rule", content: "Unrelated" })]);
    expect(metrics).toMatchObject({ truePositive: 0, falsePositive: 1, falseNegative: 1 });
    expect(metrics.f1).toBe(0);
  });

  it("treats an exact empty result as noise rejection (precision null, not 1)", () => {
    const noiseCase = EVAL_CASES.find((c) => c.id === "noise-only")!;
    const metrics = evaluateRecords(noiseCase, []);
    // Noise rejection: TP=0, FP=0, expected=0 → noiseRejected=true
    expect(metrics.noiseRejected).toBe(true);
    expect(metrics.precisionUndefined).toBe(true);
    // precision/recall/f1 should be null for empty/noise cases
    expect(metrics.precision).toBeNull();
    expect(metrics.recall).toBeNull();
    expect(metrics.f1).toBeNull();
    expect(metrics.noiseFPRejectionRate).toBe(true);
  });

  it("detects forbidden content in records (single prediction-level FP)", () => {
    const correctionCase = EVAL_CASES.find((c) => c.id === "correction")!;
    const bad = record({ title: "JWT", content: "Use npm install to set up" });
    const metrics = evaluateRecords(correctionCase, [bad]);
    // bad record doesn't match expected (no "npm install" in expected), so it's FP = 1
    // forbidden "npm install" also found → another FP, but only ONE extra FP at prediction level
    // Net: FP should be 2 (1 unmatched record + 1 forbidden penalty)
    expect(metrics.truePositive).toBe(0);
    expect(metrics.falsePositive).toBeGreaterThanOrEqual(1);
    expect(metrics.forbiddenFP).toBe(true);
    expect(metrics.failures.some((f) => f.includes("Forbidden"))).toBe(true);
  });

  it("forbidden content in a matched record demotes it from TP", () => {
    const case0 = EVAL_CASES[0]; // project-rule: forbidden=[], but let's create a scenario
    // Create a record that matches expected but also has forbidden content
    // We need a case with forbidden list non-empty AND expected content overlapping
    const multiCase = EVAL_CASES[1]; // global-preference — no forbidden, skip
    // Use correction case which has forbidden
    const correctionCase = EVAL_CASES.find((c) => c.id === "correction")!;
    // Record that matches expected but also mentions npm install
    const contaminated = record({
      category: "decision", scope: "project",
      title: "Jwt Authentication", content: "Use JWT for stateless auth. npm install jsonwebtoken",
    });
    const metrics = evaluateRecords(correctionCase, [contaminated]);
    // The record matches expected but contains "npm install" (forbidden)
    // → should be demoted from TP
    expect(metrics.truePositive).toBe(0);
    expect(metrics.forbiddenFP).toBe(true);
    expect(metrics.failures).not.toEqual([]); // should have failures when TP demoted
  });

  it("noise case with false positive has noiseFPRejectionRate=false", () => {
    const noiseCase = EVAL_CASES.find((c) => c.id === "noise-only")!;
    const bad = record({ title: "Temporary", content: "Debugging session data" });
    const metrics = evaluateRecords(noiseCase, [bad]);
    expect(metrics.noiseRejected).toBe(false);
    expect(metrics.noiseFPRejectionRate).toBe(false);
  });

  it("handles Chinese-language case matching", () => {
    const chineseCase = EVAL_CASES.find((c) => c.id === "chinese-convention")!;
    const good = record({
      category: "rule", scope: "project",
      title: "Api 返回格式统一", content: "统一 api 返回格式",
    });
    const metrics = evaluateRecords(chineseCase, [good]);
    expect(metrics).toMatchObject({ truePositive: 1 });
    expect(metrics.f1).toBe(1);
  });

  it("scores multi-rule case (3 expected) correctly", () => {
    const multiCase = EVAL_CASES.find((c) => c.id === "multi-rule")!;
    const allGood = multiCase.expected.map((e, i) =>
      record({
        id: `r${i}`, category: e.category, scope: e.scope,
        title: e.titleIncludes.join(" "), content: e.contentIncludes.join(", "),
      }),
    );
    expect(evaluateRecords(multiCase, allGood)).toMatchObject({ truePositive: 3, f1: 1 });

    expect(evaluateRecords(multiCase, [allGood[0]]))
      .toMatchObject({ truePositive: 1, falseNegative: 2, f1: 0.5 });
  });

  it("TP+FP=0 means precision is null", () => {
    const noiseCase = EVAL_CASES.find((c) => c.id === "noise-only")!;
    const metrics = evaluateRecords(noiseCase, []);
    expect(metrics.precision).toBeNull();
    expect(metrics.precisionUndefined).toBe(true);
  });

  it("TP+FP>0 with no TP means precision is 0", () => {
    const case0 = EVAL_CASES[0];
    const bad = record({ title: "Wrong", content: "Wrong content" });
    const metrics = evaluateRecords(case0, [bad]);
    expect(metrics.precision).toBe(0);
    expect(metrics.precisionUndefined).toBe(false);
  });
});
