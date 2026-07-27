/**
 * SubAgentManager — 严格 Session 隔离
 *
 * 使用 Pi SDK createAgentSession() 创建隔离的只读 Reviewer SubAgent。
 *
 * 隔离:
 *  - DefaultResourceLoader({noExtensions:true, noSkills:true, noPromptTemplates:true, noThemes:true, noContextFiles:true})
 *  - tools: ["read","grep","find","ls"] — 只读白名单
 *  - SessionManager.inMemory() — 独立上下文，不持久化
 *  - Promise.race — 硬超时，调用方在 deadline 后必定返回
 *
 * 超时语义:
 *  调用方在 deadline 后必定拿回 timeout 结果。
 *  session.abort() 在后台触发协作式取消。
 *  如果 abort 没能让 prompt 立即结束，调用方也不等待。
 *  底层 Provider HTTP 请求可能继续，但调用方已释放。
 */

import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

import type {
  ReviewResultUnion,
  SubagentResult,
  ReviewerFailureKind,
  ReviewerTelemetry,
  ReviewCoverage,
} from "./types.ts";
import { parseReviewerOutput } from "./review-core.ts";

// =============================================================================
// Types
// =============================================================================

export interface ReviewOptions {
  task: string;
  userMessage: string;
  systemPrompt: string;
  cwd: string;
  model: Model<any>;
  modelRegistry: { find: (provider: string, modelId: string) => Model<any> | undefined };
  signal?: AbortSignal;
  timeoutMs: number;
  chunkCount: number;
}

// =============================================================================
// Manager
// =============================================================================

export class SubAgentManager {
  private activeSessions = new Set<AgentSession>();
  private disposed = false;

