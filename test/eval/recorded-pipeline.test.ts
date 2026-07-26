import * as fs from "node:fs/promises";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { EVAL_CASES } from "../../eval/cases.ts";
import { evaluateRecords } from "../../eval/metrics.ts";
import { recordedOutput } from "../../eval/recorded-cases.ts";
import { FilesystemMemoryRepository } from "../../extensions/memory/repository.ts";

const provider = vi.hoisted(() => ({ extractCandidateJson: vi.fn() }));
const reviewer = vi.hoisted(() => ({ reviewCandidates: vi.fn() }));
vi.mock("../../extensions/memory/extraction/provider.ts", () => provider);
vi.mock("../../extensions/memory/extraction/review.ts", () => reviewer);
import { runExtraction } from "../../extensions/memory/extraction/coordinator.ts";

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(`${os.tmpdir()}/triple-pi-recorded-`); });
afterEach(async () => fs.rm(root, { recursive: true, force: true }));

function branch(user: string, assistant: string): SessionEntry[] {
  return [
    { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: user, timestamp: 0 } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: assistant }], timestamp: 1, api: "openai-completions", provider: "recorded", model: "recorded", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" } },
  ] as SessionEntry[];
}

describe("recorded current-pipeline eval", () => {
  for (const testCase of EVAL_CASES) {
    it(testCase.id, async () => {
      const recorded = recordedOutput(testCase, "u1");
      provider.extractCandidateJson.mockResolvedValueOnce(JSON.stringify(recorded.extraction));
      reviewer.reviewCandidates.mockResolvedValueOnce(recorded.extraction);
      const repository = new FilesystemMemoryRepository({ root });
      await runExtraction(repository, {
        cwd: testCase.cwd, sessionId: `session-${testCase.id}`, branch: branch(testCase.user, testCase.assistant),
        branchLeafId: "a1", model: { provider: "recorded" } as any, modelRegistry: {} as any,
      }, new AbortController().signal);
      const records = (await repository.list(testCase.cwd)).filter((record) => record.provenance.sessionId === `session-${testCase.id}`);
      const metrics = evaluateRecords(testCase, records);
      expect(metrics.failures).toEqual([]);
      expect(metrics.f1).toBe(1);
    });
  }

  it("isolates identical project titles across cwd", async () => {
    const repository = new FilesystemMemoryRepository({ root });
    await repository.save({ category: "rule", scope: "project", cwd: "/eval/A", title: "Shared title", content: "A only" });
    await repository.save({ category: "rule", scope: "project", cwd: "/eval/B", title: "Shared title", content: "B only" });
    expect((await repository.search("A only", "/eval/B"))).toEqual([]);
    expect((await repository.search("B only", "/eval/A"))).toEqual([]);
  });
});
