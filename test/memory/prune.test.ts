import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilesystemMemoryRepository } from "../../extensions/memory/repository.ts";
import { resolveProjectIdentity } from "../../extensions/memory/project-identity.ts";
import { parseWorkingLatestIndex, type WorkingStateUpdate } from "../../extensions/memory/working-state.ts";

// 2a P4 回归：pruneProject 四类保留 + 速率限制 + 索引重建 + archive 全扫。

let root: string;
let repository: FilesystemMemoryRepository;
const cwd = path.join(path.sep, "workspace", "prune-project");
const NOW = new Date("2026-01-05T00:00:00.000Z");

const hex64 = (tag: string): string => createHash("sha256").update(tag).digest("hex");
const DAY = 86_400_000;
const daysAgoIso = (n: number): string => new Date(NOW.getTime() - n * DAY).toISOString();

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

const pid = () => resolveProjectIdentity(cwd).id;
const manifestsDir = () => path.join(root, "working-manifests", pid());

async function seedManifest(tag: string, iso: string): Promise<void> {
  await fs.mkdir(manifestsDir(), { recursive: true });
  await fs.writeFile(
    path.join(manifestsDir(), `${hex64(tag)}.json`),
    `${JSON.stringify(makeUpdate(tag, iso), null, 2)}\n`,
  );
}

async function manifestCount(): Promise<number> {
  try {
    const entries = await fs.readdir(manifestsDir());
    return entries.filter((n) => n.endsWith(".json") && n !== "latest-index.json").length;
  } catch {
    return 0;
  }
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "triple-pi-prune-"));
  repository = new FilesystemMemoryRepository({ root, now: () => NOW });
});
afterEach(async () => fs.rm(root, { recursive: true, force: true }));

