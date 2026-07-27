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
  buildDiffString,
  formatRelevantMemories,
  snapshotWorktree,
  compareWorktreeSnapshots,
  aggregateFindings,
} from "./review-core.ts";
import type { ReviewResultUnion, SubagentResult, ReviewCoverage } from "./types.ts";

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
      "自动获取当前项目 git diff，检索相关 Memory，创建 Reviewer SubAgent 审查。",
      "无需手动传入 diff 或规则。",
    ].join("\n"),
    promptSnippet: "auto-review current git changes with memory-aware reviewer",
    parameters: Type.Object({
      task: Type.String({ description: "简要描述当前改动" }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { task } = params as { task: string };
      if (!ctx.model) return { content: [textBlock("无可用模型。")], details: { status: "failed" } };

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
      const diffStr = buildDiffString(changes);

      // ── 5. Build review chunks ──
      const { chunks, skipped } = buildReviewChunks(changes);

      if (chunks.length === 0) {
        return {
          content: [textBlock("没有可审查的变更（所有文件均为 binary/unreadable）。")],
          details: { status: "no-changes" },
        };
      }

      // ── 6. Process each chunk via manager ──
      const chunkResults: Array<{
        chunkId: string;
        result: ReturnType<typeof parseReviewOutput>;
      }> = [];

      for (const chunk of chunks) {
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
          timeoutMs: 120_000,
          chunkCount: chunks.length,
        });

        // Extract parsing result from the manager response
        let parseOk = false;
        if (result.kind === "success" || result.kind === "partial") {
          parseOk = result.result.findings.length > 0 || result.result.summary !== "";
        }

        chunkResults.push({
          chunkId: chunk.chunkId,
          result: {
            ok: parseOk,
            status: parseOk
              ? (result.kind === "success" || result.kind === "partial"
                  ? (result.result.findings.length > 0 ? "issues_found" : "passed")
                  : "passed")
              : "failed",
            summary: (result.kind === "success" || result.kind === "partial") ? result.result.summary : "",
            findings: (result.kind === "success" || result.kind === "partial") ? result.result.findings : [],
            failure: parseOk ? undefined : "parse-failed",
            error: parseOk ? undefined : "Chunk processing failed",
            raw: "",
          } as any,
        });

        // Stop early if aborted
        if ((signal || ctx.signal)?.aborted) break;
      }

      // ── 7. Check worktree unchanged ──
      const worktreeAfter = snapshotWorktree(ctx.cwd);
      const worktreeChanged = compareWorktreeSnapshots(worktreeBefore, worktreeAfter);

      if (worktreeChanged) {
        return {
          content: [textBlock("审查过程中工作目录发生变化，已取消审查以避免不一致。请重新运行。")],
          details: { status: "worktree-changed" },
        };
      }

      // ── 8. Aggregate findings ──
      const aggregated = aggregateFindings(
        chunkResults.map((cr) => ({
          chunkId: cr.chunkId,
          result: cr.result.ok
            ? { ok: true as const, review: { status: cr.result.status as "passed" | "issues_found", summary: cr.result.summary, findings: cr.result.findings } }
            : { ok: false as const, failure: cr.result.failure as any, error: cr.result.error || "Chunk failed", raw: cr.result.raw || "" },
        })),
      );

      const finalResult: SubagentResult = {
        taskId: `review-${Date.now()}`,
        status: aggregated.findings.length === 0 ? "success" : "success",
        summary: aggregated.findings.length === 0
          ? "未发现问题"
          : `发现 ${aggregated.findings.length} 个问题`,
        findings: aggregated.findings.map((f) => ({
          severity: f.severity,
          file: f.file,
          line: f.line,
          description: f.description,
        })),
        changedFiles: changes.map((c) => c.path),
        durationMs: 0, // total duration computed from individual calls
        toolCalls: 0,
        coverage: aggregated.coverage,
        telemetry: {
          totalChunks: aggregated.totalChunks,
          parsedChunks: aggregated.parsedChunks,
          failedChunks: aggregated.failedChunks,
          worktreeChanged,
        },
      };

      return formatReviewResponse(
        { kind: aggregated.coverage === "complete" ? "success" : "partial", result: finalResult },
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

function parseReviewOutput(text: string): {
  ok: boolean;
  status: string;
  summary: string;
  findings: any[];
  failure?: string;
  error?: string;
  raw?: string;
} {
  if (!text.trim()) {
    return { ok: false, status: "failed", summary: "", findings: [], failure: "parse-failed", error: "Empty output", raw: text };
  }
  try {
    const p = JSON.parse(text);
    return {
      ok: true,
      status: p.status || "passed",
      summary: p.summary || "",
      findings: Array.isArray(p.findings) ? p.findings : [],
    };
  } catch {
    return { ok: false, status: "failed", summary: "", findings: [], failure: "parse-failed", error: "Invalid JSON", raw: text };
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
        details: { status: "session-create-failed" },
      };

    case "provider-failed":
      return {
        content: [textBlock(`审查执行失败（Provider 错误）：${(reviewResult as any).error || "未知错误"}`)],
        details: { status: "failed" },
      };

    case "parse-failed":
    case "schema-failed": {
      const { error } = reviewResult as any;
      return {
        content: [textBlock(`审查输出解析失败：${error}。审查代理未能返回有效结果。`)],
        details: { status: "failed", error, raw: (reviewResult as any).raw },
      };
    }

    case "timeout":
      return {
        content: [textBlock("Reviewer SubAgent 超时（120 秒）。")],
        details: { status: "timeout" },
      };

    case "aborted":
      return {
        content: [textBlock("审查被取消。")],
        details: { status: "aborted" },
      };

    case "worktree-changed":
      return {
        content: [textBlock("审查过程中工作目录发生变化，已取消审查以避免不一致。请重新运行。")],
        details: { status: "worktree-changed" },
      };

    case "success":
    case "partial": {
      const result = (reviewResult as any).result as SubagentResult;
      return formatSuccessResponse(result, changeCount, memoryStatus);
    }

    default:
      return {
        content: [textBlock(`未知审查结果：${kind}`)],
        details: { status: "failed" },
      };
  }
}

function formatSuccessResponse(
  result: SubagentResult,
  changeCount?: number,
  memoryStatus?: string,
) {
  const findingsText = result.findings.length === 0
    ? "未发现问题。"
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
      `## Code Review — ${result.summary}`,
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
    },
  };
}

export default function subagentExtension(pi: ExtensionAPI): void {
  registerSubagentExtension(pi);
}
