import { afterEach, describe, expect, it } from "vitest";
import {
  buildReviewChunks,
  collectGitChanges,
  compareWorktreeSnapshots,
  snapshotWorktree,
} from "../../extensions/subagent/review-core.ts";
import type { ChangeFile } from "../../extensions/subagent/types.ts";
import { REVIEWER_TOOLS } from "../../extensions/subagent/manager.ts";
import { createGitFixture, type GitFixture } from "../helpers/git-fixture.ts";

const fixtures: GitFixture[] = [];

async function fixture(): Promise<GitFixture> {
  const created = await createGitFixture();
  fixtures.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((entry) => entry.cleanup()));
});

describe("collectGitChanges — real git repository", () => {
  it("keeps staged and unstaged deltas for the same file", async () => {
    const repo = await fixture();
    await repo.write("same file.ts", "one\n");
    repo.git(["add", "same file.ts"]);
    repo.git(["commit", "--quiet", "-m", "base"]);

    await repo.write("same file.ts", "one\nstaged\n");
    repo.git(["add", "same file.ts"]);
    await repo.write("same file.ts", "one\nstaged\nunstaged\n");

    const result = collectGitChanges(repo.cwd);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes.map(({ path, status }) => [path, status])).toEqual([
      ["same file.ts", "staged"],
      ["same file.ts", "unstaged"],
    ]);
    expect(result.changes[0].diff).toContain("+staged");
    expect(result.changes[1].diff).toContain("+unstaged");
  });

  it("handles special paths and keeps deleted text diffs reviewable", async () => {
    const repo = await fixture();
    const special = "odd -> name\tfile.ts";
    await repo.write(special, "export const value = 1;\n");
    repo.git(["add", special]);
    repo.git(["commit", "--quiet", "-m", "base"]);
    await repo.remove(special);

    const result = collectGitChanges(repo.cwd);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      path: special,
      status: "unstaged",
      unreadable: false,
      skipped: false,
    });
    expect(result.changes[0].diff).toContain("-export const value = 1;");
  });

  it("reports non-repositories instead of treating them as no changes", async () => {
    const dir = await createGitFixture({ initializeGit: false });
    fixtures.push(dir);
    const result = collectGitChanges(dir.cwd);
    expect(result).toMatchObject({ ok: false, kind: "not-a-git-repo" });
  });
});

describe("review chunk hard limits", () => {
  it("splits a single oversized hunk and long line without exceeding the cap", () => {
    const change: ChangeFile = {
      path: "huge.ts",
      status: "unstaged",
      diff: `diff --git a/huge.ts b/huge.ts\n@@ -1 +1 @@\n+${"x".repeat(25_000)}`,
      content: "x".repeat(25_000),
      binary: false,
      unreadable: false,
      skipped: false,
    };
    const result = buildReviewChunks([change], 1_000);
    expect(result.chunks.length).toBeGreaterThan(20);
    expect(Math.max(...result.chunks.map((chunk) => chunk.charCount))).toBeLessThanOrEqual(1_000);
    expect(result.chunks.every((chunk) => chunk.content.length === chunk.charCount)).toBe(true);
  });
});

describe("worktree snapshots", () => {
  it("supports special paths and detects untracked content changes", async () => {
    const repo = await fixture();
    await repo.write("special\tname -> x.txt", "before");
    const before = snapshotWorktree(repo.cwd);
    await repo.write("special\tname -> x.txt", "after");
    const after = snapshotWorktree(repo.cwd);
    expect(before.ok).toBe(true);
    expect(after.ok).toBe(true);
    expect(compareWorktreeSnapshots(before, after)).toBe(true);
  });

  it("fails closed when snapshots cannot be produced", () => {
    expect(compareWorktreeSnapshots(
      { ok: false, status: "", fileHashes: {}, error: "git failed" },
      { ok: true, status: "", fileHashes: {}, fingerprint: "x" },
    )).toBe(true);
  });
});

describe("reviewer tool export", () => {
  it("exports one immutable read-only allowlist", () => {
    expect(REVIEWER_TOOLS).toEqual(["read", "grep", "find", "ls"]);
    expect(REVIEWER_TOOLS).not.toContain("bash");
  });
});
