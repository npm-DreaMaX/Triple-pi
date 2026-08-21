import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilesystemMemoryRepository } from "../../extensions/memory/repository.ts";
import { resolveProjectIdentity } from "../../extensions/memory/project-identity.ts";
import { parseWorkingLatestIndex, type WorkingStateUpdate } from "../../extensions/memory/working-state.ts";

// 2a P3 回归：working-manifests/latest-index.json 的增量合并 + 全扫重建兜底。

let root: string;
let repository: FilesystemMemoryRepository;
const cwd = path.join(path.sep, "workspace", "index-project");

const hex64 = (tag: string): string => createHash("sha256").update(tag).digest("hex");

function makeUpdate(tag: string, iso: string): WorkingStateUpdate {
  return {
    version: 1,
    sourceHash: hex64(tag),
    lastEntryId: `entry-${tag}`,
    branchLeafId: null,
    sessionId: `session-${tag}`,
    updatedAt: iso,
    date: iso.slice(0, 10),
    userRequest: `请求 ${tag}`,
    assistantReportedOutcome: `结果 ${tag}`,
    sourceEntryIds: [`u-${tag}`],
  };
}

async function readIndex(projectId: string) {
  const raw = await fs.readFile(path.join(root, "working-manifests", projectId, "latest-index.json"), "utf8");
  return parseWorkingLatestIndex(JSON.parse(raw));
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "triple-pi-index-"));
  repository = new FilesystemMemoryRepository({ root, now: () => new Date("2026-01-05T00:00:00.000Z") });
});
afterEach(async () => fs.rm(root, { recursive: true, force: true }));

