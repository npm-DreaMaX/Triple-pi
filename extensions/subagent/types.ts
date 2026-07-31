/**
 * SubAgent 类型定义
 *
 * 当前 V1 只实现 Reviewer（只读代码审查），不做 Coder/Tester。
 * 类型系统为后续扩展预留了 role 字段。
 */

export type SubagentRole = "reviewer";

export type ReviewFindingSeverity = "low" | "medium" | "high";
export type ReviewStatus = "passed" | "issues_found";

export type ReviewerFailureKind =
  | "git-failed"
  | "session-create-failed"
  | "provider-failed"
  | "parse-failed"
  | "schema-failed"
  | "timeout"
  | "aborted"
  | "worktree-changed"
  | "unreviewable-changes"
  | "no-changes";

export type ReviewCoverage = "partial" | "complete";

export interface ReviewerTelemetry {
  totalChunks: number;
  parsedChunks: number;
  failedChunks: number;
  worktreeChanged: boolean;
  /** Files omitted from model input (for example binary or unreadable files). */
  skippedFiles?: number;
  /** Original failure kinds from chunks that did not complete. */
  failureKinds?: ReviewerFailureKind[];
}

export interface SubagentTask {
  id: string;
  role: SubagentRole;
  /** 审查任务描述 */
  prompt: string;
  /** 工作目录 */
  workingDirectory: string;
  /** 超时毫秒 */
  timeoutMs: number;
  /** 需要注入的相关 Memory 记录 ID（可选，用于最小化上下文） */
  relevantMemoryIds?: string[];
}

export interface ReviewFinding {
  severity: ReviewFindingSeverity;
  file?: string;
  line?: number;
  description: string;
}

export interface ReviewResult {
  status: ReviewStatus | "failed" | "timeout";
  summary: string;
  findings: ReviewFinding[];
}

export interface SubagentResult {
  taskId: string;
  /** 兼容旧 status 字段 */
  status: "success" | "failed" | "timeout";
  summary: string;
  findings: ReviewFinding[];
  /** 修改的文件列表（当前 Reviewer 始终为空） */
  changedFiles: string[];
  durationMs: number;
  toolCalls: number;
  error?: string;

  // ═════════════════════════════════════════════════════════════
  // 新字段（V2）
  // ═════════════════════════════════════════════════════════════

  /** 失败的具体原因（仅在 status 为 failed/timeout 时有意义） */
  failureKind?: ReviewerFailureKind;
  /** 审查覆盖率 */
  coverage?: ReviewCoverage;
  /** 遥测信息 */
  telemetry?: ReviewerTelemetry;
}

/**
 * 判别联合结果类型，Manager.review() 的主返回值
 */
export interface ReviewExecutionMetrics {
  durationMs?: number;
  toolCalls?: number;
}

export type ReviewResultUnion =
  | { kind: "no-changes"; message: string }
  | { kind: "success"; result: SubagentResult }
  | { kind: "partial"; result: SubagentResult }
  | ({ kind: "git-failed"; error: string } & ReviewExecutionMetrics)
  | ({ kind: "session-create-failed"; error: string } & ReviewExecutionMetrics)
  | ({ kind: "provider-failed"; error: string } & ReviewExecutionMetrics)
  | ({ kind: "parse-failed"; error: string; raw: string } & ReviewExecutionMetrics)
  | ({ kind: "schema-failed"; error: string; raw: string } & ReviewExecutionMetrics)
  | ({ kind: "timeout" } & ReviewExecutionMetrics)
  | ({ kind: "aborted" } & ReviewExecutionMetrics)
  | ({ kind: "worktree-changed" } & ReviewExecutionMetrics);

/**
 * Git 变更文件描述
 */
export interface ChangeFile {
  path: string;
  status: "staged" | "unstaged" | "untracked";
  diff: string;
  content?: string;
  binary: boolean;
  unreadable: boolean;
  skipped: boolean;
}

/**
 * Review chunk — 单个 LLM 请求的输入分片
 */
export interface ReviewChunk {
  chunkId: string;
  files: string[];
  content: string;
  charCount: number;
}

/**
 * Review input — 构建单个 prompt 的输入
 */
export interface ReviewInput {
  task: string;
  diff: string;
  memory?: string;
  changes: ChangeFile[];
  chunks: ReviewChunk[];
}
