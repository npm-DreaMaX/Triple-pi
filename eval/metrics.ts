import type { MemoryRecord } from "../extensions/memory/domain.ts";
import type { EvalCase, ExpectedMemory } from "./cases.ts";

export interface EvalMetrics {
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  precision: number;
  recall: number;
  f1: number;
  failures: string[];
}

function includesAll(value: string, expected: string[]): boolean {
  const normalized = value.toLocaleLowerCase();
  return expected.every((part) => normalized.includes(part.toLocaleLowerCase()));
}

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

export function evaluateRecords(testCase: EvalCase, records: MemoryRecord[]): EvalMetrics {
  const matched = new Set<number>();
  const failures: string[] = [];
  let truePositive = 0;
  let falsePositive = 0;

  for (const record of records) {
    const index = testCase.expected.findIndex((expected, candidateIndex) =>
      !matched.has(candidateIndex) && matchesExpected(record, expected),
    );
    if (index >= 0) {
      matched.add(index);
      truePositive += 1;
      const evidence = testCase.expected[index].evidenceIncludes.toLocaleLowerCase();
      if (!testCase.user.toLocaleLowerCase().includes(evidence)) {
        failures.push(`Ground truth evidence missing from user input: ${evidence}`);
      }
    } else {
      falsePositive += 1;
      failures.push(`Unexpected memory: ${record.category}/${record.title}`);
    }
  }

  const falseNegative = testCase.expected.length - matched.size;
  testCase.expected.forEach((expected, index) => {
    if (!matched.has(index)) failures.push(`Missing memory: ${expected.category}/${expected.titleIncludes.join("+")}`);
  });
  for (const forbidden of testCase.forbidden) {
    if (records.some((record) => `${record.title}\n${record.content}`.toLocaleLowerCase().includes(forbidden.toLocaleLowerCase()))) {
      failures.push(`Forbidden content persisted: ${forbidden}`);
      falsePositive += 1;
    }
  }

  const precision = truePositive + falsePositive === 0 ? (testCase.expected.length === 0 ? 1 : 0) : truePositive / (truePositive + falsePositive);
  const recall = testCase.expected.length === 0 ? 1 : truePositive / testCase.expected.length;
  const f1 = precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall);
  return { truePositive, falsePositive, falseNegative, precision, recall, f1, failures };
}
