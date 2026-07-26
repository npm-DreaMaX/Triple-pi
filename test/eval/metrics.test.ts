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
    expect(evaluateRecords(EVAL_CASES[3], [])).toMatchObject({ precision: 1, recall: 1, f1: 1 });
    expect(evaluateRecords(EVAL_CASES[3], [record({ title: "Temporary debugging", content: "command passed" })]).failures)
      .toContain("Forbidden content persisted: temporary debugging");
  });
});
