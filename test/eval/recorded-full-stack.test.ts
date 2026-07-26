import * as fs from "node:fs/promises";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { EVAL_CASES } from "../../eval/cases.ts";
import { evaluateRecords } from "../../eval/metrics.ts";
import { recordedOutput } from "../../eval/recorded-cases.ts";
import { runExtraction } from "../../extensions/memory/extraction/coordinator.ts";
import { FilesystemMemoryRepository } from "../../extensions/memory/repository.ts";

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(`${os.tmpdir()}/triple-pi-recorded-full-`); });
afterEach(async () => fs.rm(root, { recursive: true, force: true }));

function response(text: string) {
  return {
    stopReason: "stop",
    content: [{ type: "text", text }],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

function recordedRegistry(outputs: string[]) {
  const calls: { systemPrompt?: string; userText: string }[] = [];
  const provider = {
    streamSimple: vi.fn((_model: unknown, context: any) => {
      const user = context.messages.at(-1);
      const userText = typeof user.content === "string" ? user.content : user.content[0]?.text || "";
      calls.push({ systemPrompt: context.systemPrompt, userText });
      const output = outputs.shift();
      if (output === undefined) throw new Error("Recorded provider exhausted");
      return { result: async () => response(output) };
    }),
  };
  return {
    calls,
    registry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "recorded" }),
      getProviderAuth: async () => undefined,
      getProvider: () => provider,
    } as any,
  };
}

function branch(user: string, assistant: string): SessionEntry[] {
  return [
    { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: user, timestamp: 0 } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: assistant }], timestamp: 1, api: "openai-completions", provider: "recorded", model: "recorded", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" } },
  ] as SessionEntry[];
}

describe("recorded provider full-stack eval", () => {
  for (const testCase of EVAL_CASES) {
    it(testCase.id, async () => {
      const recording = recordedOutput(testCase);
      const outputs = [JSON.stringify(recording.extraction)];
      if (recording.extraction.length > 0) outputs.push(JSON.stringify(recording.review));
      const { registry, calls } = recordedRegistry(outputs);
      const repository = new FilesystemMemoryRepository({ root });

      await runExtraction(repository, {
        cwd: testCase.cwd,
        sessionId: `full-${testCase.id}`,
        branch: branch(testCase.user, testCase.assistant),
        branchLeafId: "a1",
        model: { provider: "recorded", id: "recorded-model", baseUrl: "recorded://local" } as any,
        modelRegistry: registry,
      }, new AbortController().signal);

      const records = await repository.list(testCase.cwd);
      const metrics = evaluateRecords(testCase, records);
      expect(metrics.failures).toEqual([]);
      expect(calls[0].systemPrompt).toContain("extract durable coding-agent memories");
      expect(calls).toHaveLength(recording.extraction.length > 0 ? 2 : 1);
      if (calls[1]) {
        expect(calls[1].systemPrompt).toContain("Review extracted coding-agent memories");
        // Reviewer receives JSON with userMessages and candidates;
        // the user message content is serialized inside so check a
        // representative substring rather than the full multiline text.
        const firstLine = testCase.user.split("\n")[0].slice(0, 40);
        expect(calls[1].userText).toContain(firstLine);
      }
    });
  }
});
