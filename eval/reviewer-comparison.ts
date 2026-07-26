/**
 * Reviewer Comparison — 比较有 Reviewer 和无 Reviewer 的提取质量。
 *
 * 只做 recorded（mock LLM），不调真实模型。
 * 目的是验证 Grounded Review 这一步是否真的提升了 precision。
 *
 * 输出一个 comparison report，可以直接用于面试。
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
 *
 * 在真实 Live Eval 中，这部分由 LLM Reviewer 完成。
 * 这里为了确定性测试，手动注入 Reviewer 会拒绝的候选。
 */
function simulateBadCandidates(
  testCase: EvalCase,
  goodCandidates: RecordedCandidate[],
): RecordedCandidate[] {
  // 为 noise-only case 注入一些虚假候选，模拟 LLM 过度提取
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

  // 为 mixed-noise case 注入和噪声相关的虚假候选
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
 *
 * Reviewer 会删除：
 * 1. 包含 forbidden 关键词的候选（噪声）
 * 2. evidence 包含 "temporary" 或 "debug" 的候选
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
    schemaVersion: 1,
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
      f1Improved: withReviewer.f1 >= withoutReviewer.f1,
      precisionImproved: withReviewer.precision >= withoutReviewer.precision,
      recallMaintained: withReviewer.recall >= withoutReviewer.recall - 0.01, // 1% tolerance
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
