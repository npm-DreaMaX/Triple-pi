import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { FilesystemMemoryRepository } from "../../extensions/memory/repository.ts";

const provider = vi.hoisted(() => ({ extractCandidateJson: vi.fn() }));
const reviewer = vi.hoisted(() => ({ reviewCandidates: vi.fn() }));
vi.mock("../../extensions/memory/extraction/provider.ts", () => provider);
vi.mock("../../extensions/memory/extraction/review.ts", () => reviewer);

import { runExtraction } from "../../extensions/memory/extraction/coordinator.ts";

let tempDir: string;
let repository: FilesystemMemoryRepository;
const cwd = path.join(path.sep, "workspace", "extraction-project");

function snapshot() {
  return {
    cwd,
    sessionId: "session-extract",
    branchLeafId: "a1",
    branch: [
      { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "Always use strict TypeScript.", timestamp: 0 } },
      { type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "Understood." }], timestamp: 1, api: "openai-completions", provider: "mock", model: "mock", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" } },
    ] as SessionEntry[],
    model: { id: "mock", provider: "mock" } as any,
    modelRegistry: {} as any,
  };
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "triple-pi-coordinator-"));
  repository = new FilesystemMemoryRepository({ root: tempDir });
  provider.extractCandidateJson.mockReset();
  reviewer.reviewCandidates.mockReset();
  reviewer.reviewCandidates.mockImplementation(async ({ candidates }: any) => candidates);
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("extraction coordinator", () => {
  it("persists grounded candidates and returns a checkpoint", async () => {
    provider.extractCandidateJson.mockResolvedValue(JSON.stringify([{
      category: "rule",
      title: "Strict TypeScript",
      content: "Use strict TypeScript for this project.",
      evidence: "Always use strict TypeScript.",
      sourceEntryId: "u1",
      scope: "project",
    }]));

    const result = await runExtraction(repository, snapshot(), new AbortController().signal);

    expect(result).toMatchObject({ status: "saved", savedCount: 1 });
    expect(result.checkpoint).toMatchObject({ lastEntryId: "a1", branchLeafId: "a1", savedCount: 1 });
    const saved = await repository.search("strict TypeScript", cwd);
    expect(saved[0]?.record.provenance).toMatchObject({
      source: "extraction",
      sessionId: "session-extract",
      sourceEntryIds: ["u1"],
      sourceHash: expect.any(String),
    });
  });

  it("does not persist candidates removed by review", async () => {
    provider.extractCandidateJson.mockResolvedValue(JSON.stringify([{
      category: "rule", title: "Strict TypeScript", content: "Use strict TypeScript for this project.",
      evidence: "Always use strict TypeScript.", sourceEntryId: "u1", scope: "project",
    }]));
    reviewer.reviewCandidates.mockResolvedValue([]);

    const result = await runExtraction(repository, snapshot(), new AbortController().signal);

    expect(result).toMatchObject({ status: "no-candidates", savedCount: 0 });
    expect(await repository.list(cwd)).toEqual([]);
  });

  it("advances a checkpoint for a valid empty extraction", async () => {
    provider.extractCandidateJson.mockResolvedValue("[]");
    const result = await runExtraction(repository, snapshot(), new AbortController().signal);

    expect(result).toMatchObject({ status: "no-candidates", savedCount: 0 });
    expect(result.checkpoint?.lastEntryId).toBe("a1");
  });

  it("stores review score, fingerprint and reinforcement provenance", async () => {
    provider.extractCandidateJson.mockResolvedValue(JSON.stringify([{
      category: "rule", title: "Strict TypeScript", content: "Use strict TypeScript for this project.",
      evidence: "Always use strict TypeScript.", sourceEntryId: "u1", scope: "project",
    }]));
    await runExtraction(repository, snapshot(), new AbortController().signal);
    const record = (await repository.list(cwd))[0];
    expect(record.provenance).toMatchObject({
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      score: expect.any(Number), reinforcement: 1, correction: false,
    });
  });

  it("replays the same source idempotently without rewriting entries", async () => {
    provider.extractCandidateJson.mockResolvedValue(JSON.stringify([{
      category: "rule", title: "Strict TypeScript", content: "Use strict TypeScript for this project.",
      evidence: "Always use strict TypeScript.", sourceEntryId: "u1", scope: "project",
    }]));
    const first = await runExtraction(repository, snapshot(), new AbortController().signal);
    const before = (await repository.list(cwd))[0].updatedAt;
    const second = await runExtraction(repository, snapshot(), new AbortController().signal);

    expect(first.savedCount).toBe(1);
    expect(second).toMatchObject({ savedCount: 0, status: "no-candidates" });
    expect((await repository.list(cwd))[0].updatedAt).toBe(before);
    expect(provider.extractCandidateJson).toHaveBeenCalledOnce();
  });

  it("fails closed without checkpoint when validation fails", async () => {
    provider.extractCandidateJson.mockResolvedValue("not-json");
    await expect(runExtraction(repository, snapshot(), new AbortController().signal)).rejects.toThrow("not valid JSON");
    expect(await repository.list(cwd)).toEqual([]);
  });

  it("fails closed without checkpoint when the provider fails", async () => {
    provider.extractCandidateJson.mockRejectedValue(new Error("provider unavailable"));

    await expect(runExtraction(repository, snapshot(), new AbortController().signal))
      .rejects.toThrow("provider unavailable");
    expect(await repository.list(cwd)).toEqual([]);
  });

  it("does not call the provider when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await runExtraction(repository, snapshot(), controller.signal)).toMatchObject({ status: "aborted" });
    expect(provider.extractCandidateJson).not.toHaveBeenCalled();
  });
});
