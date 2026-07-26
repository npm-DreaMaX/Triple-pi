import type { EvalCase, ExpectedMemory } from "./cases.ts";

export interface RecordedEvalCase {
  extraction: RecordedCandidate[];
  review: RecordedDecision[];
}

export interface RecordedCandidate {
  category: string;
  scope: string;
  title: string;
  content: string;
  evidence: string;
  sourceEntryId: string;
}

export interface RecordedDecision {
  action: "keep" | "remove";
  reason: string;
  title: string;
  content: string;
  evidence: string;
  sourceEntryId: string;
}

function buildTitle(expected: ExpectedMemory): string {
  return expected.titleIncludes
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function buildContent(expected: ExpectedMemory): string {
  return expected.contentIncludes.join("; ");
}

function findEvidence(userText: string, evidenceAtom: string): string {
  const lowerUser = userText.toLocaleLowerCase();
  const lowerAtom = evidenceAtom.toLocaleLowerCase();
  const idx = lowerUser.indexOf(lowerAtom);
  if (idx >= 0) return userText.slice(idx, idx + evidenceAtom.length);
  // Fallback: search for partial match
  const words = lowerAtom.split(/\s+/);
  for (const word of words) {
    const wordIdx = lowerUser.indexOf(word);
    if (wordIdx >= 0) {
      return userText.slice(wordIdx, wordIdx + lowerAtom.length);
    }
  }
  return evidenceAtom;
}

/**
 * 把 EvalCase 的 expected 数组转换成"录制的 LLM 输出"。
 *
 * 这是 recorded eval 的核心：用预定义的正确答案模拟 LLM 返回，
 * 验证 pipeline 的接线和确定性逻辑能正确处理这些数据。
 */
export function recordedOutput(testCase: EvalCase): RecordedEvalCase {
  // Noise case: 返回空数组，LLM 正确判断没有可提取的记忆
  if (testCase.expected.length === 0) {
    return { extraction: [], review: [] };
  }

  const extraction: RecordedCandidate[] = testCase.expected.map((expected) => ({
    category: expected.category,
    scope: expected.scope,
    title: buildTitle(expected),
    content: buildContent(expected),
    evidence: findEvidence(testCase.user, expected.evidenceIncludes),
    sourceEntryId: expected.sourceEntryId,
  }));

  const review: RecordedDecision[] = extraction.map((candidate) => ({
    action: "keep" as const,
    reason: "recorded grounded fixture — user explicitly stated this",
    title: candidate.title,
    content: candidate.content,
    evidence: candidate.evidence,
    sourceEntryId: candidate.sourceEntryId,
  }));

  return { extraction, review };
}
