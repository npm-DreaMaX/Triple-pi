import { describe, expect, it } from "vitest";
import type { MemoryRecord } from "../../extensions/memory/domain.ts";
import { planConsolidation } from "../../extensions/memory/extraction/consolidation.ts";
import { isCorrectionEvidence, scoreCandidate, semanticFingerprint } from "../../extensions/memory/extraction/signals.ts";

const candidate = {
  category: "rule" as const,
  requestedScope: "project" as const,
  resolvedScope: "project" as const,
  scope: "project" as const,
  title: "API response format",
  content: "Use the envelope data/error format.",
  evidence: "Always use the data/error envelope.",
  sourceEntryId: "u1",
};
const messages = [{ entryId: "u1", role: "user" as const, content: candidate.evidence, timestamp: "2026-01-01" }];

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    schemaVersion: 2, id: "existing", category: "rule", scope: "project", projectId: "project",
    title: candidate.title, content: candidate.content, createdAt: "2026-01-01", updatedAt: "2026-01-01",
    provenance: { source: "extraction", fingerprint: semanticFingerprint(candidate) }, ...overrides,
  };
}

describe("stable signals and consolidation", () => {
  it("creates a stable fingerprint independent of title word order", () => {
    expect(semanticFingerprint(candidate)).toBe(semanticFingerprint({ ...candidate, title: "format response API" }));
  });

  it("accumulates reinforcement from prior project state", () => {
    const first = scoreCandidate(candidate, messages, 0);
    const later = scoreCandidate(candidate, messages, 4);
    expect(first.reinforcement).toBe(1);
    expect(later.reinforcement).toBe(5);
    expect(later.score).toBeGreaterThan(first.score);
  });

  it("detects explicit correction but not ordinary negative rules", () => {
    expect(isCorrectionEvidence("Actually, use GraphQL instead.")).toBe(true);
    expect(isCorrectionEvidence("更正：以后用 GraphQL。")).toBe(true);
    expect(isCorrectionEvidence("Do not use unsafe any in tests.")).toBe(false);
  });

  it("skips the same fingerprint without rewriting", () => {
    const signals = scoreCandidate(candidate, messages, 1);
    expect(planConsolidation(candidate, signals, [record()]).action).toBe("skip");
  });

  it("never deduplicates across categories", () => {
    const signals = scoreCandidate(candidate, messages, 1);
    expect(planConsolidation(candidate, signals, [record({ category: "fact" })]).action).toBe("create");
  });

  it("replaces a similar record only for grounded correction", () => {
    const correction = { ...candidate, evidence: "Actually, use the data/error envelope instead." };
    const correctionMessages = [{ ...messages[0], content: correction.evidence }];
    const signals = scoreCandidate(correction, correctionMessages, 1);
    const plan = planConsolidation(correction, signals, [record({ provenance: { source: "extraction" } })]);
    expect(plan.action).toBe("replace");
    expect(plan.existing?.id).toBe("existing");
  });
});