describe("pruneProject (2a P4)", () => {
  it("bounds all four categories after a 100-day simulation (fullSweep)", async () => {
    // 类1：50 个 200 天前的 working manifest + 3 个 5 天前的 → 存活 3。
    for (let i = 0; i < 50; i += 1) await seedManifest(`old${i}`, daysAgoIso(200));
    await seedManifest("recent-1", daysAgoIso(5));
    await seedManifest("recent-2", daysAgoIso(5));
    await seedManifest("recent-3", daysAgoIso(5));

    // 类2：daily 文件（181 天前删、179 天前留）。
    const dailyDir = path.join(root, "projects", pid(), "daily");
    await fs.mkdir(dailyDir, { recursive: true });
    await fs.writeFile(path.join(dailyDir, `${daysAgoIso(181).slice(0, 10)}.md`), "# old\n");
    await fs.writeFile(path.join(dailyDir, `${daysAgoIso(179).slice(0, 10)}.md`), "# recent\n");

    // 类3：revisions——15 次 save 同 title 产生 15 个快照 → 留 10。
    for (let i = 0; i < 15; i += 1) {
      await repository.save({
        category: "fact",
        scope: "project",
        cwd,
        title: "Revision record",
        content: `version ${i}`,
      });
    }

    // 类4：extractions——50 个 200 天前 mtime + 3 个 5 天前 → 存活 3。
    const extractionDir = path.join(root, "extractions", pid());
    await fs.mkdir(extractionDir, { recursive: true });
    for (let i = 0; i < 50; i += 1) {
      const f = path.join(extractionDir, `${hex64(`xold${i}`)}.json`);
      await fs.writeFile(f, "{}");
      await fs.utimes(f, new Date(NOW.getTime() - 200 * DAY), new Date(NOW.getTime() - 200 * DAY));
    }
    for (let i = 0; i < 3; i += 1) {
      const f = path.join(extractionDir, `${hex64(`xnew${i}`)}.json`);
      await fs.writeFile(f, "{}");
      await fs.utimes(f, new Date(NOW.getTime() - 5 * DAY), new Date(NOW.getTime() - 5 * DAY));
    }

    const result = await repository.pruneProject(cwd, { fullSweep: true });
    expect(result.pruned).toBeGreaterThan(0);

    // 存活断言。
    expect(await manifestCount()).toBe(3);
    const survivingDaily = await fs.readdir(dailyDir);
    expect(survivingDaily).toHaveLength(1);
    expect(survivingDaily[0]).toBe(`${daysAgoIso(179).slice(0, 10)}.md`);
    const revisionsDir = path.join(root, "projects", pid(), "revisions");
    let revisionCount = 0;
    for (const rec of await fs.readdir(revisionsDir, { withFileTypes: true })) {
      if (!rec.isDirectory()) continue;
      revisionCount += (await fs.readdir(path.join(revisionsDir, rec.name))).length;
    }
    expect(revisionCount).toBeLessThanOrEqual(10);
    const survivingExtractions = (await fs.readdir(extractionDir)).length;
    expect(survivingExtractions).toBe(3);

    // 索引从幸存集重建：manifestCount=3，且不含被删 sourceHash。
    const index = parseWorkingLatestIndex(
      JSON.parse(await fs.readFile(path.join(manifestsDir(), "latest-index.json"), "utf8")),
    );
    expect(index.manifestCount).toBe(3);
    expect(index.sameDayEntries.some((e) => e.sourceHash === hex64("old0"))).toBe(false);
  });

  it("rate-limits non-fullSweep prunes to PRUNE_MAX_FILES per call", async () => {
    for (let i = 0; i < 250; i += 1) await seedManifest(`old${i}`, daysAgoIso(200));
    const first = await repository.pruneProject(cwd);
    expect(first.pruned).toBe(100);
    expect(await manifestCount()).toBe(150);
    const second = await repository.pruneProject(cwd);
    expect(second.pruned).toBe(100);
    expect(await manifestCount()).toBe(50);
    const third = await repository.pruneProject(cwd);
    expect(third.pruned).toBe(50);
    expect(await manifestCount()).toBe(0);
  });

  it("rebuilds the index when the pruned set included the indexed latestUpdate", async () => {
    // 旧 manifest + 一次真实 save（索引 latestUpdate=save 的 update，manifestCount=51）。
    for (let i = 0; i < 50; i += 1) await seedManifest(`old${i}`, daysAgoIso(200));
    await repository.saveWorkingState(cwd, makeUpdate("current", daysAgoIso(1)));
    expect((await manifestCount())).toBe(51);

    await repository.pruneProject(cwd, { fullSweep: true });
    expect(await manifestCount()).toBe(1);
    const index = parseWorkingLatestIndex(
      JSON.parse(await fs.readFile(path.join(manifestsDir(), "latest-index.json"), "utf8")),
    );
    expect(index.manifestCount).toBe(1);
    expect(index.latestUpdate.sourceHash).toBe(hex64("current"));
  });

  it("archiveProject full-sweeps orphaned working-manifests and extractions", async () => {
    await repository.save({ category: "rule", scope: "project", cwd, title: "Keep", content: "body" });
    for (let i = 0; i < 40; i += 1) await seedManifest(`old${i}`, daysAgoIso(200));
    await seedManifest("recent", daysAgoIso(1));
    const extractionDir = path.join(root, "extractions", pid());
    await fs.mkdir(extractionDir, { recursive: true });
    const f = path.join(extractionDir, `${hex64("xold")}.json`);
    await fs.writeFile(f, "{}");
    await fs.utimes(f, new Date(NOW.getTime() - 200 * DAY), new Date(NOW.getTime() - 200 * DAY));

    await repository.archiveProject(cwd);

    // working-manifests 不在 basePath 内，rename 不移动它——必须被全扫 prune。
    expect(await manifestCount()).toBe(1); // 只剩 recent
    expect(await fs.readdir(extractionDir)).toHaveLength(0);
    // 归档目录本身仍存在。
    expect(await fs.stat(path.join(root, "archive", "projects", pid()))).toBeTruthy();
  });

  it("is a no-op on a fresh project (no index churn)", async () => {
    const result = await repository.pruneProject(cwd);
    expect(result).toEqual({ pruned: 0, rebuiltIndex: false });
    await expect(
      fs.stat(path.join(manifestsDir(), "latest-index.json")),
    ).rejects.toThrow();
  });
});
