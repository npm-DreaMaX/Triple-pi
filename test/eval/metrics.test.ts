import { describe, expect, it } from "vitest";
import { EVAL_CASES } from "../../eval/cases.ts";
import { evaluateRecords } from "../../eval/metrics.ts";
import type { MemoryRecord } from "../../extensions/memory/domain.ts";

function record(overrides: Partial<MemoryRecord>): MemoryRecord {
  return {
    schemaVersion: 1, id: "id", category: "rule", scope: "project", projectId: "p",
    title: "Test", content: "unit test", createdAt: "", updatedAt: "",
    provenance: { source: "extraction", sessionId: "session", sourceEntryIds: ["u1"], sourceHash: "a".repeat(64) },
    ...overrides,
  };
}

describe("exact eval metrics", () => {
  it("counts exact semantic matches", () => {
    const metrics = evaluateRecords(EVAL_CASES[0], [record({ title: "Unit Test", content: "Run unit tests" })]);
    expect(metrics).toMatchObject({ truePositive: 1, falsePositive: 0, falseNegative: 0, precision: 1, recall: 1, f1: 1 });
    expect(metrics.failures).toEqual([]);
  });

  it("does not let a category-only result pass", () => {
    const metrics = evaluateRecords(EVAL_CASES[0], [record({ title: "Wrong rule", content: "Unrelated" })]);
    expect(metrics).toMatchObject({ truePositive: 0, falsePositive: 1, falseNegative: 1, f1: 0 });
    expect(metrics.failures).toHaveLength(2);
  });

  it("treats an exact empty result as perfect noise rejection", () => {
    const noiseCase = EVAL_CASES.find((c) => c.id === "noise-only")!;
    expect(evaluateRecords(noiseCase, [])).toMatchObject({ precision: 1, recall: 1, f1: 1 });
    // Forbidden check: record must match forbidden atom exactly as substring
    const badRecord = record({ title: "Temporary Debugging", content: "command passed transient" });
    expect(evaluateRecords(noiseCase, [badRecord]).failures)
      .toContain("Forbidden content persisted: temporary debugging");
  });

  it("scores multi-rule case (3 expected) correctly", () => {
    const multiCase = EVAL_CASES.find((c) => c.id === "multi-rule")!;
    // All 3 expected correctly extracted
    const allGood = multiCase.expected.map((e, i) =>
      record({
        id: `r${i}`, category: e.category, scope: e.scope,
        title: e.titleIncludes.join(" "), content: e.contentIncludes.join(", "),
      }),
    );
    expect(evaluateRecords(multiCase, allGood)).toMatchObject({ truePositive: 3, f1: 1 });

    // Only 1 of 3 extracted — 2 FN
    expect(evaluateRecords(multiCase, [allGood[0]]))
      .toMatchObject({ truePositive: 1, falseNegative: 2, f1: 0.5 });
  });

  it("detects forbidden content in any record", () => {
    const correctionCase = EVAL_CASES.find((c) => c.id === "correction")!;
    const bad = record({ title: "JWT", content: "Use npm install to set up" });
    const metrics = evaluateRecords(correctionCase, [bad]);
    expect(metrics.falsePositive).toBeGreaterThanOrEqual(1);
    expect(metrics.failures.some((f) => f.includes("Forbidden"))).toBe(true);
  });

  it("handles Chinese-language case matching", () => {
    const chineseCase = EVAL_CASES.find((c) => c.id === "chinese-convention")!;
    const good = record({
      category: "rule", scope: "project",
      title: "Api 返回格式统一", content: "统一 api 返回格式",
    });
    expect(evaluateRecords(chineseCase, [good])).toMatchObject({ truePositive: 1, f1: 1 });
  });
});
