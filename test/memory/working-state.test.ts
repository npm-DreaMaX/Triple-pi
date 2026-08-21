import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilesystemMemoryRepository } from "../../extensions/memory/repository.ts";
import { buildWorkingStateUpdate, renderScratchpad, SCRATCHPAD_MAX_CHARS } from "../../extensions/memory/working-state.ts";

let root: string;
let repository: FilesystemMemoryRepository;
const cwd = path.join(path.sep, "workspace", "working-project");
const source = {
  messages: [
    { entryId: "u1", role: "user" as const, content: "Fix the checkout race condition.", timestamp: "2026-01-01" },
    { entryId: "a1", role: "assistant" as const, content: "Added a lock and verified the tests.", timestamp: "2026-01-01" },
  ],
  sourceEntryIds: ["u1", "a1"], sourceHash: "source", lastEntryId: "a1", branchLeafId: "a1",
};

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "triple-pi-working-"));
  repository = new FilesystemMemoryRepository({ root });
});
afterEach(async () => fs.rm(root, { recursive: true, force: true }));

describe("working state", () => {
  it("builds bounded grounded scratchpad content", () => {
    const update = buildWorkingStateUpdate(source, "session-1", new Date("2026-01-02T03:04:05Z"))!;
    const rendered = renderScratchpad(update);
    expect(rendered).toContain("Fix the checkout race condition.");
    expect(rendered).toContain("Added a lock and verified the tests.");
    expect(rendered.length).toBeLessThanOrEqual(SCRATCHPAD_MAX_CHARS + 1);
  });

  it("redacts secrets before persistence", () => {
    const secret = { ...source, messages: [{ ...source.messages[0], content: "api_key=super-secret-token-value" }, source.messages[1]] };
    expect(buildWorkingStateUpdate(secret, "session-1", new Date())!.userRequest).toBe("[REDACTED_SECRET]");
    const quoted = { ...source, messages: [{ ...source.messages[0], content: 'PASSWORD="correct horse battery staple"' }, source.messages[1]] };
    expect(buildWorkingStateUpdate(quoted, "session-1", new Date())!.userRequest).toBe("[REDACTED_SECRET]");
  });

  it("writes scratchpad and rolls daily files by date", async () => {
    const first = buildWorkingStateUpdate(source, "session-1", new Date("2026-01-02T03:04:05Z"))!;
    const second = buildWorkingStateUpdate({ ...source, sourceHash: "source-2" }, "session-2", new Date("2026-01-03T03:04:05Z"))!;
    expect(await repository.saveWorkingState(cwd, first)).toBe(true);
    expect(await repository.saveWorkingState(cwd, second)).toBe(true);

    const view = await repository.loadWorkingState(cwd);
    expect(view.scratchpad).toContain("session-2");
    expect(view.recentDaily).toContain("2026-01-03");
    // 3c M5：scratchpad + 最新 daily + 一天前 daily（"checkout" 在 01-02 与 01-03 都出现）→ 3 条。
    expect(await repository.searchWorkingState("checkout", cwd)).toHaveLength(3);
  });

  it("does not let an older session replace the latest project pointer", async () => {
    const newer = buildWorkingStateUpdate(source, "new-session", new Date("2026-01-03T00:00:00Z"))!;
    const older = buildWorkingStateUpdate({ ...source, sourceHash: "older" }, "old-session", new Date("2026-01-02T00:00:00Z"))!;
    await repository.saveWorkingState(cwd, newer);
    await repository.saveWorkingState(cwd, older);
    expect((await repository.loadWorkingState(cwd)).scratchpad).toContain("new-session");
  });

  it("is idempotent for the same source", async () => {
    const update = buildWorkingStateUpdate(source, "session-1", new Date("2026-01-02T03:04:05Z"))!;
    expect(await repository.saveWorkingState(cwd, update)).toBe(true);
    expect(await repository.saveWorkingState(cwd, update)).toBe(false);
  });

  it("does not mix working files into long-term search", async () => {
    const update = buildWorkingStateUpdate(source, "session-1", new Date())!;
    await repository.saveWorkingState(cwd, update);
    expect(await repository.search("checkout", cwd)).toEqual([]);
    expect(await repository.searchWorkingState("checkout", cwd)).not.toEqual([]);
  });

  it("hides working state with the project lifecycle", async () => {
    const update = buildWorkingStateUpdate(source, "session-1", new Date())!;
    await repository.saveWorkingState(cwd, update);
    expect(await repository.loadWorkingState(cwd, false)).toMatchObject({ scratchpad: "", recentDaily: "" });
  });
});
