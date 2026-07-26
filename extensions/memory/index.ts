import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isMemoryCategory, MEMORY_CATEGORIES, type MemoryScope } from "./domain.ts";
import {
  createMemoryRepository,
  type FilesystemMemoryRepository,
} from "./repository.ts";
import { runExtraction, type ExtractionSnapshot } from "./extraction/coordinator.ts";
import { findCheckpoint, MEMORY_CHECKPOINT_TYPE } from "./extraction/source.ts";
import {
  buildWorkingSource,
  buildWorkingStateUpdate,
  findWorkingCheckpoint,
  renderScratchpad,
  WORKING_CHECKPOINT_TYPE,
  type WorkingStateUpdate,
} from "./working-state.ts";

// ═══════════════════════════════════════════════════════════════
// Per-extension-instance session state
// ═══════════════════════════════════════════════════════════════
// Each call to registerMemoryExtension owns its own SessionState.
// This prevents state leakage when Pi reloads or forks extensions.

class SessionState {
  /** Projects whose memory is hot (injected) this session. */
  readonly hot = new Set<string>();
  /** Projects whose memory is cold (blocked) this session. */
  readonly cold = new Set<string>();
  /** Per-branch working state carried forward from checkpoints. */
  readonly branchWorking = new Map<string, WorkingStateUpdate>();

  isHot(projectId: string): boolean {
    return this.hot.has(projectId) && !this.cold.has(projectId);
  }

  isCold(projectId: string): boolean {
    return this.cold.has(projectId);
  }

  markHot(projectId: string): void {
    this.hot.add(projectId);
    this.cold.delete(projectId);
  }

  markCold(projectId: string): void {
    this.cold.add(projectId);
    this.hot.delete(projectId);
  }

  reset(projectId: string): void {
    this.hot.delete(projectId);
    this.cold.delete(projectId);
  }
}

// ═══════════════════════════════════════════════════════════════
// Extraction scheduler
// ═══════════════════════════════════════════════════════════════

class ExtractionScheduler {
  private task: Promise<void> | undefined;
  private abort: AbortController | undefined;
  private generation = 0;
  private pending: ExtractionSnapshot | undefined;

  /** Start extraction; queue if one is already running. */
  start(
    snapshot: ExtractionSnapshot,
    repository: FilesystemMemoryRepository,
    appendCheckpoint: (checkpoint: Parameters<typeof runExtraction>[1] extends { signal: any } ? never : any) => void,
    onSettled: () => void,
  ): void {
    const gen = this.generation;
    if (this.task || this.abort) {
      // An extraction is in-flight: stash the latest snapshot and let the
      // running task's .finally() pick it up.
      this.pending = snapshot;
      return;
    }
    const controller = new AbortController();
    this.abort = controller;
    this.task = runExtraction(repository, snapshot, controller.signal)
      .then((result) => {
        // Only commit the checkpoint when:
        //  1. The generation hasn't been bumped (no tree switch / shutdown).
        //  2. The abort hasn't been signalled.
        if (result.checkpoint && gen === this.generation && !controller.signal.aborted) {
          // Snapshot the lastProcessedEntryId before appending so the pending
          // snapshot (if any) carries forward the right offset.
          if (this.pending?.sessionId === snapshot.sessionId) {
            this.pending.lastProcessedEntryId = result.checkpoint.lastEntryId;
          }
          appendCheckpoint(result.checkpoint);
        }
      })
      .catch(() => {
        // Extraction is fail-closed. A failed run never advances the
        // checkpoint so the delta is re-processed on the next settled event.
      })
      .finally(() => {
        // Clear the in-flight task first so the pending re-dispatch below
        // sees a free slot.
        if (this.abort === controller) this.abort = undefined;
        this.task = undefined;
        const next = this.pending;
        this.pending = undefined;
        onSettled();
        if (next) this.start(next, repository, appendCheckpoint, onSettled);
      });
  }

  /** Cancel in-flight extraction and increment generation. */
  cancel(): void {
    this.generation += 1;
    this.abort?.abort();
    this.pending = undefined;
  }

  /** Increment generation (for tree switches) without clearing pending. */
  bumpGeneration(): void {
    this.generation += 1;
    this.abort?.abort();
  }

  /** Flush and wait up to 1s for shutdown. */
  async shutdown(): Promise<void> {
    this.generation += 1;
    this.pending = undefined;
    this.abort?.abort();
    if (this.task) {
      await Promise.race([
        this.task,
        new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
      ]);
    }
  }

  get isRunning(): boolean {
    return this.task !== undefined;
  }
}

// ═══════════════════════════════════════════════════════════════
// Extension entry point
// ═══════════════════════════════════════════════════════════════

