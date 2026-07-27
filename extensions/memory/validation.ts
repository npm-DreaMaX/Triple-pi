/**
 * Shared validation for manual and automatic memory writes.
 *
 * Exported utilities are used by tool-layer SaveMemory, extraction pipeline,
 * and repository-layer batch save to ensure consistent guardrails.
 */
import { isMemoryCategory, type MemoryScope } from "./domain.ts";

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

export const MAX_TITLE_LENGTH = 120;
export const MAX_CONTENT_LENGTH = 64_000; // manual ceiling; extraction uses tighter 2_000

// ═══════════════════════════════════════════════════════════════
// Secret detection (reusable from pipeline; extracted for sharing)
// ═══════════════════════════════════════════════════════════════

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|api|key|token|secret)[-_][a-zA-Z0-9_-]{12,}\b/gi,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /\bAuthorization\s*:\s*Bearer\s+[^\s,;]+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:password|passwd|api[_-]?key|access[_-]?token|secret)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
];

export function containsSecret(value: string): boolean {
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) return true;
  }
  return false;
}

export function redactSecretsFromText(content: string): { text: string; containedSecrets: boolean } {
  let containedSecrets = false;
  const text = content;
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      containedSecrets = true;
      pattern.lastIndex = 0;
    }
  }
  if (!containedSecrets) return { text, containedSecrets: false };
  let redacted = content;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, "[REDACTED_SECRET]");
  }
  return { text: redacted, containedSecrets: true };
}

// ═══════════════════════════════════════════════════════════════
// Validation errors
// ═══════════════════════════════════════════════════════════════

export type ValidationRejection =
  | { kind: "invalid-category"; value: string }
  | { kind: "invalid-scope"; value: string }
  | { kind: "empty-title" }
  | { kind: "title-too-long"; length: number; max: number }
  | { kind: "empty-content" }
  | { kind: "content-too-long"; length: number; max: number }
  | { kind: "contains-secret" };

export function describeRejection(rejection: ValidationRejection): string {
  switch (rejection.kind) {
    case "invalid-category":
      return `无效分类 "${rejection.value}"`;
    case "invalid-scope":
      return `无效作用域 "${rejection.value}"（应为 project 或 global）`;
    case "empty-title":
      return "标题不能为空";
    case "title-too-long":
      return `标题过长（${rejection.length}，上限 ${rejection.max}）`;
    case "empty-content":
      return "内容不能为空";
    case "content-too-long":
      return `内容过长（${rejection.length}，上限 ${rejection.max}）`;
    case "contains-secret":
      return "内容包含疑似凭证/密钥，已拒绝保存";
  }
}

// ═══════════════════════════════════════════════════════════════
// Unified write validator
// ═══════════════════════════════════════════════════════════════

export interface MemoryWriteInput {
  category: string;
  title: string;
  content: string;
  scope?: string;
}

export interface ValidatedMemoryWrite {
  category: string;
  title: string;
  content: string;
  scope: MemoryScope;
}

export function validateMemoryWrite(
  input: MemoryWriteInput,
  limits: { maxTitleLength?: number; maxContentLength?: number; source?: "manual" | "extraction" } = {},
): ValidatedMemoryWrite | ValidationRejection {
  const maxTitle = limits.maxTitleLength ?? MAX_TITLE_LENGTH;
  const maxContent = limits.maxContentLength ?? MAX_CONTENT_LENGTH;

  if (!isMemoryCategory(input.category)) {
    return { kind: "invalid-category", value: input.category };
  }
  if (input.scope !== undefined && input.scope !== "project" && input.scope !== "global") {
    return { kind: "invalid-scope", value: input.scope };
  }

  const title = input.title.trim();
  if (!title) return { kind: "empty-title" };
  if (title.length > maxTitle) return { kind: "title-too-long", length: title.length, max: maxTitle };

  const content = input.content.trim();
  if (!content) return { kind: "empty-content" };
  if (content.length > maxContent) return { kind: "content-too-long", length: content.length, max: maxContent };

  if (containsSecret(title) || containsSecret(content)) {
    return { kind: "contains-secret" };
  }

  return {
    category: input.category,
    title,
    content,
    scope: input.scope === "global" ? "global" : "project",
  };
}

// ═══════════════════════════════════════════════════════════════
// Automatic global scope guard
// ═══════════════════════════════════════════════════════════════

const CROSS_PROJECT_PATTERNS: RegExp[] = [
  /\bacross\s+all\s+(?:my\s+)?projects?\b/i,
  /\ball\s+(?:my\s+)?projects?\b/i,
  /\bevery\s+project\b/i,
  /\bfor\s+all\s+repositories?\b/i,
  /\bglobally\b/i,
  /无论哪个项目/,
  /所有项目/,
  /跨项目/,
  /全局/,
  /以后每个?项目/,
];

export function isExplicitCrossProjectEvidence(evidenceText: string): boolean {
  return CROSS_PROJECT_PATTERNS.some((p) => p.test(evidenceText));
}

export function resolveAutomaticScope(
  candidateScope: MemoryScope,
  evidenceText: string,
): MemoryScope {
  if (candidateScope !== "global") return candidateScope;
  return isExplicitCrossProjectEvidence(evidenceText) ? "global" : "project";
}
