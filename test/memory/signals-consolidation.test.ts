import { describe, expect, it } from "vitest";
import type { MemoryRecord } from "../../extensions/memory/domain.ts";
import { planConsolidation, similarity } from "../../extensions/memory/extraction/consolidation.ts";
import { isCorrectionEvidence, scoreCandidate, semanticFingerprint } from "../../extensions/memory/extraction/signals.ts";
import { tokenize } from "../../extensions/memory/extraction/tokenize.ts";

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

describe("CJK tokenization (M1 regression)", () => {
  // M1 修复前：`[\p{L}\p{N}]+/gu` 在中文上不切词，整段中文 1 个 token，
  // 导致同义/近重述中文 similarity=0、去重失效、指纹对中文文本几乎随内容标点而变。
  it("CJK 文本切成 bigram 而非整段一个 token", () => {
    const toks = tokenize("这个项目使用pnpm作为包管理器不要用npm");
    // 修复前是 ["这个项目使用pnpm作为包管理器不要用npm"] 1 个 token
    expect(toks.length).toBeGreaterThan(5);
    // ASCII pnpm / npm 必须被独立切出（修复前与中文粘连丢失）
    expect(toks).toContain("pnpm");
    expect(toks).toContain("npm");
    // 中文 bigram
    expect(toks).toContain("项目");
  });

  it("近重述中文（标点/空格变体）similarity 应较高，能触发去重", () => {
    const a = "鉴权统一用JWT，不再用服务端session。";
    const b = "鉴权统一用 JWT，不再用服务端 session。";
    // 修复前 = 0；修复后应接近 1（仅需差异的标点空格不影响 bigram 集合）
    expect(similarity(a, b)).toBeGreaterThanOrEqual(0.72);
  });

  it("同一条中文记忆的标点空格变体应被 skip（去重，非 create）", () => {
    const cnCandidate = {
      ...candidate,
      title: "鉴权",
      content: "使用JWT做无状态认证，弃用服务端session。",
      evidence: "用JWT做无状态认证",
    };
    const cnMessages = [{ ...messages[0], content: cnCandidate.evidence }];
    const signals = scoreCandidate(cnCandidate, cnMessages, 0);
    const existing: MemoryRecord = {
      schemaVersion: 2, id: "cn1", category: "rule", scope: "project", projectId: "project",
      title: "鉴权",
      content: "使用 JWT 做无状态认证，弃用服务端 session。",
      createdAt: "2026-01-01", updatedAt: "2026-01-01",
      provenance: { source: "extraction" },
    };
    // 修复前 plan=create（similarity=0 < 0.72）；修复后应 skip 或 replace
    const plan = planConsolidation(cnCandidate, signals, [existing]);
    expect(plan.action).not.toBe("create");
  });

  it("同义词改写不应越权去重（鉴权↔认证 仍需 create，属 M3 词汇鸿沟、非 M1）", () => {
    // 这是刻意的边界保护：M1 只修分词，不引入同义识别。
    // 同义词相似度应 < 0.72，避免误合并语义不同的记录。
    expect(similarity("鉴权方式 使用JWT", "认证方式 用JWT")).toBeLessThan(0.72);
  });

  it("英文行为不回归（词序无关指纹、相似度量级）", () => {
    // 修复前既有用例，确保 bigram 改造不破坏英文语义
    expect(similarity("Use the envelope data/error format", "format the envelope data error use")).toBeGreaterThan(0.5);
    expect(semanticFingerprint(candidate)).toBe(
      semanticFingerprint({ ...candidate, title: "format response API" }),
    );
  });
});
