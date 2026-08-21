import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilesystemMemoryRepository } from "../../extensions/memory/repository.ts";

// 2b P1 记录缓存回归。
// cache 把 listBase 的 O(N) 扫描变成命中即返，但引入两类陈旧风险：
//   (1) 同进程写后读：in-process 失效必须让 save/archive 立即对后续读可见。
//   (2) 跨进程写后读：.cache-stamp 写令牌必须让另一实例丢弃陈旧缓存。
// 这两类任一回归都会导致「写完了却读到旧记录」——严重正确性 bug。

let tempDir: string;
let now: Date;
const cwd = path.join(path.sep, "workspace", "cache-project");

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "triple-pi-cache-"));
  now = new Date("2026-01-01T00:00:00.000Z");
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

function makeRepo(): FilesystemMemoryRepository {
  return new FilesystemMemoryRepository({ root: tempDir, now: () => now });
}

describe("record cache (2b P1)", () => {
  it("returns the first saved record via search after cache warmup", async () => {
    const repo = makeRepo();
    // Warm the project/global caches with an empty state.
    expect((await repo.buildPrompt(cwd)).count).toBe(0);

    await repo.save({
      category: "rule",
      scope: "project",
      cwd,
      title: "Cache visibility rule",
      content: "Saved records must be immediately searchable.",
    });

    // 写后立即读：若 in-process 失效缺失，这里仍返回空（陈旧空缓存）。
    const hits = await repo.search("searchable", cwd);
    expect(hits).toHaveLength(1);
    expect(hits[0].record.title).toBe("Cache visibility rule");
  });

  it("sees an updated record (replace-by-title) without stale cache", async () => {
    const repo = makeRepo();
    await repo.save({
      category: "fact",
      scope: "project",
      cwd,
      title: "Same title",
      content: "first version body",
    });
    expect((await repo.search("first version", cwd))).toHaveLength(1);

    // 同 title 再次 save ⇒ recordId 相同 ⇒ 原地更新（save 的 previous 分支）。
    await repo.save({
      category: "fact",
      scope: "project",
      cwd,
      title: "Same title",
      content: "second version body",
    });

    expect(await repo.search("first version", cwd)).toHaveLength(0);
    expect(await repo.search("second version", cwd)).toHaveLength(1);
  });

  it("excludes archived records by default and surfaces them with includeArchived", async () => {
    const repo = makeRepo();
    await repo.save({
      category: "rule",
      scope: "project",
      cwd,
      title: "Archivable rule",
      content: "Will be archived after inactivity.",
    });
    // Warm cache with the active record present.
    expect(await repo.search("archived", cwd)).toHaveLength(1);

    // Force archive-due then archive (91+ days of inactivity).
    now = new Date(now.getTime() + 100 * 86_400_000);
    await repo.archiveProject(cwd);

    // 默认读应排除归档（cache 必须丢弃旧的 active 片）。
    expect(await repo.search("archived", cwd)).toEqual([]);
    const explicit = await repo.search("archived", cwd, { includeArchived: true });
    expect(explicit).toHaveLength(1);
    expect(explicit[0].archived).toBe(true);
  });

  it("makes restored records visible again to default search", async () => {
    const repo = makeRepo();
    await repo.save({
      category: "rule",
      scope: "project",
      cwd,
      title: "Restorable rule",
      content: "Comes back from archive.",
    });
    now = new Date(now.getTime() + 100 * 86_400_000);
    await repo.archiveProject(cwd);
    expect(await repo.search("restorable", cwd)).toEqual([]);

    await repo.restoreProject(cwd);
    // restore 把目录 rename 回 active：project 片 + archived 片都失效。
    expect(await repo.search("restorable", cwd)).toHaveLength(1);
  });

  it("propagates global-scope writes across the shared global slice", async () => {
    const repo = makeRepo();
    expect((await repo.buildPrompt(cwd)).count).toBe(0);

    await repo.save({
      category: "preference",
      scope: "global",
      cwd,
      title: "Global preference",
      content: "Applies to every project.",
    });

    // global 片对所有项目共享；一次 global 写后任何项目的读都应命中。
    const hits = await repo.search("every project", cwd);
    expect(hits).toHaveLength(1);
    expect(hits[0].record.scope).toBe("global");
  });

  // ── 跨进程（多实例同 root）陈旧回归 —— 这条是 .cache-stamp 设计的核心动机 ──
  it("drops a stale cached slice when another instance writes (cross-instance visibility)", async () => {
    const reader = makeRepo();
    const writer = makeRepo();

    // 读取器把空项目缓存起来。
    expect((await reader.search("cross-instance", cwd))).toEqual([]);
    // 再次读取以确认空结果确实进了缓存。
    expect((await reader.search("cross-instance", cwd))).toEqual([]);

    // 写入器（另一实例，同 root）写入一条记录并 bump .cache-stamp。
    await writer.save({
      category: "fact",
      scope: "project",
      cwd,
      title: "Cross-instance fact",
      content: "Written by a different repository instance.",
    });

    // 读取器的缓存片是陈旧的（stampAtLoad !== 当前 .cache-stamp）。
    // 若 .cache-stamp 校验缺失，这里会错误地返回空。
    const hits = await reader.search("cross-instance", cwd);
    expect(hits).toHaveLength(1);
    expect(hits[0].record.title).toBe("Cross-instance fact");
  });
});

describe("M6 category filter (3d)", () => {
  it("filters search results by category", async () => {
    const repo = makeRepo();
    await repo.save({ category: "rule", scope: "project", cwd, title: "Rule one", content: "部署必须可回滚。" });
    await repo.save({ category: "fact", scope: "project", cwd, title: "Fact one", content: "部署目录是 /opt/app。" });

    const all = await repo.search("部署", cwd, { max: 10, includeProject: true });
    expect(all).toHaveLength(2);
    const onlyRules = await repo.search("部署", cwd, { max: 10, includeProject: true, category: "rule" });
    expect(onlyRules).toHaveLength(1);
    expect(onlyRules[0].record.category).toBe("rule");
    // 审计 §3.3-M6：逗号分隔多值。
    const multi = await repo.search("部署", cwd, { max: 10, includeProject: true, category: "rule,fact" });
    expect(multi).toHaveLength(2);
    // 非法分类值 → 忽略（不抛错、不过滤）。
    const invalid = await repo.search("部署", cwd, { max: 10, includeProject: true, category: "bogus" });
    expect(invalid).toHaveLength(2);
  });
});
