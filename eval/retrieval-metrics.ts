/**
 * Retrieval Metrics — 检索质量指标（Recall@k / MRR / Precision@k）。
 *
 * 与 eval/metrics.ts（抽取指标）正交。纯函数，零副作用。
 *
 * 语义约定：
 *   - resultIds：检索系统实际返回的记录 id 列表，按返回顺序（第一个最相关）。
 *   - expectedOrdered：期望命中的记录 id 列表，按应有的人工相关度从高到低。
 *
 * 指标：
 *   - recallAtK: expected 中出现在前 k 个结果里的比例。k 默认 = min(10, expected 长度)。
 *     单期望时退化为 0/1（命中即 1）。
 *   - mrr: 第一个命中的期望记录的倒数排名。无命中则 0。
 *   - precisionAtK: 前 k 个结果中属于 expected 的比例。衡量"噪声程度"。
 *   - failures: 人类可读的失败描述，供测试断言与报告。
 *
 * 注意：基线用例中词汇鸿沟 case 的 recallAtK 预期 < 1——这是设计意图，
 * 用来证明后续 keywords/打分 优化的收益。测试不应断言它们 = 1，
 * 而是把当前基线值记录为门槛，改动后必须 ≥ 门槛且向 1 收敛。
 */

import type { RetrievalQueryCase } from "./retrieval-cases.ts";

export interface RetrievalMetrics {
  caseId: string;
  query: string;
  resultIds: string[];
  expectedHit: string[];
  /** default k = min(10, expected.length || 10) */
  k: number;
  recallAtK: number;
  mrr: number;
  precisionAtK: number;
  /** 全部期望命中且排第一时为 true */
  perfectRank: boolean;
  failures: string[];
}

export function defaultK(expectedCount: number): number {
  if (expectedCount === 0) return 10;
  return Math.min(10, expectedCount);
}

export function evaluateRetrieval(
  testCase: RetrievalQueryCase,
  resultIds: string[],
  kOverride?: number,
): RetrievalMetrics {
  const expected = testCase.expectedOrdered;
  const k = kOverride ?? defaultK(expected.length);
  const expectedSet = new Set(expected);

  const topK = resultIds.slice(0, k);
  const expectedHit = topK.filter((id) => expectedSet.has(id));

  const recallAtK = expected.length === 0 ? 0 : expectedHit.length / expected.length;

  // MRR: 第一个命中的期望记录的 1/rank
  let mrr = 0;
  for (let i = 0; i < resultIds.length; i++) {
    if (expectedSet.has(resultIds[i])) {
      mrr = 1 / (i + 1);
      break;
    }
  }

  const precisionAtK = topK.length === 0 ? 0 : expectedHit.length / topK.length;

  // 完美排序：所有期望都被命中，且第一个期望 == resultIds[0]
  const allExpectedHit = expectedHit.length === expected.length;
  const firstExpectedAtTop = resultIds.length > 0 && expected.length > 0 && resultIds[0] === expected[0];
  const perfectRank = allExpectedHit && firstExpectedAtTop;

  const failures: string[] = [];
  if (!allExpectedHit) {
    const missed = expected.filter((id) => !expectedSet.has(id) || !topK.includes(id));
    failures.push(`recall@${k}=${recallAtK.toFixed(2)}: 未命中期望 ${JSON.stringify(missed)}`);
  }
  if (allExpectedHit && !firstExpectedAtTop && expected.length > 1) {
    failures.push(`ordering: 期望首位 ${expected[0]} 但结果首位为 ${resultIds[0]}（MRR=${mrr.toFixed(2)}）`);
  }
  // 单期望但未排第一也是退化
  if (expected.length === 1 && topK.includes(expected[0]) && resultIds[0] !== expected[0]) {
    failures.push(`single-expected not first: ${expected[0]} 在第 ${resultIds.indexOf(expected[0]) + 1} 位`);
  }

  return {
    caseId: testCase.id,
    query: testCase.query,
    resultIds,
    expectedHit,
    k,
    recallAtK: Number(recallAtK.toFixed(4)),
    mrr: Number(mrr.toFixed(4)),
    precisionAtK: Number(precisionAtK.toFixed(4)),
    perfectRank,
    failures,
  };
}

export interface RetrievalSuiteReport {
  totalCases: number;
  meanRecallAtK: number;
  meanMrr: number;
  meanPrecisionAtK: number;
  perfectRankCount: number;
  /** 基线低于 1 的 case（词汇鸿沟等，待优化） */
  belowOneCases: string[];
  perCase: RetrievalMetrics[];
}

export function aggregateRetrievalMetrics(metrics: RetrievalMetrics[]): RetrievalSuiteReport {
  const totalCases = metrics.length;
  const meanRecallAtK = totalCases ? metrics.reduce((s, m) => s + m.recallAtK, 0) / totalCases : 0;
  const meanMrr = totalCases ? metrics.reduce((s, m) => s + m.mrr, 0) / totalCases : 0;
  const meanPrecisionAtK = totalCases ? metrics.reduce((s, m) => s + m.precisionAtK, 0) / totalCases : 0;
  return {
    totalCases,
    meanRecallAtK: Number(meanRecallAtK.toFixed(4)),
    meanMrr: Number(meanMrr.toFixed(4)),
    meanPrecisionAtK: Number(meanPrecisionAtK.toFixed(4)),
    perfectRankCount: metrics.filter((m) => m.perfectRank).length,
    belowOneCases: metrics.filter((m) => m.recallAtK < 1).map((m) => m.caseId),
    perCase: metrics,
  };
}
