import { describe, expect, it, vi } from "vitest";
import { reviewCandidates } from "../../extensions/memory/extraction/review.ts";

const candidate = {
  category: "rule" as const, title: "Strict TypeScript", content: "Use strict TypeScript.",
  evidence: "Always use strict TypeScript.", sourceEntryId: "u1",
  requestedScope: "project" as const, resolvedScope: "project" as const, scope: "project" as const,
};
const source = {
  messages: [{ entryId: "u1", role: "user" as const, content: candidate.evidence, timestamp: "2026-01-01" }],
  sourceEntryIds: ["u1"], sourceHash: "hash", lastEntryId: "u1", branchLeafId: "u1",
};

function setup(output: unknown) {
  const result = vi.fn().mockResolvedValue({
    stopReason: "stop",
    content: [{ type: "text", text: typeof output === "string" ? output : JSON.stringify(output) }],
  });
  const provider = { streamSimple: vi.fn(() => ({ result })) };
  const modelRegistry = {
    getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true }),
    getProviderAuth: vi.fn().mockResolvedValue(undefined),
    getProvider: vi.fn(() => provider),
  };
  return { modelRegistry: modelRegistry as any, provider };
}

function decision(overrides: Record<string, unknown> = {}) {
  return [{ action: "keep", reason: "durable", title: candidate.title, content: candidate.content,
    evidence: candidate.evidence, sourceEntryId: candidate.sourceEntryId, ...overrides }];
}

describe("grounded memory review", () => {
  it("keeps an unchanged grounded candidate", async () => {
    const { modelRegistry } = setup(decision());
    expect(await reviewCandidates({ model: { provider: "mock" } as any, modelRegistry, candidates: [candidate], source, signal: new AbortController().signal })).toEqual([candidate]);
  });

  it("honors remove decisions", async () => {
    const { modelRegistry } = setup(decision({ action: "remove" }));
    expect(await reviewCandidates({ model: { provider: "mock" } as any, modelRegistry, candidates: [candidate], source, signal: new AbortController().signal })).toEqual([]);
  });

  it("rejects reviewer rewrites and malformed schemas", async () => {
    const rewritten = setup(decision({ content: "Invented content" }));
    await expect(reviewCandidates({ model: { provider: "mock" } as any, modelRegistry: rewritten.modelRegistry, candidates: [candidate], source, signal: new AbortController().signal })).rejects.toThrow("rewrite");
    const malformed = setup("not-json");
    await expect(reviewCandidates({ model: { provider: "mock" } as any, modelRegistry: malformed.modelRegistry, candidates: [candidate], source, signal: new AbortController().signal })).rejects.toThrow("not valid JSON");
  });

  it("rejects result count mismatch", async () => {
    const { modelRegistry } = setup([]);
    await expect(reviewCandidates({ model: { provider: "mock" } as any, modelRegistry, candidates: [candidate], source, signal: new AbortController().signal })).rejects.toThrow("count mismatch");
  });
});
