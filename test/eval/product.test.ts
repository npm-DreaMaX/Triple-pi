import * as fs from "node:fs/promises";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { evaluateProductVisibility, PRODUCT_TASKS } from "../../eval/product.ts";
import { runExtraction } from "../../extensions/memory/extraction/coordinator.ts";
import { registerMemoryExtension } from "../../extensions/memory/index.ts";
import { FilesystemMemoryRepository } from "../../extensions/memory/repository.ts";

const provider = vi.hoisted(() => ({ extractCandidateJson: vi.fn() }));
const reviewer = vi.hoisted(() => ({ reviewCandidates: vi.fn() }));
vi.mock("../../extensions/memory/extraction/provider.ts", () => provider);
vi.mock("../../extensions/memory/extraction/review.ts", () => reviewer);

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(`${os.tmpdir()}/triple-pi-product-`);
  provider.extractCandidateJson.mockReset();
  reviewer.reviewCandidates.mockReset();
  reviewer.reviewCandidates.mockImplementation(async ({ candidates }: any) => candidates);
});
afterEach(async () => fs.rm(root, { recursive: true, force: true }));

function branch(user: string, assistant = "Acknowledged"): SessionEntry[] {
  return [
    { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: user, timestamp: 0 } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: assistant }], timestamp: 1, api: "openai-completions", provider: "recorded", model: "recorded", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" } },
  ] as SessionEntry[];
}

function candidate(user: string, overrides: Record<string, unknown> = {}) {
  return {
    category: "rule", scope: "project", title: "Product rule", content: user,
    evidence: user, sourceEntryId: "u1", ...overrides,
  };
}

async function asyncExtract(repository: FilesystemMemoryRepository, cwd: string, user: string, output: unknown) {
  provider.extractCandidateJson.mockResolvedValueOnce(JSON.stringify([output]));
  return runExtraction(repository, {
    cwd, sessionId: `async-${cwd}`, branch: branch(user), branchLeafId: "a1",
    model: { provider: "recorded" } as any, modelRegistry: {} as any,
  }, new AbortController().signal);
}

describe("product memory comparison", () => {
  it("memory off injects nothing", () => {
    expect(evaluateProductVisibility("off", { ...PRODUCT_TASKS[0], expectedVisible: [] }, "")).toMatchObject({ passed: true, visible: [] });
  });

  it("manual mode uses confirmed SaveMemory and next-session hook", async () => {
    const task = PRODUCT_TASKS[0];
    const repository = new FilesystemMemoryRepository({ root });
    const tools = new Map<string, any>();
    const handlers = new Map<string, any>();
    registerMemoryExtension({
      registerTool(tool: any) { tools.set(tool.name, tool); },
      on(event: string, handler: any) { handlers.set(event, handler); },
      registerCommand() {}, appendEntry() {},
    } as unknown as ExtensionAPI, repository);
    const context = {
      cwd: task.setup.project, hasUI: true,
      ui: { confirm: vi.fn().mockResolvedValue(true), notify: vi.fn() },
      sessionManager: { getSessionId: () => "manual-session", getBranch: () => [], getLeafId: () => null },
    };
    const saved = await tools.get("SaveMemory").execute("call", {
      category: "rule", scope: "project", title: "Checkout rule", content: task.setup.rule,
    }, undefined, undefined, context);
    expect(saved.details.saved).toBe(true);
    const injected = await handlers.get("before_agent_start")({ systemPrompt: "Base" }, context);
    const full = `${injected.systemPrompt}\n${(await repository.search("checkout", task.queryProject))[0].record.content}`;
    expect(evaluateProductVisibility("manual", task, full)).toMatchObject({ passed: true });
  });

  it("async pipeline preserves project isolation", async () => {
    const task = PRODUCT_TASKS[1];
    const repository = new FilesystemMemoryRepository({ root });
    await asyncExtract(repository, task.setup.project, task.setup.rule, candidate(task.setup.rule));
    expect(evaluateProductVisibility("async", task, (await repository.buildPrompt(task.queryProject)).prompt)).toMatchObject({ passed: true });
  });

  it("async grounded correction replaces the old product view", async () => {
    const task = PRODUCT_TASKS[2];
    const repository = new FilesystemMemoryRepository({ root });
    await asyncExtract(repository, task.setup.project, task.setup.rule, candidate(task.setup.rule, {
      category: "decision", title: "API protocol",
    }));
    provider.extractCandidateJson.mockResolvedValueOnce(JSON.stringify([candidate(task.setup.correctedRule!, {
      category: "decision", title: "API protocol", evidence: task.setup.correctedRule!, content: task.setup.correctedRule!,
    })]));
    await runExtraction(repository, {
      cwd: task.setup.project, sessionId: "async-correction",
      branch: branch(task.setup.correctedRule!), branchLeafId: "a1",
      model: { provider: "recorded" } as any, modelRegistry: {} as any,
    }, new AbortController().signal);
    const records = await repository.list(task.queryProject);
    expect(evaluateProductVisibility("async", task, records.map((record) => record.content).join("\n"))).toMatchObject({ passed: true });
  });
});
