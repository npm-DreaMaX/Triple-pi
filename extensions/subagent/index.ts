/**
 * SubAgent Extension — 工具层
 *
 * 两个工具：
 *  - delegate_review        手动传入 task + diff + rules
 *  - review_current_changes 自动 git diff + Memory 检索 → Reviewer
 *
 * 本层只做参数校验 → 调用 review-core + manager → 格式化结果
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SubAgentManager } from "./manager.ts";
import type { FilesystemMemoryRepository } from "../memory/repository.ts";
import {
  collectGitChanges,
  extractReviewSearchTerms,
  searchRelevantMemories,
  buildReviewChunks,
  buildReviewerInput,
  formatRelevantMemories,
  snapshotWorktree,
  compareWorktreeSnapshots,
  aggregateFindings,
} from "./review-core.ts";
import type {
  ParseFailure,
  ParseSuccess,
} from "./review-core.ts";
import type {
  ReviewerFailureKind,
  ReviewResultUnion,
  SubagentResult,
} from "./types.ts";

const REVIEW_DEADLINE_MS = 120_000;

function textBlock(content: string) {
  return { type: "text" as const, text: content };
}

export function registerSubagentExtension(
  pi: ExtensionAPI,
  repository?: FilesystemMemoryRepository,
): void {
  const manager = new SubAgentManager();

  // ═════════════════════════════════════════════════════════════
  // delegate_review — 手动传入全部参数
  // ═════════════════════════════════════════════════════════════

  const delegateReviewTool = defineTool({
    name: "delegate_review",
    label: "Delegate Code Review",
    description: [
      "创建独立的只读 Reviewer SubAgent 审查代码改动。",
      "需传入 task、diff 和 relevantRules。",
      "如需自动获取 diff 和 Memory，使用 review_current_changes。",
    ].join("\n"),
    promptSnippet: "spawn isolated read-only reviewer sub-agent",
    parameters: Type.Object({
      task: Type.String({ description: "审查任务描述" }),
      diff: Type.String({ description: "Git diff 内容" }),
      relevantRules: Type.Optional(Type.String({ description: "相关项目规则" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { task, diff, relevantRules } = params as {
        task: string; diff: string; relevantRules?: string;
      };
      if (!ctx.model) return { content: [textBlock("无可用模型。")], details: { status: "failed" } };

      const input = buildReviewerInput({
        task,
        diff,
        memory: relevantRules,
        changes: [],
        chunks: [],
      });

      const result = await manager.review({
        task,
        userMessage: input.userMessage,
        systemPrompt: input.systemPrompt,
        cwd: ctx.cwd,
        model: ctx.model,
        modelRegistry: ctx.modelRegistry,
        signal: signal || ctx.signal,
        timeoutMs: 120_000,
        chunkCount: 1,
      });

      return formatReviewResponse(result, ctx.model);
    },
  });

  // ═════════════════════════════════════════════════════════════
  // review_current_changes — 自动 git diff + Memory 检索
  // ═════════════════════════════════════════════════════════════

  const reviewCurrentChangesTool = defineTool({
    name: "review_current_changes",
    label: "Review Current Changes",
    description: [
      "【必须调用】在提交代码之前，审查当前未提交的改动是否违反了项目规则。",
      "只要项目 Memory 中存在规则（rule/decision/preference），就应在修改代码后调用此工具。",
      "尤其在以下情况务必调用：改动涉及核心逻辑、跨多个文件、新增公共接口、修改数据库操作、变更类型定义。",
      "工具会自动获取 git diff、检索相关 Memory、创建独立的只读 reviewer 执行审查。",
    ].join("\n"),
    promptSnippet: "review changes before committing — required when project rules exist",
    parameters: Type.Object({
      task: Type.String({ description: "简要描述当前改动" }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { task } = params as { task: string };
      if (!ctx.model) return { content: [textBlock("无可用模型。")], details: { status: "failed" } };
      const reviewStartedAt = Date.now();
      const deadlineAt = reviewStartedAt + REVIEW_DEADLINE_MS;

      // ── 1. Collect git changes ──
      const gitResult = collectGitChanges(ctx.cwd);
      if (!gitResult.ok) {
        if (gitResult.kind === "no-changes") {
          return {
            content: [textBlock("当前没有未提交的改动。请先修改代码再审查。")],
            details: { status: "no-changes" },
          };
        }
        if (gitResult.kind === "not-a-git-repo") {
          return {
            content: [textBlock("当前目录不是 Git 仓库。")],
            details: { status: "git-failed" },
          };
        }
        return {
          content: [textBlock(`Git 操作失败：${gitResult.error}`)],
          details: { status: "git-failed" },
        };
      }

      const changes = gitResult.changes;

      // ── 2. Snapshot worktree ──
      const worktreeBefore = snapshotWorktree(ctx.cwd);
      if (worktreeBefore.ok === false) {
        return {
          content: [textBlock(`无法创建工作目录快照：${worktreeBefore.error || "未知错误"}`)],
          details: { status: "worktree-changed", failureKind: "worktree-changed" },
        };
      }

      // ── 3. Extract search terms ──
      const terms = extractReviewSearchTerms(task, changes);

      // ── 4. Search relevant memories ──
      let memoryHits = { hits: [] } as Awaited<ReturnType<typeof searchRelevantMemories>>;
      let memoryStatus = "无相关 Memory";
      if (repository && terms.length > 0) {
        try {
          memoryHits = await searchRelevantMemories(repository, terms, ctx.cwd, 5);
          if (memoryHits.hits.length > 0) {
            memoryStatus = `已检索 ${memoryHits.hits.length} 条`;
          }
        } catch {
          // Memory 检索失败不阻塞审查
        }
      }

      const memoryStr = formatRelevantMemories(memoryHits.hits);

      // ── 5. Build review chunks ──
      const { chunks, skipped } = buildReviewChunks(changes);

      if (chunks.length === 0) {
        return {
          content: [textBlock("存在变更，但没有任何可审查的文本内容（文件为 binary/unreadable）。审查失败。")],
          details: {
            status: "failed",
            failureKind: "unreviewable-changes",
            coverage: "partial",
            skippedFiles: skipped.map((change) => change.path),
          },
        };
      }

      // ── 6. Process each chunk serially under one global deadline ──
      const chunkResults: Array<{ chunkId: string; result: ParseSuccess | ParseFailure }> = [];
      const failures: ReviewerFailureKind[] = [];
      let totalDurationMs = 0;
      let totalToolCalls = 0;

      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        const chunk = chunks[chunkIndex];
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs <= 0) {
          failures.push("timeout");
          chunkResults.push({
            chunkId: chunk.chunkId,
            result: { ok: false, failure: "timeout", error: "Global review deadline exceeded", raw: "" },
          });
          continue;
        }

        const input = buildReviewerInput({
          task,
          diff: chunk.content,
          memory: memoryStr,
          changes,
          chunks,
        });

        const result = await manager.review({
          task,
          userMessage: input.userMessage,
          systemPrompt: input.systemPrompt,
          cwd: ctx.cwd,
          model: ctx.model,
          modelRegistry: ctx.modelRegistry,
          signal: signal || ctx.signal,
          timeoutMs: remainingMs,
          chunkCount: 1,
        });
        const converted = reviewResultToParseResult(result);
        chunkResults.push({ chunkId: chunk.chunkId, result: converted.result });
        totalDurationMs += converted.durationMs;
        totalToolCalls += converted.toolCalls;
        if (!converted.result.ok) failures.push(converted.result.failure);

        if ((signal || ctx.signal)?.aborted) {
          if (converted.result.ok || converted.result.failure !== "aborted") failures.push("aborted");
          for (const remaining of chunks.slice(chunkIndex + 1)) {
            chunkResults.push({
              chunkId: remaining.chunkId,
              result: { ok: false, failure: "aborted", error: "Review aborted", raw: "" },
            });
          }
          break;
        }
      }

      // ── 7. Check worktree unchanged ──
      const worktreeAfter = snapshotWorktree(ctx.cwd);
      const worktreeChanged = worktreeAfter.ok === false || compareWorktreeSnapshots(worktreeBefore, worktreeAfter);

      if (worktreeChanged) {
        return {
          content: [textBlock("审查过程中工作目录发生变化，已取消审查以避免不一致。请重新运行。")],
          details: { status: "worktree-changed", failureKind: "worktree-changed" },
        };
      }

      // ── 8. Aggregate findings ──
      const aggregated = aggregateFindings(chunkResults);
      const complete = aggregated.coverage === "complete" && skipped.length === 0;

      if (aggregated.parsedChunks === 0) {
        const failureKind = failures[0] || "provider-failed";
        return formatReviewResponse(
          failureResult(failureKind, totalDurationMs || Date.now() - reviewStartedAt, totalToolCalls),
          ctx.model,
          changes.length,
          memoryStatus,
        );
      }

      const finalResult: SubagentResult = {
        taskId: `review-${Date.now()}`,
        status: "success",
        summary: aggregated.findings.length === 0
          ? (complete ? "未发现问题" : "审查不完整；已审查部分未发现问题")
          : (complete
              ? `发现 ${aggregated.findings.length} 个问题`
              : `审查不完整；已发现 ${aggregated.findings.length} 个问题`),
        findings: aggregated.findings.map(({ severity, file, line, description }) => ({
          severity, file, line, description,
        })),
        changedFiles: [...new Set(changes.map((change) => change.path))],
        durationMs: totalDurationMs || Date.now() - reviewStartedAt,
        toolCalls: totalToolCalls,
        coverage: complete ? "complete" : "partial",
        telemetry: {
          totalChunks: aggregated.totalChunks,
          parsedChunks: aggregated.parsedChunks,
          failedChunks: aggregated.failedChunks,
          skippedFiles: skipped.length,
          failureKinds: [...new Set(failures)],
          worktreeChanged,
        },
      };

      return formatReviewResponse(
        { kind: complete ? "success" : "partial", result: finalResult },
        ctx.model,
        changes.length,
        memoryStatus,
      );
    },
  });

  pi.registerTool(delegateReviewTool);
  pi.registerTool(reviewCurrentChangesTool);

  pi.on("session_shutdown", () => {
    manager.dispose();
  });
}

// ═══════════════════════════════════════════════════════════════
// Helpers for chunk result wrapping
// ═══════════════════════════════════════════════════════════════

function reviewResultToParseResult(result: ReviewResultUnion): {
  result: ParseSuccess | ParseFailure;
  durationMs: number;
  toolCalls: number;
} {
  if (result.kind === "success" || result.kind === "partial") {
    const status = result.result.findings.length > 0 ? "issues_found" : "passed";
    return {
      result: {
        ok: true,
        review: { status, summary: result.result.summary, findings: result.result.findings },
      },
      durationMs: result.result.durationMs,
      toolCalls: result.result.toolCalls,
    };
  }

  const failure = result.kind === "no-changes" ? "provider-failed" : result.kind;
  const raw = result.kind === "parse-failed" || result.kind === "schema-failed" ? result.raw : "";
  const error = "error" in result ? result.error : result.kind;
  return {
    result: { ok: false, failure, error, raw },
    durationMs: "durationMs" in result ? result.durationMs || 0 : 0,
    toolCalls: "toolCalls" in result ? result.toolCalls || 0 : 0,
  };
}

function failureResult(
  failureKind: ReviewerFailureKind,
  durationMs: number,
  toolCalls: number,
): ReviewResultUnion {
  const metrics = { durationMs, toolCalls };
  switch (failureKind) {
    case "timeout": return { kind: "timeout", ...metrics };
    case "aborted": return { kind: "aborted", ...metrics };
    case "session-create-failed": return { kind: failureKind, error: "All review chunks failed", ...metrics };
    case "parse-failed": return { kind: failureKind, error: "All review chunks failed to parse", raw: "", ...metrics };
    case "schema-failed": return { kind: failureKind, error: "All review chunks failed schema validation", raw: "", ...metrics };
    case "git-failed": return { kind: failureKind, error: "All review chunks failed", ...metrics };
    case "worktree-changed": return { kind: failureKind, ...metrics };
    default: return { kind: "provider-failed", error: `All review chunks failed (${failureKind})`, ...metrics };
  }
}

// ═══════════════════════════════════════════════════════════════
// Format helpers
// ═══════════════════════════════════════════════════════════════

function formatReviewResponse(
  reviewResult: ReviewResultUnion | { kind: string; result: SubagentResult },
  _model?: any,
  changeCount?: number,
  memoryStatus?: string,
) {
  const kind = reviewResult.kind;

  switch (kind) {
    case "no-changes":
      return {
        content: [textBlock("当前没有未提交的改动。请先修改代码再审查。")],
        details: { status: "no-changes" },
      };

    case "git-failed":
      return {
        content: [textBlock(`Git 操作失败：${(reviewResult as any).error || "未知错误"}`)],
        details: { status: "git-failed" },
      };

    case "session-create-failed":
      return {
        content: [textBlock(`创建审查 Session 失败：${(reviewResult as any).error || "未知错误"}`)],
        details: {
          status: "session-create-failed",
          failureKind: "session-create-failed",
          ...failureMetrics(reviewResult),
        },
      };

    case "provider-failed":
      return {
        content: [textBlock(`审查执行失败（Provider 错误）：${(reviewResult as any).error || "未知错误"}`)],
        details: { status: "failed", failureKind: "provider-failed", ...failureMetrics(reviewResult) },
      };

    case "parse-failed":
    case "schema-failed": {
      const { error } = reviewResult as any;
      return {
        content: [textBlock(`审查输出解析失败：${error}。审查代理未能返回有效结果。`)],
        details: {
          status: "failed",
          failureKind: kind,
          error,
          raw: (reviewResult as any).raw,
          ...failureMetrics(reviewResult),
        },
      };
    }

    case "timeout":
      return {
        content: [textBlock("Reviewer SubAgent 超时（120 秒）。")],
        details: { status: "timeout", failureKind: "timeout", ...failureMetrics(reviewResult) },
      };

    case "aborted":
      return {
        content: [textBlock("审查被取消。")],
        details: { status: "aborted", failureKind: "aborted" },
      };

    case "worktree-changed":
      return {
        content: [textBlock("审查过程中工作目录发生变化，已取消审查以避免不一致。请重新运行。")],
        details: { status: "worktree-changed", failureKind: "worktree-changed" },
      };

    case "success":
    case "partial": {
      const result = (reviewResult as any).result as SubagentResult;
      return formatSuccessResponse(result, changeCount, memoryStatus, kind === "partial");
    }

    default:
      return {
        content: [textBlock(`未知审查结果：${kind}`)],
        details: { status: "failed" },
      };
  }
}

function failureMetrics(reviewResult: unknown): { durationMs?: number; toolCalls?: number } {
  if (!reviewResult || typeof reviewResult !== "object") return {};
  const result = reviewResult as { durationMs?: number; toolCalls?: number };
  return {
    ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
    ...(result.toolCalls !== undefined ? { toolCalls: result.toolCalls } : {}),
  };
}

function formatSuccessResponse(
  result: SubagentResult,
  changeCount?: number,
  memoryStatus?: string,
  partial = false,
) {
  const findingsText = result.findings.length === 0
    ? (partial ? "已完成的审查部分未发现问题；不能据此断言全部变更无问题。" : "未发现问题。")
    : result.findings.map((f, i) =>
        `${i + 1}. **${f.severity}** ${f.file ? `\`${f.file}\`` : ""}${f.line ? `:${f.line}` : ""} — ${f.description}`
      ).join("\n");

  const severityCounts = {
    high: result.findings.filter((f) => f.severity === "high").length,
    medium: result.findings.filter((f) => f.severity === "medium").length,
    low: result.findings.filter((f) => f.severity === "low").length,
  };

  const metaParts = [
    changeCount ? `**变更文件**：${changeCount}` : "",
    `**Coverage**：${result.coverage || "complete"}`,
    memoryStatus ? `**Memory**：${memoryStatus}` : "",
    `**耗时**：${result.durationMs}ms`,
    `**工具调用**：${result.toolCalls} 次`,
  ];
  if (result.telemetry) {
    metaParts.push(`**分片**：${result.telemetry.parsedChunks}/${result.telemetry.totalChunks}`);
  }

  const meta = metaParts.filter(Boolean).join("　");

  return {
    content: [textBlock([
      partial ? "## Code Review — 审查不完整" : `## Code Review — ${result.summary}`,
      partial ? `> 警告：仅部分变更完成审查。${result.summary}` : "",
      "",
      meta,
      `**严重**：${severityCounts.high}　**中等**：${severityCounts.medium}　**轻微**：${severityCounts.low}`,
      "",
      findingsText,
    ].join("\n"))],
    details: {
      status: result.status,
      summary: result.summary,
      findings: result.findings,
      coverage: result.coverage,
      telemetry: result.telemetry,
      durationMs: result.durationMs,
      toolCalls: result.toolCalls,
    },
  };
}

export default function subagentExtension(pi: ExtensionAPI): void {
  registerSubagentExtension(pi);
}
