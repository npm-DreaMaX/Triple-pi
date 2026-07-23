/**
 * Triple-pi Memory System — Type Definitions
 *
 * Design reference: OpenClaw's three-layer memory architecture, simplified
 * for a single-user personal coding agent.
 *
 * Layer 1 (implemented):   MEMORY.md index + per-file persistence
 * Layer 2 (simplified):     Index always in context, details on-demand via Read tool
 * Layer 3 (deferred):       Dreaming auto-consolidation (not needed at < 100 memories)
 */

/** Categories for organizing memories. Mirrors OpenClaw's memory types. */
export type MemoryCategory = 'preference' | 'decision' | 'rule' | 'fact';

/** Human-readable labels for each category. */
export const CATEGORY_LABELS: Record<MemoryCategory, string> = {
  preference: '用户偏好',
  decision:    '技术决策',
  rule:        '项目规则',
  fact:        '事实信息',
};

/** Description of what each category should contain. Injected into system prompt
 *  so the agent knows when and how to write each type of memory. */
export const CATEGORY_GUIDELINES: Record<MemoryCategory, string> = {
  preference:
    '用户的工作习惯、代码风格偏好、沟通偏好。' +
    '例如："用户偏好简洁回复，不要冗长解释"、"用户禁止使用 any 类型"。',
  decision:
    '项目中的关键技术决策及其原因。' +
    '例如："auth 模块选择 JWT 而非 session，因为需要支持多服务无状态认证"。',
  rule:
    '项目或工作流中不可违反的规则。' +
    '例如："禁止 git push 到 main 分支"、"不允许删除 .env 文件"。',
  fact:
    '需要记住的客观信息。' +
    '例如："项目使用 pnpm workspace monorepo 结构"、"测试框架是 vitest"。',
};

/** A single memory entry stored as a markdown file on disk. */
export interface MemoryEntry {
  /** Relative path from memory root, e.g. "preference/no-any-type.md" */
  path: string;
  /** Category folder name */
  category: MemoryCategory;
  /** Short title, used as the index link text */
  title: string;
  /** ISO date string when this memory was created */
  createdAt: string;
  /** ISO date string when this memory was last modified */
  updatedAt: string;
  /** Full file content */
  content: string;
}

/** Parsed structure of the MEMORY.md index file. */
export interface MemoryIndex {
  /** Raw markdown content of the index file */
  raw: string;
  /** Individual entries parsed from the index */
  entries: MemoryIndexEntry[];
}

/** A single line-item in MEMORY.md, e.g. "- [no any 类型](preference/no-any-type.md)" */
export interface MemoryIndexEntry {
  title: string;
  path: string;
  category: MemoryCategory;
}

/** Result returned by searchMemory(). */
export interface SearchResult {
  entry: MemoryEntry;
  /** Which part of the content matched (first 200 chars of matching line) */
  snippet: string;
}
