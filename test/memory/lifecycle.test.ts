import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilesystemMemoryRepository } from "../../extensions/memory/repository.ts";

let tempDir: string;
let now: Date;
let repository: FilesystemMemoryRepository;
const cwd = path.join(path.sep, "workspace", "lifecycle-project");

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "triple-pi-lifecycle-"));
  now = new Date("2026-01-01T00:00:00.000Z");
  repository = new FilesystemMemoryRepository({ root: tempDir, now: () => now });
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function seed(): Promise<void> {
  await repository.save({
    category: "rule",
    scope: "project",
    cwd,
    title: "Lifecycle Rule",
    content: "Keep this memory recoverable.",
  });
}

function advanceDays(days: number): void {
  now = new Date(new Date("2026-01-01T00:00:00.000Z").getTime() + days * 86_400_000);
}

describe("project memory lifecycle", () => {
  it("uses exact 30/31 and 90/91 day boundaries", async () => {
    await seed();
    advanceDays(30);
    expect((await repository.getProjectLifecycle(cwd)).state).toBe("hot");
    now = new Date(now.getTime() + 1);
    expect((await repository.getProjectLifecycle(cwd)).state).toBe("cold");
    advanceDays(31);
    expect((await repository.getProjectLifecycle(cwd)).state).toBe("cold");
    advanceDays(90);
    expect((await repository.getProjectLifecycle(cwd)).state).toBe("cold");
    now = new Date(now.getTime() + 1);
    expect((await repository.getProjectLifecycle(cwd)).state).toBe("archive-due");
    advanceDays(91);
    expect((await repository.getProjectLifecycle(cwd)).state).toBe("archive-due");
  });

  it("refreshes real session activity", async () => {
    await seed();
    advanceDays(31);
    expect((await repository.getProjectLifecycle(cwd)).state).toBe("cold");

    await repository.markProjectActive(cwd);
    expect(await repository.getProjectLifecycle(cwd)).toMatchObject({ state: "hot", inactivityDays: 0 });
  });

  it("archives without deleting and excludes archived entries by default", async () => {
    await seed();
    advanceDays(91);
    const archived = await repository.archiveProject(cwd);

    expect(archived).toMatchObject({ status: "archived" });
    expect((await repository.getProjectLifecycle(cwd)).state).toBe("archived");
    expect(await repository.search("recoverable", cwd)).toEqual([]);
    const explicit = await repository.search("recoverable", cwd, { includeArchived: true });
    expect(explicit).toHaveLength(1);
    expect(explicit[0]).toMatchObject({ archived: true });
  });

  it("restores archived files and makes them hot again", async () => {
    await seed();
    advanceDays(91);
    await repository.archiveProject(cwd);
    advanceDays(100);
    const restored = await repository.restoreProject(cwd);

    expect(restored).toMatchObject({ status: "active", archivedAt: undefined });
    expect((await repository.getProjectLifecycle(cwd)).state).toBe("hot");
    expect(await repository.search("recoverable", cwd)).toHaveLength(1);
  });

  it("blocks project writes while archived but still permits global writes", async () => {
    await seed();
    advanceDays(91);
    await repository.archiveProject(cwd);

    await expect(repository.save({
      category: "fact",
      scope: "project",
      cwd,
      title: "Blocked",
      content: "Must restore first.",
    })).rejects.toThrow("archived");
    await expect(repository.save({
      category: "preference",
      scope: "global",
      cwd,
      title: "Global remains writable",
      content: "Global state is independent.",
    })).resolves.toMatchObject({ scope: "global" });
  });
});
