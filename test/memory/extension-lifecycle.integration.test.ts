import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMemoryExtension } from "../../extensions/memory/index.ts";
import { FilesystemMemoryRepository } from "../../extensions/memory/repository.ts";

let tempDir: string;
let now: Date;
let repository: FilesystemMemoryRepository;
let handlers: Map<string, (...args: any[]) => any>;
let commands: Map<string, { handler: (...args: any[]) => Promise<void> }>;
let tools: Map<string, { execute: (...args: any[]) => Promise<any> }>;
const cwd = path.join(path.sep, "workspace", "extension-lifecycle");

function context(options: { hasUI?: boolean; confirmed?: boolean } = {}) {
  return {
    cwd,
    hasUI: options.hasUI ?? true,
    ui: {
      confirm: vi.fn().mockResolvedValue(options.confirmed ?? true),
      notify: vi.fn(),
    },
    sessionManager: {
      getSessionId: () => "session-lifecycle",
      getBranch: () => [],
      getLeafId: () => null,
    },
  };
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "triple-pi-extension-lifecycle-"));
  now = new Date("2026-01-01T00:00:00.000Z");
  repository = new FilesystemMemoryRepository({ root: tempDir, now: () => now });
  handlers = new Map();
  commands = new Map();
  tools = new Map();
  const pi = {
    registerTool(tool: { name: string; execute: (...args: any[]) => Promise<any> }) { tools.set(tool.name, tool); },
    on(event: string, handler: (...args: any[]) => any) { handlers.set(event, handler); },
    registerCommand(name: string, options: { handler: (...args: any[]) => Promise<void> }) {
      commands.set(name, options);
    },
    appendEntry() {},
  } as unknown as ExtensionAPI;
  registerMemoryExtension(pi, repository);

  await repository.save({
    category: "rule",
    scope: "project",
    cwd,
    title: "Cold Rule",
    content: "Only inject after restore consent.",
  });
  await repository.save({
    category: "preference",
    scope: "global",
    cwd,
    title: "Global Rule",
    content: "Global memory remains visible.",
  });
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

function advanceDays(days: number): void {
  now = new Date(new Date("2026-01-01T00:00:00.000Z").getTime() + days * 86_400_000);
}

async function injectedPrompt(ctx: any): Promise<string> {
  const result = await handlers.get("before_agent_start")!({ systemPrompt: "Base" }, ctx);
  return result?.systemPrompt || "Base";
}

describe("memory extension lifecycle", () => {
  it("restores 31-day cold memory after user consent", async () => {
    advanceDays(31);
    const ctx = context({ confirmed: true });
    await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);

    expect(ctx.ui.confirm).toHaveBeenCalledWith("恢复项目热记忆？", expect.any(String));
    expect(await injectedPrompt(ctx)).toContain("Cold Rule");
    expect((await repository.getProjectLifecycle(cwd)).state).toBe("hot");
  });

  it("keeps project memory cold when user declines but still injects global", async () => {
    advanceDays(31);
    const ctx = context({ confirmed: false });
    await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
    const prompt = await injectedPrompt(ctx);

    expect(prompt).not.toContain("Cold Rule");
    expect(prompt).toContain("Global Rule");
    expect((await repository.getProjectLifecycle(cwd)).state).toBe("cold");
  });

  it("does not expose working search while project memory is cold", async () => {
    const source = {
      messages: [
        { entryId: "u1", role: "user" as const, content: "cold working secret", timestamp: "2026-01-01" },
        { entryId: "a1", role: "assistant" as const, content: "done", timestamp: "2026-01-01" },
      ], sourceEntryIds: ["u1", "a1"], sourceHash: "cold-working", lastEntryId: "a1", branchLeafId: "a1",
    };
    const { buildWorkingStateUpdate } = await import("../../extensions/memory/working-state.ts");
    await repository.saveWorkingState(cwd, buildWorkingStateUpdate(source, "session-working", new Date("2026-01-01"))!);
    advanceDays(31);
    const ctx = context({ confirmed: false });
    await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
    const result = await tools.get("SearchMemory")!.execute(
      "call", { keyword: "secret", scope: "working" }, undefined, undefined, ctx,
    );
    expect((await repository.getProjectLifecycle(cwd)).state).toBe("cold");
    expect(result.details.count).toBe(0);
  });

  it("fails closed without UI for cold memory", async () => {
    advanceDays(31);
    const ctx = context({ hasUI: false });
    await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);

    expect(ctx.ui.confirm).not.toHaveBeenCalled();
    expect(await injectedPrompt(ctx)).not.toContain("Cold Rule");
  });

  it("automatically archives after 90 days and only injects global", async () => {
    advanceDays(91);
    const ctx = context();
    await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
    const prompt = await injectedPrompt(ctx);

    expect((await repository.getProjectLifecycle(cwd)).state).toBe("archived");
    expect(prompt).not.toContain("Cold Rule");
    expect(prompt).toContain("Global Rule");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("无损归档"), "info");
  });

  it("restores declined cold memory through an explicit confirmed command", async () => {
    advanceDays(31);
    const declined = context({ confirmed: false });
    await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, declined);
    expect(await injectedPrompt(declined)).not.toContain("Cold Rule");

    const restore = context({ confirmed: true });
    await commands.get("memory-restore")!.handler("", restore);

    expect((await repository.getProjectLifecycle(cwd)).state).toBe("hot");
    expect(await injectedPrompt(restore)).toContain("Cold Rule");
  });

  it("refreshes activity on each active user turn", async () => {
    const ctx = context();
    await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
    advanceDays(29);
    await injectedPrompt(ctx);
    advanceDays(31);

    expect((await repository.getProjectLifecycle(cwd)).state).toBe("hot");
  });

  it("does not recreate an active project when tree changes while archived", async () => {
    advanceDays(91);
    await repository.archiveProject(cwd);
    const ctx = context();
    await handlers.get("session_tree")!({ type: "session_tree", newLeafId: null, oldLeafId: null }, ctx);
    await commands.get("memory-restore")!.handler("", ctx);
    expect((await repository.getProjectLifecycle(cwd)).state).toBe("hot");
  });

  it("restores an archive through an explicit confirmed command", async () => {
    advanceDays(91);
    await repository.archiveProject(cwd);
    const ctx = context({ confirmed: true });

    await commands.get("memory-restore")!.handler("", ctx);

    expect((await repository.getProjectLifecycle(cwd)).state).toBe("hot");
    expect(await injectedPrompt(ctx)).toContain("Cold Rule");
  });

  it("does not restore when command confirmation is declined", async () => {
    advanceDays(91);
    await repository.archiveProject(cwd);
    const ctx = context({ confirmed: false });

    await commands.get("memory-restore")!.handler("", ctx);

    expect((await repository.getProjectLifecycle(cwd)).state).toBe("archived");
  });
});