describe("working-manifest index (2a P3)", () => {
  const pid = () => resolveProjectIdentity(cwd).id;

  it("searches multi-day working state beyond the newest daily (3c M5)", async () => {
    await repository.saveWorkingState(cwd, makeUpdate("d1", "2025-12-30T10:00:00.000Z"));
    await repository.saveWorkingState(cwd, makeUpdate("d2", "2025-12-31T10:00:00.000Z"));
    await repository.saveWorkingState(cwd, makeUpdate("d3", "2026-01-01T10:00:00.000Z"));
    // "请求 d1" 只在 2025-12-30 的 daily 里；最新 daily 是 01-01、scratchpad 是 d3。
    // 无 M5 时 searchWorkingState 搜不到两天前的内容。
    const hits = await repository.searchWorkingState("请求 d1", cwd);
    expect(hits).toHaveLength(1);
    expect(hits[0].source).toBe("daily");
    expect(hits[0].content).toContain("请求 d1");
    // 审计 §3.3-M5：结果带日期标注。
    expect(hits[0].date).toBe("2025-12-30");
  });

  it("merges a new same-day sourceHash: sameDay grows, latestUpdate is max", async () => {
    await repository.saveWorkingState(cwd, makeUpdate("a", "2026-01-01T10:00:00.000Z"));
    await repository.saveWorkingState(cwd, makeUpdate("b", "2026-01-01T11:00:00.000Z"));
    const index = await readIndex(pid());
    expect(index.manifestCount).toBe(2);
    expect(index.sameDayEntries).toHaveLength(2);
    expect(index.latestUpdate.sourceHash).toBe(hex64("b"));
  });

  it("refreshes an existing sourceHash without appending (replace, not append)", async () => {
    const first = makeUpdate("a", "2026-01-01T10:00:00.000Z");
    const refresh = makeUpdate("a", "2026-01-01T12:00:00.000Z");
    await repository.saveWorkingState(cwd, first);
    await repository.saveWorkingState(cwd, refresh);
    const index = await readIndex(pid());
    expect(index.manifestCount).toBe(1);
    expect(index.sameDayEntries).toHaveLength(1);
    expect(index.latestUpdate.updatedAt).toBe("2026-01-01T12:00:00.000Z");
  });

  it("does not demote latestUpdate on an older same-sourceHash refresh", async () => {
    await repository.saveWorkingState(cwd, makeUpdate("a", "2026-01-01T12:00:00.000Z"));
    await repository.saveWorkingState(cwd, makeUpdate("a", "2026-01-01T09:00:00.000Z"));
    const index = await readIndex(pid());
    expect(index.latestUpdate.updatedAt).toBe("2026-01-01T12:00:00.000Z");
    expect(index.manifestCount).toBe(1);
  });

  it("does not demote latestUpdate on an older new-sourceHash arrival (out-of-order)", async () => {
    await repository.saveWorkingState(cwd, makeUpdate("a", "2026-01-01T12:00:00.000Z"));
    await repository.saveWorkingState(cwd, makeUpdate("b", "2026-01-01T09:00:00.000Z"));
    const index = await readIndex(pid());
    expect(index.latestUpdate.sourceHash).toBe(hex64("a"));
    expect(index.sameDayEntries).toHaveLength(2);
    expect(index.manifestCount).toBe(2);
  });

  it("resets the same-day window on date rollover", async () => {
    await repository.saveWorkingState(cwd, makeUpdate("a", "2026-01-01T10:00:00.000Z"));
    await repository.saveWorkingState(cwd, makeUpdate("b", "2026-01-02T10:00:00.000Z"));
    const index = await readIndex(pid());
    expect(index.date).toBe("2026-01-02");
    expect(index.sameDayEntries).toHaveLength(1);
    expect(index.sameDayEntries[0].sourceHash).toBe(hex64("b"));
    expect(index.latestUpdate.sourceHash).toBe(hex64("b"));
    expect(index.manifestCount).toBe(2);
  });

  it("rebuilds on missing index", async () => {
    await repository.saveWorkingState(cwd, makeUpdate("a", "2026-01-01T10:00:00.000Z"));
    await repository.saveWorkingState(cwd, makeUpdate("b", "2026-01-01T11:00:00.000Z"));
    await fs.rm(path.join(root, "working-manifests", pid(), "latest-index.json"));
    await repository.saveWorkingState(cwd, makeUpdate("c", "2026-01-01T12:00:00.000Z"));
    const index = await readIndex(pid());
    expect(index.manifestCount).toBe(3);
    expect(index.latestUpdate.sourceHash).toBe(hex64("c"));
  });

  it("rebuilds on corrupt index", async () => {
    await repository.saveWorkingState(cwd, makeUpdate("a", "2026-01-01T10:00:00.000Z"));
    await fs.writeFile(path.join(root, "working-manifests", pid(), "latest-index.json"), "{ not json");
    await repository.saveWorkingState(cwd, makeUpdate("b", "2026-01-01T11:00:00.000Z"));
    const index = await readIndex(pid());
    expect(index.manifestCount).toBe(2);
    expect(index.latestUpdate.sourceHash).toBe(hex64("b"));
  });

  it("rebuilds on schema-version mismatch", async () => {
    await repository.saveWorkingState(cwd, makeUpdate("a", "2026-01-01T10:00:00.000Z"));
    await fs.writeFile(
      path.join(root, "working-manifests", pid(), "latest-index.json"),
      JSON.stringify({ schemaVersion: 99 }),
    );
    await repository.saveWorkingState(cwd, makeUpdate("b", "2026-01-01T11:00:00.000Z"));
    const index = await readIndex(pid());
    expect(index.manifestCount).toBe(2);
  });

  it("keeps the daily projection identical to the legacy full-scan semantics", async () => {
    await repository.saveWorkingState(cwd, makeUpdate("a", "2026-01-01T08:00:00.000Z"));
    await repository.saveWorkingState(cwd, makeUpdate("b", "2026-01-01T10:00:00.000Z"));
    await repository.saveWorkingState(cwd, makeUpdate("c", "2026-01-01T09:00:00.000Z"));
    const daily = await fs.readFile(path.join(root, "projects", pid(), "daily", "2026-01-01.md"), "utf8");
    // 三条目都在，且按 updatedAt 升序（a 08:00 → c 09:00 → b 10:00）。
    expect(daily).toContain("session-a");
    expect(daily).toContain("session-b");
    expect(daily).toContain("session-c");
    expect(daily.indexOf("session-a")).toBeLessThan(daily.indexOf("session-c"));
    expect(daily.indexOf("session-c")).toBeLessThan(daily.indexOf("session-b"));
  });

  it("caps sameDayEntries at MAX_SAMEDAY_ENTRIES while keeping latestUpdate correct", async () => {
    // 默认 cap=500。直接写 501 条同日 manifest（免去 501 次加锁保存的开销），
    // 再单次 save 触发 rebuild+merge：sameDayEntries 必须 ≤500，latestUpdate 仍最新。
    const pidv = pid();
    const manifestsDir = path.join(root, "working-manifests", pidv);
    await fs.mkdir(manifestsDir, { recursive: true });
    for (let i = 0; i < 501; i += 1) {
      const hour = 8 + Math.floor(i / 60);
      const minute = (i % 60).toString().padStart(2, "0");
      const iso = `2026-01-01T${hour.toString().padStart(2, "0")}:${minute}:00.000Z`;
      await fs.writeFile(
        path.join(manifestsDir, `${hex64(`s${i}`)}.json`),
        `${JSON.stringify(makeUpdate(`s${i}`, iso), null, 2)}\n`,
      );
    }
    await repository.saveWorkingState(cwd, makeUpdate("newest", "2026-01-01T23:59:00.000Z"));
    const index = await readIndex(pid());
    expect(index.sameDayEntries.length).toBeLessThanOrEqual(500);
    expect(index.manifestCount).toBe(502);
    expect(index.latestUpdate.sourceHash).toBe(hex64("newest"));
  });

  it("does not read individual manifests on the steady-state save path (O(1) read regression)", async () => {
    // 免 spy 的功能性证明：旧的全扫路径每轮都读全部 manifest 取 max(updatedAt)。
    // 播种 2 条后，手改 A 的 manifest 文件塞入一个「phantom」更新（updatedAt 23:59）。
    // 再以 A 的 sourceHash 做一次刷新 save（isNew=false → 不新增 manifest 文件 →
    // 计数校验匹配 → 走 O(1) 索引路径，不触发 rebuild）：若路径仍在全扫，
    // latestUpdate 会变成 phantom；O(1) 路径不读 manifest 文件，phantom 永不进投影。
    const pidv = pid();
    await repository.saveWorkingState(cwd, makeUpdate("a", "2026-01-01T08:00:00.000Z"));
    await repository.saveWorkingState(cwd, makeUpdate("b", "2026-01-01T09:00:00.000Z"));

    const manifestA = path.join(root, "working-manifests", pidv, `${hex64("a")}.json`);
    await fs.writeFile(
      manifestA,
      `${JSON.stringify(makeUpdate("phantom", "2026-01-01T23:59:00.000Z"), null, 2)}\n`,
    );

    await repository.saveWorkingState(cwd, makeUpdate("a", "2026-01-01T10:30:00.000Z"));

    const view = await repository.loadWorkingState(cwd);
    expect(view.scratchpad).not.toContain("phantom");
    expect(view.scratchpad).toContain("session-a");
    const daily = await fs.readFile(path.join(root, "projects", pidv, "daily", "2026-01-01.md"), "utf8");
    expect(daily).not.toContain("phantom");
    // 索引 latestUpdate 仍是真实 max(a-refresh)（若全扫会指向 phantom）。
    const index = await readIndex(pid());
    expect(index.latestUpdate.sourceHash).toBe(hex64("a"));
    expect(index.manifestCount).toBe(2);
  });
});
