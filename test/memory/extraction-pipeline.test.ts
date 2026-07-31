import { describe, expect, it } from "vitest";
import { redactSecrets, validateCandidates } from "../../extensions/memory/extraction/pipeline.ts";
import type { ExtractionSource } from "../../extensions/memory/extraction/source.ts";

const source: ExtractionSource = {
  messages: [
    { entryId: "u1", role: "user", content: "Always use strict TypeScript in this project.", timestamp: "2026-01-01" },
    { entryId: "a1", role: "assistant", content: "I will do that.", timestamp: "2026-01-01" },
  ],
  sourceEntryIds: ["u1", "a1"],
  sourceHash: "hash",
  lastEntryId: "a1",
  branchLeafId: "a1",
};

function raw(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify([{
    category: "rule",
    title: "Strict TypeScript",
    content: "Use strict TypeScript for this project.",
    evidence: "Always use strict TypeScript in this project.",
    sourceEntryId: "u1",
    scope: "project",
    ...overrides,
  }]);
}

describe("strict extraction pipeline", () => {
  it("accepts a grounded user candidate", () => {
    expect(validateCandidates(raw(), source)).toHaveLength(1);
  });

  it("preserves requested and resolved scope after policy downgrade", () => {
    const globalSource = {
      ...source,
      messages: [{ ...source.messages[0], content: "Always use strict TypeScript." }, source.messages[1]],
    };
    const candidate = validateCandidates(raw({
      scope: "global",
      evidence: "Always use strict TypeScript.",
    }), globalSource)[0];
    expect(candidate).toMatchObject({ requestedScope: "global", resolvedScope: "project", scope: "project" });
  });

  it("keeps same-title candidates for uniform review", () => {
    const first = JSON.parse(raw())[0];
    const second = { ...first, evidence: "Always use strict TypeScript in this project.", content: "A corrected interpretation." };
    expect(validateCandidates(JSON.stringify([first, second]), source)).toHaveLength(2);
  });

  it("fails closed for malformed JSON or extra schema keys", () => {
    expect(() => validateCandidates("not-json", source)).toThrow("not valid JSON");
    expect(() => validateCandidates(raw({ extra: true }), source)).toThrow("strict validation");
  });

  it("rejects assistant-only and hallucinated evidence", () => {
    expect(() => validateCandidates(raw({ sourceEntryId: "a1", evidence: "I will do that." }), source)).toThrow();
    expect(() => validateCandidates(raw({ evidence: "Use Rust" }), source)).toThrow();
  });

  it("redacts common secrets before provider calls", () => {
    const prepared = redactSecrets([{ ...source.messages[0], content: "api_key=super-secret-token-value" }]);
    expect(prepared.containedSecrets).toBe(true);
    expect(prepared.redactedMessages[0].content).toBe("[REDACTED_SECRET]");
  });

  it("rejects candidates grounded on redacted placeholders", () => {
    const redacted = { ...source, messages: [{ ...source.messages[0], content: "Token: [REDACTED_SECRET]" }, source.messages[1]] };
    expect(() => validateCandidates(raw({ evidence: "[REDACTED_SECRET]", content: "Save [REDACTED_SECRET]" }), redacted)).toThrow();
  });

  it("detects provider-returned GitHub and bearer secrets", () => {
    const github = "github_pat_1234567890abcdefghijklmnop";
    const secretSource = {
      ...source,
      messages: [{ ...source.messages[0], content: `Token ${github}` }, source.messages[1]],
    };
    expect(() => validateCandidates(raw({ evidence: github, content: `Store ${github}` }), secretSource)).toThrow("secret");
  });
});
