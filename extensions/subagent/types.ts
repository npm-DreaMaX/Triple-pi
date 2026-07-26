/**
 * SubAgent 类型定义
 *
 * 当前 V1 只实现 Reviewer（只读代码审查），不做 Coder/Tester。
 * 类型系统为后续扩展预留了 role 字段。
 */

export type SubagentRole = "reviewer";

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
  severity: "low" | "medium" | "high";
  file?: string;
  line?: number;
  description: string;
}

export interface ReviewResult {
  status: "passed" | "issues_found" | "failed" | "timeout";
  summary: string;
  findings: ReviewFinding[];
}

export interface SubagentResult {
  taskId: string;
  status: "success" | "failed" | "timeout";
  summary: string;
  findings: ReviewFinding[];
  /** 修改的文件列表（当前 Reviewer 始终为空） */
  changedFiles: string[];
  durationMs: number;
  toolCalls: number;
  error?: string;
}
