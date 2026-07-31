import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ReviewResultUnion, SubagentResult } from "../../extensions/subagent/types.ts";
import { createGitFixture, type GitFixture } from "../helpers/git-fixture.ts";

const managerMock = vi.hoisted(() => ({
  results: [] as ReviewResultUnion[],
  options: [] as any[],
  review: vi.fn(async (options: any) => {
    managerMock.options.push(options);
    return managerMock.results.shift()!;
  }),
  dispose: vi.fn(),
}));

vi.mock("../../extensions/subagent/manager.ts", () => ({
  SubAgentManager: class {
    review = managerMock.review;
    dispose = managerMock.dispose;
  },
}));

import { registerSubagentExtension } from "../../extensions/subagent/index.ts";

const fixtures: GitFixture[] = [];

afterEach(async () => {
  managerMock.results.length = 0;
  managerMock.options.length = 0;
  managerMock.review.mockClear();
  managerMock.dispose.mockClear();
  await Promise.all(fixtures.splice(0).map((entry) => entry.cleanup()));
});

async function setup(files: Record<string, string>) {
  const repo = await createGitFixture();
  fixtures.push(repo);
  for (const [name, content] of Object.entries(files)) await repo.write(name, content);

  const tools = new Map<string, any>();
  const pi = {
    registerTool(tool: any) { tools.set(tool.name, tool); },
    on() {},
  } as unknown as ExtensionAPI;
  registerSubagentExtension(pi);
  const execute = tools.get("review_current_changes").execute;
  const context = {
    cwd: repo.cwd,
    model: { provider: "test", id: "reviewer" },
    modelRegistry: { find: () => undefined },
    signal: undefined,
  };
  return { execute: (signal?: AbortSignal) => execute("call", { task: "review" }, signal, undefined, context) };
}

function success(summary: string, durationMs: number, toolCalls: number): ReviewResultUnion {
  const result: SubagentResult = {
    taskId: "chunk",
    status: "success",
    summary,
    findings: [],
    changedFiles: [],
    durationMs,
    toolCalls,
    coverage: "complete",
  };
  return { kind: "success", result };
}

describe("review_current_changes aggregation", () => {
  it("never reports success or no issues when every chunk fails", async () => {
    const { execute } = await setup({ "large.ts": "x".repeat(25_000) });
    managerMock.results.push(
      { kind: "schema-failed", error: "bad schema", raw: "{}", durationMs: 11, toolCalls: 2 },
      { kind: "schema-failed", error: "bad schema", raw: "{}", durationMs: 12, toolCalls: 3 },
      { kind: "schema-failed", error: "bad schema", raw: "{}", durationMs: 13, toolCalls: 4 },
    );

    const response = await execute();
    expect(response.details).toMatchObject({ status: "failed", failureKind: "schema-failed" });
    expect(response.content[0].text).not.toContain("未发现问题");
  });

  it("marks partial output prominently and aggregates metrics serially", async () => {
    const { execute } = await setup({
      "a.ts": "a".repeat(8_000),
      "b.ts": "b".repeat(8_000),
    });
    managerMock.results.push(
      success("first chunk clean", 15, 2),
      { kind: "provider-failed", error: "offline", durationMs: 25, toolCalls: 3 },
    );

    const response = await execute();
    expect(response.details).toMatchObject({
      status: "success",
      coverage: "partial",
      durationMs: 40,
      toolCalls: 5,
      telemetry: {
        parsedChunks: 1,
        failedChunks: 1,
        failureKinds: ["provider-failed"],
      },
    });
    expect(response.content[0].text).toContain("审查不完整");
    expect(response.content[0].text).toContain("不能据此断言全部变更无问题");
    expect(managerMock.options[0].timeoutMs).toBeGreaterThanOrEqual(managerMock.options[1].timeoutMs);
  });

  it("includes skipped binary files in partial coverage", async () => {
    const { execute } = await setup({
      "reviewable.ts": "export const ok = true;\n",
      "binary.bin": "\0binary",
    });
    managerMock.results.push(success("clean text", 7, 1));

    const response = await execute();
    expect(response.details).toMatchObject({
      coverage: "partial",
      telemetry: { skippedFiles: 1 },
    });
    expect(response.content[0].text).toContain("审查不完整");
  });
});
