/**
 * SubAgentManager
 *
 * 使用 Pi SDK createAgentSession() 创建隔离的只读 Reviewer SubAgent。
 *
 * 隔离:
 *  - tools: ["read","grep","find","ls"] — 只读白名单
 *  - SessionManager.inMemory() — 独立上下文，不持久化
 *  - Promise.race — 硬超时，调用方在 timeoutMs 后必定返回
 *
 * 超时语义:
 *  调用方在 timeoutMs 后必定拿回 timeoutResult。
 *  session.abort() 在后台触发协作式取消。
 *  如果 abort 没能让 prompt 立即结束，调用方也不等待。
 *  底层 Provider HTTP 请求可能继续，但调用方已释放。
 */

import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import type { SubagentResult, SubagentTask } from "./types.ts";

export class SubAgentManager {
  async review(
    task: SubagentTask,
    model: Model<any>,
  ): Promise<SubagentResult> {
    const t0 = Date.now();
    const taskId = task.id || `review-${randomUUID()}`;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;

    try {
      const result = await createAgentSession({
        cwd: task.workingDirectory,
        model,
        tools: ["read", "grep", "find", "ls"],
        sessionManager: SessionManager.inMemory(),
      });
      session = result.session;

      const reviewPrompt = [
        "You are a code reviewer. Review the provided changes.",
        "",
        "Rules:",
        "- Use read, grep, find, ls tools to investigate.",
        "- You do NOT have edit/write/bash access.",
        "- Output ONLY a JSON object, no markdown fences:",
        '  {"status":"passed"|"issues_found","summary":"...","findings":[{...}]}',
        "",
        "<task>",
        task.prompt,
        "</task>",
      ].join("\n");

      // ── reviewPromise: 自包含，自行捕获所有异常 ──
      const reviewPromise = (async (): Promise<SubagentResult> => {
        try {
          await session!.prompt(reviewPrompt);
          const lastText = getLastAssistantText(session!);
          const review = parseReviewOutput(lastText);
          return {
            taskId, status: "success",
            summary: review.summary, findings: review.findings,
            changedFiles: [], durationMs: Date.now() - t0,
            toolCalls: countToolCalls(session!),
          };
        } catch {
          return {
            taskId, status: "failed", summary: "", findings: [],
            changedFiles: [], durationMs: Date.now() - t0, toolCalls: 0,
          };
        }
      })();

      // ── timeoutPromise: timeoutMs 后必定 resolve ──
      const timeoutPromise = new Promise<SubagentResult>((resolve) => {
        timer = setTimeout(() => {
          timer = undefined;
          void session?.abort().catch(() => {});
          resolve({
            taskId, status: "timeout", summary: "", findings: [],
            changedFiles: [], durationMs: Date.now() - t0, toolCalls: 0,
          });
        }, task.timeoutMs);
      });

      // ── 竞速 ──
      return await Promise.race([reviewPromise, timeoutPromise]);
    } catch (error) {
      return {
        taskId, status: "failed", summary: "", findings: [],
        changedFiles: [], durationMs: Date.now() - t0, toolCalls: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (!disposed) {
        disposed = true;
        try { session?.dispose(); } catch {}
      }
    }
  }

  dispose(): void {}
}

// ═══════════════════════════════════════════════════════════════

function getLastAssistantText(session: any): string {
  try {
    if (typeof session.getLastAssistantText === "function") {
      return session.getLastAssistantText() || "";
    }
    const msgs = session.agent?.state?.messages;
    if (Array.isArray(msgs)) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i]?.role === "assistant") {
          const c = msgs[i].content;
          if (typeof c === "string") return c;
          if (Array.isArray(c)) return c.filter((x: any) => x.type === "text").map((x: any) => x.text).join("\n");
        }
      }
    }
  } catch {}
  return "";
}

function countToolCalls(session: any): number {
  try {
    const msgs = session.agent?.state?.messages;
    if (Array.isArray(msgs)) {
      return msgs.filter((m: any) =>
        m?.role === "assistant" &&
        Array.isArray(m?.content) &&
        m.content.some((c: any) => c.type === "tool_use"),
      ).length;
    }
  } catch {}
  return 0;
}

function parseReviewOutput(text: string): {
  status: "passed" | "issues_found" | "failed";
  summary: string;
  findings: Array<{ severity: "low" | "medium" | "high"; file?: string; line?: number; description: string }>;
} {
  if (!text.trim()) {
    return { status: "failed", summary: "No output from reviewer", findings: [] };
  }
  let json = text.trim();
  if (json.startsWith("```")) {
    json = json.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }
  try {
    const p = JSON.parse(json);
    return {
      status: p.status === "passed" || p.status === "issues_found" ? p.status : "failed",
      summary: typeof p.summary === "string" ? p.summary : "",
      findings: Array.isArray(p.findings)
        ? p.findings.map((f: any) => ({
            severity: (["low", "medium", "high"] as const).includes(f.severity)
              ? f.severity as "low" | "medium" | "high" : "medium" as const,
            file: typeof f.file === "string" ? f.file : undefined,
            line: typeof f.line === "number" ? f.line : undefined,
            description: typeof f.description === "string" ? f.description : "",
          }))
        : [],
    };
  } catch {
    return { status: "failed", summary: "Failed to parse reviewer output as JSON", findings: [] };
  }
}