export function registerMemoryExtension(
  pi: ExtensionAPI,
  repository: FilesystemMemoryRepository = createMemoryRepository(),
): void {
  const state = new SessionState();
  const scheduler = new ExtractionScheduler();

  const saveMemoryTool = defineTool({
    name: "SaveMemory",
    label: "Save Memory",
    description: [
      "将用户明确要求记住的重要信息持久化，跨会话保留。",
      "每次保存都会向用户展示完整内容并请求确认。",
      "不要用于临时调试信息、中间过程或用户没有要求保存的内容。",
    ].join("\n"),
    promptSnippet: "save user-requested information after explicit confirmation",
    parameters: Type.Object({
      category: Type.String({
        description: `记忆分类：${MEMORY_CATEGORIES.join(", ")}`,
      }),
      title: Type.String({ description: "简短标题" }),
      content: Type.String({ description: "要持久化的完整内容" }),
      scope: Type.Optional(Type.String({
        description: "project（默认，仅当前项目）或 global（所有项目）",
      })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { category, title, content, scope } = params as {
        category: string;
        title: string;
        content: string;
        scope?: string;
      };

      if (!isMemoryCategory(category)) {
        return {
          content: [{ type: "text", text: `无效分类"${category}"。有效值：${MEMORY_CATEGORIES.join(", ")}` }],
          details: { saved: false, reason: "invalid-category" },
        };
      }
      if (!title.trim() || !content.trim()) {
        return {
          content: [{ type: "text", text: "标题和内容不能为空。" }],
          details: { saved: false, reason: "empty-input" },
        };
      }
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: "当前模式无法显示确认框，未保存记忆。" }],
          details: { saved: false, reason: "confirmation-unavailable" },
        };
      }

      const normalizedScope: MemoryScope = scope === "global" ? "global" : "project";
      const lifecycle = await repository.getProjectLifecycle(ctx.cwd);
      if (normalizedScope === "project" && (
        lifecycle.state === "cold" ||
        lifecycle.state === "archive-due" ||
        lifecycle.state === "archived" ||
        state.isCold(lifecycle.project.id)
      )) {
        return {
          content: [{ type: "text", text: "当前项目记忆处于冷态或已归档，请先使用 /memory-restore 恢复。" }],
          details: { saved: false, reason: "project-memory-cold" },
        };
      }
      const confirmed = await ctx.ui.confirm(
        "保存长期记忆？",
        [
          `作用域：${normalizedScope}`,
          `分类：${category}`,
          `标题：${title.trim()}`,
          "",
          content.trim(),
        ].join("\n"),
        { signal },
      );
      if (!confirmed) {
        return {
          content: [{ type: "text", text: "用户取消，未保存记忆。" }],
          details: { saved: false, reason: "user-declined" },
        };
      }

      try {
        const record = await repository.save({
          category,
          title,
          content,
          scope: normalizedScope,
          cwd: ctx.cwd,
          provenance: {
            source: "manual",
            sessionId: ctx.sessionManager.getSessionId(),
          },
        });
        return {
          content: [{ type: "text", text: `已保存长期记忆："${record.title}"（${record.scope}）` }],
          details: { saved: true, id: record.id, category: record.category, scope: record.scope },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `保存失败：${message}` }],
          details: { saved: false, reason: "storage-error" },
        };
      }
    },
  });

  const searchMemoryTool = defineTool({
    name: "SearchMemory",
    label: "Search Memory",
    description: "在当前项目和全局长期记忆中搜索关键词。",
    promptSnippet: "search current-project and global persistent memory",
    parameters: Type.Object({
      keyword: Type.String({ description: "搜索关键词" }),
      includeArchived: Type.Optional(Type.Boolean({
        description: "是否显式搜索当前项目的归档记忆，默认 false",
      })),
      scope: Type.Optional(Type.String({
        description: "long-term（默认）或 working（只搜索 Scratchpad/最近 Daily）",
      })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const { keyword: rawKeyword, includeArchived, scope } = params as {
        keyword: string;
        includeArchived?: boolean;
        scope?: string;
      };
      const keyword = rawKeyword.trim();
      if (!keyword) {
        return {
          content: [{ type: "text", text: "搜索关键词不能为空。" }],
          details: { keyword, count: 0 },
        };
      }

      try {
        if (scope === "working") {
          const lifecycle = await repository.getProjectLifecycle(ctx.cwd);
          const visible = lifecycle.state === "hot" && !state.isCold(lifecycle.project.id);
          const working = visible ? await repository.searchWorkingState(keyword, ctx.cwd) : [];
          return {
            content: [{
              type: "text",
              text: working.length === 0
                ? `未在工作状态中找到"${keyword}"。`
                : working.map((result) => `### ${result.source}\n\n${result.content}`).join("\n\n---\n\n"),
            }],
            details: { keyword, count: working.length, scope: "working" },
          };
        }
        const lifecycle = await repository.getProjectLifecycle(ctx.cwd);
        const projectVisible = (
          lifecycle.state === "hot" || state.hot.has(lifecycle.project.id)
        ) && !state.isCold(lifecycle.project.id);
        const results = await repository.search(keyword, ctx.cwd, {
          includeArchived: includeArchived === true,
          includeProject: projectVisible,
        });
        if (results.length === 0) {
          return {
            content: [{ type: "text", text: `未找到与"${keyword}"相关的记忆。` }],
            details: { keyword, count: 0 },
          };
        }
        const formatted = results.map(({ record, archived }, index) => [
          `### ${index + 1}. ${record.title}`,
          `**作用域**：${record.scope}${archived ? "（归档）" : ""}　**分类**：${record.category}`,
          "",
          record.content,
        ].join("\n")).join("\n\n---\n\n");
        return {
          content: [{ type: "text", text: `找到 ${results.length} 条记忆：\n\n${formatted}` }],
          details: { keyword, count: results.length },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `搜索失败：${message}` }],
          details: { keyword, count: 0, error: true },
        };
      }
    },
  });

  pi.registerTool(saveMemoryTool);
  pi.registerTool(searchMemoryTool);

  // ── Lifecycle hooks ──────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    const branchCheckpoint = findWorkingCheckpoint(ctx.sessionManager.getBranch());
    if (branchCheckpoint?.state) {
      state.branchWorking.set(ctx.sessionManager.getSessionId(), branchCheckpoint.state);
    } else {
      state.branchWorking.delete(ctx.sessionManager.getSessionId());
    }
    const lifecycle = await repository.getProjectLifecycle(ctx.cwd);
    state.reset(lifecycle.project.id);

    if (lifecycle.state === "archive-due") {
      await repository.archiveProject(ctx.cwd);
      state.markCold(lifecycle.project.id);
      if (ctx.hasUI) {
        ctx.ui.notify(`项目记忆已闲置 ${lifecycle.inactivityDays} 天，已无损归档。`, "info");
      }
      return;
    }
    if (lifecycle.state === "archived") {
      state.markCold(lifecycle.project.id);
      if (ctx.hasUI) ctx.ui.notify("当前项目记忆已归档，可用 /memory-restore 恢复。", "info");
      return;
    }
    if (lifecycle.state === "cold") {
      if (!ctx.hasUI) {
        state.markCold(lifecycle.project.id);
        return;
      }
      const restore = await ctx.ui.confirm(
        "恢复项目热记忆？",
        `该项目已 ${lifecycle.inactivityDays} 天未使用。恢复后，本 session 会注入项目记忆；选择 No 将保持冷态。`,
      );
      if (!restore) {
        state.markCold(lifecycle.project.id);
        return;
      }
    }

    await repository.markProjectActive(ctx.cwd);
    state.markHot(lifecycle.project.id);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    let lifecycle = await repository.getProjectLifecycle(ctx.cwd);
    const sessionIsHot = state.isHot(lifecycle.project.id);
    if (sessionIsHot && lifecycle.state !== "archived") {
      await repository.markProjectActive(ctx.cwd);
      lifecycle = await repository.getProjectLifecycle(ctx.cwd);
    }
    const includeProject = (
      lifecycle.state === "hot" || state.hot.has(lifecycle.project.id)
    ) && !state.isCold(lifecycle.project.id);
    const branchState = state.branchWorking.get(ctx.sessionManager.getSessionId());
    const contextWindow = ctx.model?.contextWindow || 32_000;
    const workingCharBudget = Math.max(1_000, Math.min(8_000, Math.floor(contextWindow * 0.2)));
    const memoryCharBudget = Math.max(2_000, Math.min(12_000, Math.floor(contextWindow * 0.3)));
    const [memory, storedWorking] = await Promise.all([
      repository.buildPrompt(ctx.cwd, { includeProject, maxChars: memoryCharBudget }),
      repository.loadWorkingState(ctx.cwd, includeProject && !branchState),
    ]);
    const working = branchState
      ? { scratchpad: renderScratchpad(branchState), recentDaily: "", project: lifecycle.project }
      : storedWorking;
    working.scratchpad = working.scratchpad.slice(0, Math.floor(workingCharBudget * 0.6));
    working.recentDaily = working.recentDaily.slice(-Math.floor(workingCharBudget * 0.4));
    const workingPrompt = working.scratchpad || working.recentDaily
      ? [
          "## Working State",
          "",
          "This is recent, temporary project state. Do not treat it as durable truth or automatically promote it to long-term memory.",
          working.scratchpad ? `\n### Scratchpad\n\n${working.scratchpad}` : "",
          working.recentDaily ? `\n### Recent Daily\n\n${working.recentDaily}` : "",
        ].join("\n")
      : "";
    if (!memory.prompt && !workingPrompt) return;
    return {
      systemPrompt: [event.systemPrompt, memory.prompt, workingPrompt].filter(Boolean).join("\n\n"),
    };
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!ctx.model) return;
    const lifecycle = await repository.getProjectLifecycle(ctx.cwd);
    if (lifecycle.state !== "hot" || state.isCold(lifecycle.project.id)) return;
    const branch = ctx.sessionManager.getBranch();
    const workingSource = buildWorkingSource(branch, ctx.sessionManager.getLeafId());
    if (workingSource) {
      const update = buildWorkingStateUpdate(
        workingSource,
        ctx.sessionManager.getSessionId(),
        new Date(),
      );
      if (update) {
        try {
          await repository.saveWorkingState(ctx.cwd, update);
          state.branchWorking.set(ctx.sessionManager.getSessionId(), update);
          pi.appendEntry(WORKING_CHECKPOINT_TYPE, {
            version: update.version,
            sourceHash: update.sourceHash,
            lastEntryId: update.lastEntryId,
            branchLeafId: update.branchLeafId,
            state: update,
          });
        } catch {
          // Working state is derived and must not block long-term extraction.
        }
      }
    }
    const snapshot: ExtractionSnapshot = {
      cwd: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId(),
      branch,
      branchLeafId: ctx.sessionManager.getLeafId(),
      lastProcessedEntryId: findCheckpoint(branch)?.lastEntryId,
      model: ctx.model,
      modelRegistry: ctx.modelRegistry,
    };
    scheduler.start(snapshot, repository, (checkpoint) => {
      pi.appendEntry(MEMORY_CHECKPOINT_TYPE, checkpoint);
    }, () => {
      // Extraction settled — nothing to do here.
    });
  });

  pi.on("session_tree", async (_event, ctx) => {
    scheduler.bumpGeneration();
    const checkpoint = findWorkingCheckpoint(ctx.sessionManager.getBranch());
    if (checkpoint?.state) {
      state.branchWorking.set(ctx.sessionManager.getSessionId(), checkpoint.state);
      await repository.setWorkingLatest(ctx.cwd, checkpoint.state);
    } else {
      state.branchWorking.delete(ctx.sessionManager.getSessionId());
      await repository.setWorkingLatest(ctx.cwd);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    state.branchWorking.delete(ctx.sessionManager.getSessionId());
    await scheduler.shutdown();
  });

  // ── Commands ──────────────────────────────────────────────────

  pi.registerCommand("memory-status", {
    description: "Show current project memory lifecycle status",
    handler: async (_args, ctx) => {
      const diagnostics = await repository.diagnose(ctx.cwd);
      ctx.ui.notify(
        [
          `Memory: ${diagnostics.lifecycle}; inactive ${diagnostics.inactivityDays} day(s)`,
          `Project: ${diagnostics.project.id}`,
          `Schema: v${diagnostics.schemaVersion}; root mode: ${diagnostics.permissions}`,
          `Long-term: ${diagnostics.longTermCount}; extraction manifests: ${diagnostics.extractionManifestCount}`,
          `Working: ${diagnostics.hasScratchpad ? "scratchpad" : "none"}; manifests: ${diagnostics.workingManifestCount}`,
        ].join("\n"),
        "info",
      );
    },
  });

  pi.registerCommand("memory-archive", {
    description: "Archive current project memory without deleting it",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const confirmed = await ctx.ui.confirm(
        "归档项目记忆？",
        "归档后不会进入系统提示词或普通搜索；文件不会被删除，可随时恢复。",
      );
      if (!confirmed) return;
      const metadata = await repository.archiveProject(ctx.cwd);
      if (!metadata) {
        ctx.ui.notify("当前项目没有可归档的记忆。", "info");
        return;
      }
      state.markCold(metadata.projectId);
      ctx.ui.notify("项目记忆已归档。", "info");
    },
  });

  pi.registerCommand("memory-restore", {
    description: "Restore current project memory from the archive",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const confirmed = await ctx.ui.confirm(
        "恢复项目记忆？",
        "恢复后，当前项目记忆会重新进入热上下文和普通搜索。",
      );
      if (!confirmed) return;
      const lifecycle = await repository.getProjectLifecycle(ctx.cwd);
      const metadata = lifecycle.state === "archived"
        ? await repository.restoreProject(ctx.cwd)
        : lifecycle.state === "cold" || lifecycle.state === "archive-due"
          ? await repository.markProjectActive(ctx.cwd)
          : undefined;
      if (!metadata) {
        ctx.ui.notify("当前项目没有冷态或归档记忆。", "info");
        return;
      }
      state.markHot(metadata.projectId);
      ctx.ui.notify("项目记忆已恢复。", "info");
    },
  });
}

export default function memoryExtension(pi: ExtensionAPI): void {
  registerMemoryExtension(pi);
}
