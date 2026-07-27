import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMemoryExtension } from "../../extensions/memory/index.ts";
import { FilesystemMemoryRepository } from "../../extensions/memory/repository.ts";
import { buildWorkingStateUpdate } from "../../extensions/memory/working-state.ts";

interface RegisteredTool {
  name: string;
  execute: (...args: any[]) => Promise<any>;
}

type BeforeAgentStart = (event: any, context: any) => Promise<any>;

let tempDir: string;
let repository: FilesystemMemoryRepository;
let tools: Map<string, RegisteredTool>;
let beforeAgentStart: BeforeAgentStart;
const projectA = path.join(path.sep, "workspace", "project-a");
const projectB = path.join(path.sep, "workspace", "project-b");

function createContext(cwd: string, options: { hasUI?: boolean; confirmed?: boolean } = {}) {
  return {
    cwd,
    hasUI: options.hasUI ?? true,
    ui: {
      confirm: vi.fn().mockResolvedValue(options.confirmed ?? true),
    },
    sessionManager: {
      getSessionId: () => "session-1",
    },
  };
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "triple-pi-extension-"));
  repository = new FilesystemMemoryRepository({ root: tempDir });
  tools = new Map();
  const handlers = new Map<string, (...args: any[]) => any>();
  const pi = {
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: (...args: any[]) => any) {
      handlers.set(event, handler);
    },
    registerCommand() {},
    appendEntry() {},
  } as unknown as ExtensionAPI;

  registerMemoryExtension(pi, repository);
  beforeAgentStart = handlers.get("before_agent_start") as BeforeAgentStart;
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function callTool(name: string, params: Record<string, unknown>, context: any) {
  return tools.get(name)!.execute("tool-call", params, undefined, undefined, context);
}

describe("memory extension", () => {
  it("requires confirmation and injects a confirmed memory into the next session", async () => {
    const context = createContext(projectA);
    const saved = await callTool("SaveMemory", {
      category: "rule",
      title: "Testing Rule",
      content: "Always run unit tests before completion.",
      scope: "project",
    }, context);

    expect(context.ui.confirm).toHaveBeenCalledOnce();
    expect(saved.details.saved).toBe(true);

    const nextSession = createContext(projectA);
    const result = await beforeAgentStart({ systemPrompt: "Base prompt" }, nextSession);
    expect(result.systemPrompt).toContain("Base prompt");
    expect(result.systemPrompt).toContain("Testing Rule");
  });

  it("does not inject project A memory into project B", async () => {
    await repository.save({
      category: "rule",
      scope: "project",
      cwd: projectA,
      title: "A-only Rule",
      content: "Private to A.",
    });

    const result = await beforeAgentStart({ systemPrompt: "Base" }, createContext(projectB));
    // Project B should not see project A's memory
    if (result?.systemPrompt) {
      expect(result.systemPrompt).not.toContain("A-only Rule");
    }
  });

  it("does not write when the user declines", async () => {
    const context = createContext(projectA, { confirmed: false });
    const result = await callTool("SaveMemory", {
      category: "fact",
      title: "Declined",
      content: "Must not be written.",
    }, context);

    expect(result.details).toMatchObject({ saved: false, reason: "user-declined" });
    expect(await repository.list(projectA)).toEqual([]);
  });

  it("fails closed when confirmation UI is unavailable", async () => {
    const context = createContext(projectA, { hasUI: false });
    const result = await callTool("SaveMemory", {
      category: "fact",
      title: "Headless",
      content: "Must not be written.",
    }, context);

    expect(result.details).toMatchObject({ saved: false, reason: "confirmation-unavailable" });
    expect(context.ui.confirm).not.toHaveBeenCalled();
    expect(await repository.list(projectA)).toEqual([]);
  });

  it("rejects invalid categories and empty searches", async () => {
    const context = createContext(projectA);
    const invalid = await callTool("SaveMemory", {
      category: "../../escape",
      title: "Bad",
      content: "Bad",
    }, context);
    const emptySearch = await callTool("SearchMemory", { keyword: "   " }, context);

    expect(invalid.details.reason).toBe("invalid-category");
    expect(emptySearch.details.count).toBe(0);
    expect(context.ui.confirm).not.toHaveBeenCalled();
  });

  it("injects bounded working state separately from long-term memory", async () => {
    const source = {
      messages: [
        { entryId: "u1", role: "user" as const, content: "Continue checkout work.", timestamp: "2026-01-01" },
        { entryId: "a1", role: "assistant" as const, content: "Tests are now passing.", timestamp: "2026-01-01" },
      ],
      sourceEntryIds: ["u1", "a1"], sourceHash: "working", lastEntryId: "a1", branchLeafId: "a1",
    };
    await repository.saveWorkingState(projectA, buildWorkingStateUpdate(source, "session-working", new Date())!);
    await repository.markProjectActive(projectA);

    const result = await beforeAgentStart({ systemPrompt: "Base" }, createContext(projectA));
    // Working State is now injected as custom messages, not system prompt
    const workingMsg = result?.messages?.find((m: any) => m?.customType === "triple-pi-working-context");
    expect(workingMsg).toBeDefined();
    const content = workingMsg?.data?.content || "";
    expect(content).toContain("Continue checkout work.");
  });

  it("searches current project and global memory content", async () => {
    await repository.save({
      category: "preference",
      scope: "global",
      cwd: projectA,
      title: "Response Style",
      content: "Prefer concise answers.",
    });
    const result = await callTool("SearchMemory", { keyword: "concise" }, createContext(projectB));

    expect(result.details.count).toBe(1);
    expect(result.content[0].text).toContain("Prefer concise answers.");
  });
});
