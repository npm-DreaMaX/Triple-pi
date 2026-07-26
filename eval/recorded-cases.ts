import type { EvalCase } from "./cases.ts";

export interface RecordedEvalCase {
  extraction: unknown[];
  review: unknown[];
}

export function recordedOutput(testCase: EvalCase, userEntryId: string): RecordedEvalCase {
  if (testCase.expected.length === 0) return { extraction: [], review: [] };
  const extraction = testCase.expected.map((expected) => {
    const title = expected.titleIncludes.map((part) => part[0].toUpperCase() + part.slice(1)).join(" ");
    const content = expected.contentIncludes.join("; ");
    const evidenceStart = testCase.user.toLocaleLowerCase().indexOf(expected.evidenceIncludes.toLocaleLowerCase());
    const evidence = evidenceStart >= 0
      ? testCase.user.slice(evidenceStart)
      : expected.evidenceIncludes;
    return {
      category: expected.category,
      scope: expected.scope,
      title,
      content,
      evidence,
      sourceEntryId: userEntryId,
    };
  });
  return {
    extraction,
    review: extraction.map((candidate) => ({
      action: "keep",
      reason: "recorded grounded fixture",
      title: candidate.title,
      content: candidate.content,
      evidence: candidate.evidence,
      sourceEntryId: candidate.sourceEntryId,
    })),
  };
}
