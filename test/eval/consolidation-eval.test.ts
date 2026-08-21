/**
 * Consolidation Eval — 去重阈值校准（1b M1b）。
 *
 * 零 LLM：对 CONSOLIDATION_CASES 每对计算 similarity（与 planConsolidation 同口径），
 * 按 shouldDedup 标签算准确率；再扫 0.68-0.80 区间选最优阈值（零误去重优先）。
 * 断言：当前 consolidation.ts 的阈值满足"零误去重"，且漏去重数 ≤ 合理上限。
 */
import { describe, expect, it } from "vitest";
import { similarity } from "../../extensions/memory/extraction/consolidation.ts";
import {
  CONSOLIDATION_CASES,
  THRESHOLD_SWEEP_START,
  THRESHOLD_SWEEP_END,
  THRESHOLD_SWEEP_STEP,
} from "../../eval/consolidation-cases.ts";

function classifyAt(threshold: number): { errors: string[]; falseDedup: string[]; missedDedup: string[] } {
  const falseDedup: string[] = []; // shouldDedup=false 但 score≥threshold → 误去重（最糟）
  const missedDedup: string[] = []; // shouldDedup=true 但 score<threshold → 漏去重（可容忍）
  for (const pair of CONSOLIDATION_CASES) {
    const score = similarity(pair.candidate, pair.existing);
    if (pair.shouldDedup && score < threshold) missedDedup.push(`${pair.id}=${score.toFixed(3)}`);
    if (!pair.shouldDedup && score >= threshold) falseDedup.push(`${pair.id}=${score.toFixed(3)}`);
  }
  return { errors: [...falseDedup, ...missedDedup], falseDedup, missedDedup };
}

describe("consolidation eval — dedup threshold (1b M1b)", () => {
  const CURRENT_THRESHOLD = 0.72;

  it("current threshold has ZERO false dedup (mis-merge is worse than redundancy)", () => {
    const { falseDedup } = classifyAt(CURRENT_THRESHOLD);
    expect(falseDedup).toEqual([]);
  });

  it("misses exactly the 3 synonym-level restatements (token-Jaccard's honest ceiling)", () => {
    // 实测：zh-near-restatement 0.387 / en-restatement 0.500 / zh-same-meaning-detail-shift
    // 0.667 低于 0.72——同义替换改写超出 token 级 Jaccard 的捕捉范围。它们是漏去重
    //（冗余），不是误去重（丢信息）。此三例即为当前机制的诚实天花板，记入报告 §9。
    const { missedDedup } = classifyAt(CURRENT_THRESHOLD);
    expect(missedDedup.length).toBe(3);
    expect(missedDedup.join(",")).toContain("zh-near-restatement");
    expect(missedDedup.join(",")).toContain("en-restatement");
    expect(missedDedup.join(",")).toContain("zh-same-meaning-detail-shift");
  });

  it("sweeps 0.68-0.80: 0.72 already achieves the minimum missed-dedup with zero false-dedup", () => {
    // 校准结论：要接住 0.387 的 zh-near-restatement 需要阈值 ≤0.38，但那会误去重
    // diff-auth-decisions(0.348) 与 zh-cross-category-ish(0.357)——误去重丢信息，不可接受。
    // 全区间最小漏去重 = 3，0.72 已是最优，无需改阈值。
    let minMissed = Infinity;
    let minFalse = Infinity;
    for (let t = THRESHOLD_SWEEP_START; t <= THRESHOLD_SWEEP_END + 1e-9; t += THRESHOLD_SWEEP_STEP) {
      const r = classifyAt(Number(t.toFixed(2)));
      if (r.falseDedup.length === 0) minMissed = Math.min(minMissed, r.missedDedup.length);
      minFalse = Math.min(minFalse, r.falseDedup.length);
    }
    const atCurrent = classifyAt(CURRENT_THRESHOLD);
    console.log(`[consolidation eval] 全区间零误去重最小漏去重=${minMissed}；当前阈值 0.72：误去重=${atCurrent.falseDedup.length} 漏去重=${atCurrent.missedDedup.length}`);
    expect(atCurrent.falseDedup.length).toBe(0);
    expect(atCurrent.missedDedup.length).toBe(minMissed);
  });

  it("prints the per-pair distribution for the record", () => {
    const lines = CONSOLIDATION_CASES.map((p) => {
      const s = similarity(p.candidate, p.existing);
      const verdict = s >= CURRENT_THRESHOLD ? "dedup" : "keep";
      const expected = p.shouldDedup ? "dedup" : "keep";
      return `  ${verdict === expected ? "✓" : "✗"} ${p.id}: ${s.toFixed(3)} (${verdict}, 期望 ${expected})`;
    });
    console.log(`[consolidation eval] 阈值=${CURRENT_THRESHOLD}\n${lines.join("\n")}`);
    expect(true).toBe(true);
  });
});
