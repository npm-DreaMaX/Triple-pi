/**
 * Reviewer Fixture Plumbing — 只验证 fixture/metrics 接线，不证明 LLM Reviewer 效果。
 *
 * 这个模块模拟 bad-candidate 注入和 reviewer 的 keep/remove 决策。
 * 它不调用真实 LLM，只验证:
 *  - metrics.ts 的 evaluateRecords 能正确计算 TP/FP/FN
 *  - recorded-cases.ts 的录制数据能通过 pipeline 格式
 *  - 指标在有/无 review 时变化方向正确
 *
 * !!! 这个文件不证明 LLM Reviewer 在真实场景中有效 !!!
 * 真实 Reviewer 效果评估请使用 eval/reviewer-pilot.ts。
 */

import { EVAL_CASES, type EvalCase } from "./cases.ts";
import { evaluateRecords, type EvalMetrics } from "./metrics.ts";
import { recordedOutput, type RecordedCandidate } from "./recorded-cases.ts";
import type { MemoryRecord } from "../extensions/memory/domain.ts";

export interface ReviewerComparisonResult {
  caseId: string;
  description: string;

  /** 提取出的候选数（Review 前） */
  candidateCount: number;
  /** Review 后保留的候选数 */
  afterReviewCount: number;
  /** Reviewer 删除了多少 */
  removedByReviewer: number;

  /** 如果所有候选都直接写入（无 Reviewer），metrics 是多少 */
  withoutReviewer: EvalMetrics;
  /** 有 Reviewer 过滤后的 metrics */
  withReviewer: EvalMetrics;

  /** Reviewer 是否提升了 F1 */
  f1Improved: boolean;
  /** Reviewer 是否降低/没有降低 precision */
  precisionImproved: boolean;
  /** Reviewer 是否降低/没有降低 recall */
  recallMaintained: boolean;
}

export interface ReviewerComparisonReport {
  totalCases: number;
  casesWithImprovement: number;
  casesWithPrecisionImprovement: number;
  casesWithCleanRemoval: number; // Reviewer 正确删除了不该存的内容
  details: ReviewerComparisonResult[];
}

/**
 * Mock 一些 Reviewer 会拒绝的"坏候选"来模拟 Reviewer 的行为。
 */
function simulateBadCandidates(
  testCase: EvalCase,
  goodCandidates: RecordedCandidate[],
): RecordedCandidate[] {
  if (testCase.id === "noise-only") {
    return [
      {
        category: "fact", scope: "project", sourceEntryId: "u1",
        title: "Temporary Debugging Command",
        content: "User ran a debugging command and it passed.",
        evidence: "Try rerunning that command once",
      },
      {
        category: "knowledge", scope: "project", sourceEntryId: "u1",
        title: "Transient Network Error",
        content: "The command failed due to a transient network error.",
        evidence: "transient network error",
      },
    ];
  }

  if (testCase.id === "mixed-noise") {
    return [
      ...goodCandidates,
      {
        category: "fact", scope: "project", sourceEntryId: "u1",
        title: "Build Failed",
        content: "The build failed and needs investigation.",
        evidence: "check why the build failed",
      },
      {
        category: "fact", scope: "project", sourceEntryId: "u1",
        title: "CI Pipeline Node Version",
        content: "CI pipeline is running the wrong Node version.",
        evidence: "running the wrong Node version",
      },
    ];
  }

  return goodCandidates;
}

/**
 * 模拟 Reviewer 的 keep/remove 决策。
 */
function simulateReview(candidates: RecordedCandidate[], testCase: EvalCase): RecordedCandidate[] {
  const forbiddenLower = testCase.forbidden.map((f) => f.toLocaleLowerCase());
  const noiseMarkers = ["temporary", "debug", "transient", "rerunning"];

  return candidates.filter((c) => {
    const text = `${c.title} ${c.content} ${c.evidence}`.toLocaleLowerCase();
    if (forbiddenLower.some((f) => text.includes(f))) return false;
    if (noiseMarkers.some((marker) => text.includes(marker))) return false;
    return true;
  });
}

function candidatesToRecords(candidates: RecordedCandidate[], sessionId: string): MemoryRecord[] {
  return candidates.map((c, i) => ({
    schemaVersion: 2,
    id: `mock-${i}`,
    category: c.category as MemoryRecord["category"],
    scope: c.scope as MemoryRecord["scope"],
    projectId: "mock",
    title: c.title,
    content: c.content,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    provenance: {
      source: "extraction",
      sessionId,
      sourceEntryIds: [c.sourceEntryId],
      sourceHash: "a".repeat(64),
    },
  }));
}

/**
 * 运行 Reviewer Comparison 并生成报告。
 */
export function runReviewerComparison(): ReviewerComparisonReport {
  const details: ReviewerComparisonResult[] = [];

  for (const testCase of EVAL_CASES) {
    const recorded = recordedOutput(testCase);
    const goodCandidates = recorded.extraction;
    const allCandidates = simulateBadCandidates(testCase, goodCandidates);
    const reviewedCandidates = simulateReview(allCandidates, testCase);

    const sessionId = `reviewer-comp-${testCase.id}`;
    const withoutReviewer = evaluateRecords(
      testCase,
      candidatesToRecords(allCandidates, sessionId),
    );
    const withReviewer = evaluateRecords(
      testCase,
      candidatesToRecords(reviewedCandidates, sessionId),
    );

    details.push({
      caseId: testCase.id,
      description: testCase.description,
      candidateCount: allCandidates.length,
      afterReviewCount: reviewedCandidates.length,
      removedByReviewer: allCandidates.length - reviewedCandidates.length,
      withoutReviewer,
      withReviewer,
      f1Improved: (withReviewer.f1 ?? 0) >= (withoutReviewer.f1 ?? 0),
      precisionImproved: (withReviewer.precision ?? 0) >= (withoutReviewer.precision ?? 0),
      recallMaintained: (withReviewer.recall ?? 1) >= (withoutReviewer.recall ?? 1) - 0.01,
    });
  }

  return {
    totalCases: details.length,
    casesWithImprovement: details.filter((d) => d.f1Improved).length,
    casesWithPrecisionImprovement: details.filter((d) => d.precisionImproved).length,
    casesWithCleanRemoval: details.filter(
      (d) => d.removedByReviewer > 0 && d.withReviewer.falsePositive === 0,
    ).length,
    details,
  };
}