  /**
   * 执行一次 Reviewer 审查。
   *
   * 步骤:
   *  1. 创建 DefaultResourceLoader（最小化加载）
   *  2. 创建隔离 Session（inMemory、只读工具白名单）
   *  3. Promise.race 超时
   *  4. 传播 parent AbortSignal
   *  5. 解析输出、统计工具调用
   *  6. 清理
   */
  async review(options: ReviewOptions): Promise<ReviewResultUnion> {
    if (this.disposed) {
      return { kind: "session-create-failed", error: "Manager is disposed" };
    }

    const t0 = Date.now();
    const taskId = `review-${randomUUID()}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let session: AgentSession | undefined;

    try {
      // ── 1. Create minimal resource loader ──
      const resourceLoader = new DefaultResourceLoader({
        cwd: options.cwd,
        agentDir: "",
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      await resourceLoader.reload();

      // ── 2. Create isolated session ──
      const sessionResult = await createAgentSession({
        cwd: options.cwd,
        model: options.model,
        resourceLoader,
        sessionManager: SessionManager.inMemory(),
        tools: ["read", "grep", "find", "ls"],
      });

      session = sessionResult.session;
      this.activeSessions.add(session);

      // ── 3. Create the review promise ──
      const reviewPromise = this.runReview(session, options, t0, taskId);

      // ── 4. Create the timeout promise ──
      const timeoutPromise = new Promise<ReviewResultUnion>((resolve) => {
        timer = setTimeout(() => {
          timer = undefined;
          session?.abort().catch(() => {});
          resolve({ kind: "timeout" });
        }, options.timeoutMs);
      });

      // ── 5. Race — 调用方在 deadline 后必定返回 ──
      return await Promise.race([reviewPromise, timeoutPromise]);
    } catch (error: any) {
      if (error?.name === "AbortError") {
        return { kind: "aborted" };
      }
      return {
        kind: "session-create-failed",
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (session) {
        this.activeSessions.delete(session);
        try {
          session.dispose();
        } catch {
          // Dispose must not throw
        }
      }
    }
  }

  private async runReview(
    session: AgentSession,
    options: ReviewOptions,
    t0: number,
    taskId: string,
  ): Promise<ReviewResultUnion> {
    // ── Propagate parent AbortSignal ──
    const removeSignalHandler = options.signal
      ? this.propagateAbortSignal(session, options.signal)
      : undefined;

    try {
      // Run the prompt
      await session.prompt(options.userMessage);

      // Get the last assistant message text
      const lastText = this.getLastAssistantText(session);

      // Parse the output
      const parseResult = parseReviewerOutput(lastText);

      // Build telemetry
      const telemetry: ReviewerTelemetry = {
        totalChunks: options.chunkCount,
        parsedChunks: 0,
        failedChunks: 0,
        worktreeChanged: false,
      };

      if (!parseResult.ok) {
        return this.buildFailureResult(
          taskId,
          t0,
          toolCallCount(session),
          parseResult.failure,
          parseResult.error,
          parseResult.raw,
        );
      }

      // Success
      const coverage: ReviewCoverage = options.chunkCount <= 1 ? "complete" : "partial";

      const subagentResult: SubagentResult = {
        taskId,
        status: "success",
        summary: parseResult.review.summary,
        findings: parseResult.review.findings,
        changedFiles: [],
        durationMs: Date.now() - t0,
        toolCalls: toolCallCount(session),
        coverage,
        telemetry,
      };

      return { kind: "success", result: subagentResult };
    } catch (error: any) {
      // Distinguish aborted vs provider failure
      if (error?.name === "AbortError" || options.signal?.aborted) {
        return { kind: "aborted" };
      }
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.toLowerCase().includes("abort") || msg.toLowerCase().includes("signal")) {
        return { kind: "aborted" };
      }
      return { kind: "provider-failed", error: msg };
    } finally {
      removeSignalHandler?.();
    }
  }

  private propagateAbortSignal(session: AgentSession, signal: AbortSignal): () => void {
    if (signal.aborted) {
      session.abort().catch(() => {});
      return () => {};
    }
    const handler = () => {
      session.abort().catch(() => {});
    };
    signal.addEventListener("abort", handler, { once: true });
    return () => {
      signal.removeEventListener("abort", handler);
    };
  }

  private buildFailureResult(
    taskId: string,
    t0: number,
    tCalls: number,
    failureKind: ReviewerFailureKind,
    error: string,
    raw: string,
  ): ReviewResultUnion {
    if (failureKind === "parse-failed") {
      return { kind: "parse-failed", error, raw };
    }
    if (failureKind === "schema-failed") {
      return { kind: "schema-failed", error, raw };
    }
    return { kind: "provider-failed", error };
  }

  private getLastAssistantText(session: AgentSession): string {
    try {
      const text = session.getLastAssistantText();
      if (text) return text;
    } catch {
      // Fallback
    }
    try {
      const msgs = (session as any).agent?.state?.messages;
      if (Array.isArray(msgs)) {
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if (m?.role === "assistant") {
            const c = m.content;
            if (typeof c === "string") return c;
            if (Array.isArray(c)) {
              return c
                .filter((x: any) => x.type === "text")
                .map((x: any) => x.text)
                .join("\n");
            }
          }
        }
      }
    } catch {}
    return "";
  }

  /**
   * 幂等地 abort 并 dispose 所有活跃 Session
   */
  dispose(): void {
    this.disposed = true;
    for (const session of this.activeSessions) {
      try {
        session.abort().catch(() => {});
        session.dispose();
      } catch {
        // Dispose must not throw
      }
    }
    this.activeSessions.clear();
  }
}

// =============================================================================
// Utilities
// =============================================================================

function toolCallCount(session: AgentSession): number {
  try {
    const msgs = (session as any).agent?.state?.messages;
    if (Array.isArray(msgs)) {
      return msgs.filter(
        (m: any) =>
          m?.role === "assistant" &&
          Array.isArray(m?.content) &&
          m.content.some((c: any) => c.type === "tool_use"),
      ).length;
    }
  } catch {}
  return 0;
}
