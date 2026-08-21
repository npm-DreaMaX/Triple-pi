import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => {
  const loaderOptions: any[] = [];
  const session = {
    prompt: vi.fn(),
    abort: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    getLastAssistantText: vi.fn(),
    agent: { state: { messages: [] as any[] } },
  };
  return {
    loaderOptions,
    session,
    createAgentSession: vi.fn().mockResolvedValue({ session }),
    DefaultResourceLoader: class {
      constructor(options: any) { loaderOptions.push(options); }
      reload = vi.fn().mockResolvedValue(undefined);
    },
    SessionManager: { inMemory: vi.fn(() => ({})) },
  };
});

vi.mock("@earendil-works/pi-coding-agent", () => sdk);

import { REVIEWER_TOOLS, SubAgentManager } from "../../extensions/subagent/manager.ts";

beforeEach(() => {
  sdk.loaderOptions.length = 0;
  sdk.createAgentSession.mockClear();
  sdk.session.prompt.mockReset().mockResolvedValue(undefined);
  sdk.session.abort.mockClear();
  sdk.session.dispose.mockClear();
  sdk.session.getLastAssistantText.mockReset().mockReturnValue(JSON.stringify({
    status: "passed",
    summary: "OK",
    findings: [],
  }));
  sdk.session.agent.state.messages = [];
});

describe("SubAgentManager runtime wiring", () => {
  it("passes the reviewer system prompt to the loader and uses the exported tools", async () => {
    const manager = new SubAgentManager();
    const result = await manager.review({
      task: "review",
      userMessage: "input",
      systemPrompt: "REVIEWER POLICY",
      cwd: process.cwd(),
      model: {} as any,
      modelRegistry: { find: () => undefined },
      timeoutMs: 1_000,
      chunkCount: 1,
    });

    expect(result.kind).toBe("success");
    expect(sdk.loaderOptions[0].systemPrompt).toBe("REVIEWER POLICY");
    expect(sdk.createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      tools: [...REVIEWER_TOOLS],
    }));
    // S3：成功路径 per-manager 遥测 parsedChunks 应为 1（此前硬编码 0，与
    // "一次 manager 调用完整审查一个 chunk" 的注释相悖）。
    if (result.kind === "success") {
      expect(result.result.telemetry?.parsedChunks).toBe(1);
      expect(result.result.telemetry?.failedChunks).toBe(0);
    }
  });

  it("counts every tool_use block, not assistant messages containing tools", async () => {
    sdk.session.agent.state.messages = [{
      role: "assistant",
      content: [
        { type: "tool_use", id: "one" },
        { type: "text", text: "working" },
        { type: "tool_use", id: "two" },
      ],
    }];

    const result = await new SubAgentManager().review({
      task: "review",
      userMessage: "input",
      systemPrompt: "policy",
      cwd: process.cwd(),
      model: {} as any,
      modelRegistry: { find: () => undefined },
      timeoutMs: 1_000,
      chunkCount: 1,
    });

    expect(result.kind).toBe("success");
    if (result.kind === "success") expect(result.result.toolCalls).toBe(2);
  });

  it("preserves parse versus schema failures and their execution metrics", async () => {
    sdk.session.getLastAssistantText.mockReturnValue(JSON.stringify({
      status: "passed",
      summary: "invalid because findings exist",
      findings: [{ severity: "high", description: "bug" }],
    }));
    sdk.session.agent.state.messages = [{
      role: "assistant",
      content: [{ type: "tool_use", id: "one" }],
    }];

    const result = await new SubAgentManager().review({
      task: "review",
      userMessage: "input",
      systemPrompt: "policy",
      cwd: process.cwd(),
      model: {} as any,
      modelRegistry: { find: () => undefined },
      timeoutMs: 1_000,
      chunkCount: 1,
    });

    expect(result).toMatchObject({ kind: "schema-failed", toolCalls: 1 });
    expect("durationMs" in result && result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
