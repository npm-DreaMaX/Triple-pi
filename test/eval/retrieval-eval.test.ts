/**
 * Retrieval Eval — Layer 2 确定性检索评测（零 LLM）。
 *
 * 直接用 repository.save 落盘结构化记录（绕过抽取/LLM），再调 repository.search，
 * 对预定义查询集算 Recall@k / MRR / Precision@k，建立检索质量基线。
 *
 * 这是后续 BM25/打分/keywords/中文分词 优化的度量基础。
 * 改动检索逻辑后重跑此文件即可得到 before/after 数字。
 *
 * 当前是"基线测试"：只固化当前行为（不要求词汇鸿沟 case 命中），
 * 但打印当前 recall/MRR 分布。后续 Phase 1/3 改进后断言会收紧到 ≥ 基线且向 1 收敛。
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RETRIEVAL_CASES, type RetrievalRecordSeed } from "../../eval/retrieval-cases.ts";
import {
  aggregateRetrievalMetrics,
  evaluateRetrieval,
  type RetrievalMetrics,
} from "../../eval/retrieval-metrics.ts";
import { FilesystemMemoryRepository } from "../../extensions/memory/repository.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map((r) => fs.rm(r, { recursive: true, force: true })));
});

/**
 * 落盘 seed 记录，建立 seedId → realRecordId 映射。
 *
 * repository.save 不接受外部 id（id = recordId(title)），故 save 后从返回值取真实 id。
 * updatedAt 通过 now seam 回放，使落盘记录的 updatedAt 反映 case 设计的 recency 顺序。
 * provenance.score / reinforcement 可注入；当前基线检索忽略它们，这是预期，
 * 证明当前检索不消费信号（M4），后续打分修复后应改善 relevance-over-recency case。
 */
async function seedAndSearch(
  root: string,
  cwd: string,
  seeds: RetrievalRecordSeed[],
  query: string,
  maxResults: number,
): Promise<{ resultIds: string[]; idMap: Map<string, string> }> {
  const idMap = new Map<string, string>();
  const referenceTime = new Date("2026-08-19T00:00:00Z").getTime();

  for (const seed of seeds) {
    const t = seed.updatedAt ? new Date(seed.updatedAt).getTime() : referenceTime;
    const repo = new FilesystemMemoryRepository({
      root,
      now: () => new Date(t),
    });
    const rec = await repo.save({
      category: seed.category as any,
      scope: seed.scope ?? "project",
      cwd,
      title: seed.title,
      content: seed.content,
      ...(seed.keywords ? { keywords: seed.keywords } : {}),
      provenance: {
        source: "manual",
        ...(seed.provenanceScore !== undefined ? { score: seed.provenanceScore } : {}),
        ...(seed.provenanceReinforcement !== undefined
          ? { reinforcement: seed.provenanceReinforcement }
          : {}),
      } as any,
    });
    idMap.set(seed.id, rec.id);
  }

  const searchRepo = new FilesystemMemoryRepository({
    root,
    now: () => new Date(referenceTime),
  });
  const hits = await searchRepo.search(query, cwd, { max: maxResults, includeProject: true });
  return { resultIds: hits.map((h) => h.record.id), idMap };
}

describe("retrieval eval — baseline", () => {
  const results: RetrievalMetrics[] = [];

  for (const testCase of RETRIEVAL_CASES) {
    it(`${testCase.id}: ${testCase.description}`, async () => {
      const root = await fs.mkdtemp(`${os.tmpdir()}/triple-pi-retrieval-`);
      roots.push(root);
      const caseRoot = path.join(root, testCase.id);

      const { resultIds, idMap } = await seedAndSearch(
        caseRoot,
        testCase.cwd,
        testCase.records,
        testCase.query,
        testCase.maxResults ?? 10,
      );

      const expectedReal = testCase.expectedOrdered
        .map((seedId) => idMap.get(seedId))
        .filter((x): x is string => Boolean(x));

      const metrics = evaluateRetrieval(
        { ...testCase, expectedOrdered: expectedReal },
        resultIds,
      );
      results.push(metrics);

      expect(metrics.caseId).toBe(testCase.id);
      console.log(
        `[retrieval baseline] ${testCase.id}: ` +
        `recall@${metrics.k}=${metrics.recallAtK} mrr=${metrics.mrr} ` +
        `precision@${metrics.k}=${metrics.precisionAtK} ` +
        `results=${JSON.stringify(resultIds)} expected=${JSON.stringify(expectedReal)}`,
      );
    });
  }

  it("reports aggregate baseline distribution", () => {
    const report = aggregateRetrievalMetrics(results);
    console.log(
      `[retrieval baseline aggregate] ` +
      `cases=${report.totalCases} meanRecall@k=${report.meanRecallAtK} ` +
      `meanMRR=${report.meanMrr} meanPrecision@k=${report.meanPrecisionAtK} ` +
      `perfectRank=${report.perfectRankCount}/${report.totalCases} ` +
      `belowOne=${JSON.stringify(report.belowOneCases)}`,
    );
    expect(report.totalCases).toBe(RETRIEVAL_CASES.length);
  });
});
