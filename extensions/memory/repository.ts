import { randomUUID, createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { lock } from "proper-lockfile";
import {
  isMemoryCategory,
  MEMORY_RECORD_SCHEMA_VERSION,
  type MemoryCategory,
  type MemoryProvenance,
  type MemoryRecord,
  type MemoryRecordV1,
  type MemoryRevision,
  type MemoryScope,
  type MemorySearchResult,
  type ProjectMemoryMetadata,
} from "./domain.ts";
import { resolveProjectIdentity, type ProjectIdentity } from "./project-identity.ts";
import {
  DAILY_MAX_CHARS,
  MAX_SAMEDAY_ENTRIES,
  PRUNE_DAILY_DAYS,
  PRUNE_EXTRACTION_DAYS,
  PRUNE_MAX_FILES,
  PRUNE_REVISION_KEEP,
  PRUNE_WORKING_DAYS,
  SCRATCHPAD_MAX_CHARS,
  parseWorkingLatest,
  parseWorkingStateUpdate,
  renderDailyEntry,
  renderScratchpad,
  serializeWorkingLatestIndex,
  parseWorkingLatestIndex,
  WORKING_INDEX_SCHEMA_VERSION,
  type WorkingLatestIndex,
  type WorkingStateUpdate,
} from "./working-state.ts";
import { containsSecret, describeRejection, validateKeywords, validateMemoryWrite } from "./validation.ts";
import { tokenize } from "./extraction/tokenize.ts";

const RECORD_START = "<!-- triple-pi-memory";
const RECORD_END = "-->";
const DEFAULT_PROMPT_ENTRY_LIMIT = 50;
const DEFAULT_PROMPT_CHAR_LIMIT = 12_000;
/** 3c M5：searchWorkingState 补扫的历史 daily 天数（不含最新一天）。 */
const WORKING_SEARCH_DAILY_WINDOW = 7;

export interface MemoryRepositoryOptions {
  root?: string;
  now?: () => Date;
  /** Test seam for deterministic write-failure injection. */
  beforeWrite?: (filepath: string) => void | Promise<void>;
}

export interface SaveMemoryInput {
  category: MemoryCategory;
  scope: MemoryScope;
  cwd: string;
  title: string;
  content: string;
  provenance?: MemoryProvenance;
  replaceRecordId?: string;
  /** 3a M3: optional retrieval keywords (aliases/synonyms/acronyms). */
  keywords?: string[];
}

export interface MemoryPrompt {
  prompt: string;
  count: number;
  project: ProjectIdentity;
}

export interface MemoryDiagnostics {
  root: string;
  schemaVersion: number;
  project: ProjectIdentity;
  lifecycle: ProjectLifecycleState;
  inactivityDays: number;
  longTermCount: number;
  hasScratchpad: boolean;
  hasRecentDaily: boolean;
  extractionManifestCount: number;
  workingManifestCount: number;
  permissions: string;
  /** Whether extraction is currently running for this project. */
  extractionRunning: boolean;
  /** Whether extraction has a pending (queued) run. */
  extractionPending: boolean;
  /** ISO timestamp of the last extraction attempt (any outcome). */
  lastExtractionAttemptAt?: string;
  /** ISO timestamp of the last successful extraction. */
  lastExtractionSuccessAt?: string;
  /** ISO timestamp of the last failed extraction. */
  lastExtractionFailureAt?: string;
  /** Stage at which the last extraction failure occurred. */
  lastExtractionFailureStage?: string;
  /** Error code of the last extraction failure. */
  lastExtractionFailureCode?: string;
  /** Consecutive extraction failures (resets on success). */
  consecutiveExtractionFailures: number;
  /** Number of records that were too corrupt to read. */
  corruptRecordCount: number;
  /** Number of batch-commit rollback failures. */
  rollbackFailureCount: number;
}

export interface WorkingStateView {
  scratchpad: string;
  recentDaily: string;
  project: ProjectIdentity;
}

export type ProjectLifecycleState = "new" | "hot" | "cold" | "archive-due" | "archived";

export interface ProjectLifecycle {
  state: ProjectLifecycleState;
  inactivityDays: number;
  project: ProjectIdentity;
  metadata?: ProjectMemoryMetadata;
}

export interface ProjectMemoryView {
  lifecycle: ProjectLifecycle;
  records: MemoryRecord[];
}

export interface ReinforcementState {
  count: number;
  updatedAt: string;
}

export interface SearchMemoryOptions {
  max?: number;
  includeArchived?: boolean;
  includeProject?: boolean;
  /** 3d M6: filter to one category. Invalid values are ignored (no filter). */
  category?: string;
}

export interface ListMemoryOptions {
  includeArchived?: boolean;
  includeProject?: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function defaultRoot(): string {
  return process.env.TRIPLE_PI_MEMORY_ROOT || path.join(homedir(), ".triple-pi", "memory-v1");
}

function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ");
}

function recordId(scope: MemoryScope, projectId: string, category: MemoryCategory, title: string): string {
  return createHash("sha256")
    .update(`${scope}\0${projectId}\0${category}\0${title.toLocaleLowerCase()}`)
    .digest("hex")
    .slice(0, 32);
}

function serializeRecord(record: MemoryRecord): string {
  const metadata = JSON.stringify({ ...record, content: undefined });
  return `${RECORD_START}\n${metadata}\n${RECORD_END}\n\n# ${record.title}\n\n${record.content.trim()}\n`;
}

function parseRecord(raw: string, filepath: string, diagnostics?: { corruptRecordCount: number }): MemoryRecord {
  if (!raw.startsWith(`${RECORD_START}\n`)) throw new Error(`Invalid memory record: ${filepath}`);
  const end = raw.indexOf(`\n${RECORD_END}\n`);
  if (end < 0) throw new Error(`Invalid memory metadata: ${filepath}`);

  const metadataRaw = raw.slice(RECORD_START.length + 1, end);
  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(metadataRaw) as Record<string, unknown>;
  } catch {
    throw new Error(`Invalid memory JSON metadata: ${filepath}`);
  }

  // Deep validation
  const schemaVersion = metadata["schemaVersion"];
  if (typeof schemaVersion !== "number" || schemaVersion < 1) {
    throw new Error(`Invalid or missing schemaVersion in ${filepath}`);
  }
  if (schemaVersion > MEMORY_RECORD_SCHEMA_VERSION) {
    // Unknown future version — this record cannot be read safely
    throw new Error(`Unknown future schema version ${schemaVersion} in ${filepath}`);
  }

  const id = metadata["id"];
  if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id)) {
    throw new Error(`Invalid record id in ${filepath}`);
  }

  const category = metadata["category"];
  if (typeof category !== "string" || !isMemoryCategory(category)) {
    throw new Error(`Invalid or missing memory category in ${filepath}`);
  }

  const scope = metadata["scope"];
  if (scope !== "global" && scope !== "project") {
    throw new Error(`Invalid memory scope in ${filepath}`);
  }

  const projectId = metadata["projectId"];
  if (typeof projectId !== "string" || !projectId.trim()) {
    throw new Error(`Invalid or missing projectId in ${filepath}`);
  }

  const createdAt = metadata["createdAt"];
  if (typeof createdAt !== "string" || !createdAt) {
    throw new Error(`Invalid or missing createdAt in ${filepath}`);
  }

  const updatedAt = metadata["updatedAt"];
  if (typeof updatedAt !== "string" || !updatedAt) {
    throw new Error(`Invalid or missing updatedAt in ${filepath}`);
  }

  const provenanceRaw = metadata["provenance"];
  if (!provenanceRaw || typeof provenanceRaw !== "object") {
    throw new Error(`Invalid or missing provenance in ${filepath}`);
  }

  const body = raw.slice(end + `\n${RECORD_END}\n\n`.length);
  const titleEnd = body.indexOf("\n\n");
  if (!body.startsWith("# ") || titleEnd < 0) throw new Error(`Invalid memory body: ${filepath}`);

  const title = body.slice(2, titleEnd).trim();
  const content = body.slice(titleEnd + 2).trim();
  if (!title || !content) throw new Error(`Empty title or content in ${filepath}`);

  // V1 compatibility: fill missing fields
  if (schemaVersion === 1) {
    const v1Record = metadata as unknown as MemoryRecordV1;
    // Upgrade to V2: add evidence, scopeDecision, revision fields
    const provenance = {
      ...v1Record.provenance,
      evidence: [] as [],
      scopeDecision: undefined,
      revision: undefined,
    };
    return {
      schemaVersion: MEMORY_RECORD_SCHEMA_VERSION as 2,
      id,
      category: category as any,
      scope: scope as any,
      projectId,
      title,
      content,
      createdAt,
      updatedAt,
      provenance,
    };
  }

  // V2+ record — return as-is
  // 3a M3：宽容归一。非法/缺失的 keywords 不拒记录，只丢弃字段。
  const keywords = validateKeywords(metadata["keywords"]);
  return {
    ...(metadata as Omit<MemoryRecord, "content" | "title">),
    schemaVersion: MEMORY_RECORD_SCHEMA_VERSION as 2,
    title,
    content,
    ...(keywords ? { keywords } : {}),
  };
}

async function exists(filepath: string): Promise<boolean> {
  try {
    await fs.access(filepath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export class FilesystemMemoryRepository {
  readonly root: string;
  private readonly now: () => Date;
  private readonly beforeWrite?: (filepath: string) => void | Promise<void>;
  private extractionRunning = false;
  private extractionPending = false;
  private lastExtractionAttemptAt?: string;
  private lastExtractionSuccessAt?: string;
  private lastExtractionFailureAt?: string;
  private lastExtractionFailureStage?: string;
  private lastExtractionFailureCode?: string;
  private consecutiveExtractionFailures = 0;
  private rollbackFailureCount = 0;

  // 2b P1 记录缓存：把 listBase 的 O(N) 目录遍历 + N 次 readFile/parseRecord
  // 变成进程内命中即返。parseRecord 是纯函数、确定性，无 TTL 需求；now() 不在
  // 读路径上 → 过期向量只有「记录文件被改写」。进程内写路径直接删片；跨进程写
  // 由 .cache-stamp 写令牌覆盖（mtime 在 WSL2/NFS 不可靠，不用时间判过期）。
  // 详见 docs/technical/14-audit-memory-retrieval-and-reviewer.md §8 (2b)。
  private readonly recordCache = new Map<string, { records: MemoryRecord[]; stampAtLoad: string }>();
  private cacheStampSeq = 0;
  /** 写放大小修：每次 save 全量重建 MEMORY.md 是 O(N) 写放大（1k 条 169ms）。
   *  MEMORY.md 是派生便利索引（无生产代码读取——已核实），改为脏标记 + 延迟重建：
   *  写路径只标记，session_start/memory-status/显式 rebuildIndex 时刷新。 */
  private readonly pendingIndexRebuild = new Set<string>();
  private static readonly CACHE_STAMP_NAME = ".cache-stamp";

  constructor(options: MemoryRepositoryOptions = {}) {
    this.root = path.resolve(options.root || defaultRoot());
    this.now = options.now || (() => new Date());
    this.beforeWrite = options.beforeWrite;
  }

  updateExtractionDiagnostics(update: {
    running?: boolean;
    pending?: boolean;
    attempted?: boolean;
    succeeded?: boolean;
    failureStage?: string;
    failureCode?: string;
  }): void {
    const timestamp = this.now().toISOString();
    if (update.running !== undefined) this.extractionRunning = update.running;
    if (update.pending !== undefined) this.extractionPending = update.pending;
    if (update.attempted) this.lastExtractionAttemptAt = timestamp;
    if (update.succeeded) {
      this.lastExtractionSuccessAt = timestamp;
      this.consecutiveExtractionFailures = 0;
      this.lastExtractionFailureStage = undefined;
      this.lastExtractionFailureCode = undefined;
    }
    if (update.failureStage || update.failureCode) {
      this.lastExtractionFailureAt = timestamp;
      this.lastExtractionFailureStage = update.failureStage;
      this.lastExtractionFailureCode = update.failureCode;
      this.consecutiveExtractionFailures += 1;
    }
  }

  async save(input: SaveMemoryInput): Promise<MemoryRecord> {
    // Validate via shared validator
    const validated = validateMemoryWrite(
      { category: input.category, title: input.title, content: input.content, scope: input.scope, keywords: input.keywords },
      { source: "manual" },
    );
    if ("kind" in validated) {
      throw new Error(describeRejection(validated));
    }

    // Manual secret/size guard before any disk I/O
    if (containsSecret(validated.title) || containsSecret(validated.content)) {
      throw new Error("Content contains potential secrets; rejected");
    }

    const project = resolveProjectIdentity(input.cwd);
    const projectId = input.scope === "global" ? "global" : project.id;
    const title = validated.title;
    const content = validated.content;
    const id = recordId(input.scope, projectId, validated.category as any, title);

    return this.withWriteLock(async () => {
      if (input.scope === "project" && await exists(this.archivedProjectPath(project.id))) {
        throw new Error("Project memory is archived; restore it before saving");
      }
      const filepath = this.recordPath(input.scope, project.id, validated.category as any, id);
      const previous = await this.readFileIfPresent(filepath);
      const timestamp = this.now().toISOString();

      const previousRevisionId = previous?.provenance.revision?.revisionId ?? (previous ? randomUUID() : undefined);
      const headRevisionId = randomUUID();

      // The snapshot ID is exactly the prior head pointer, making the chain traversable.
      if (previous && previousRevisionId) {
        const revision: MemoryRevision = {
          schemaVersion: 2,
          revisionId: previousRevisionId,
          recordId: id,
          title: previous.title,
          content: previous.content,
          provenance: previous.provenance,
          createdAt: previous.createdAt,
          capturedAt: timestamp,
        };
        const revisionDir = path.join(this.basePath(input.scope, project.id), "revisions", id);
        await this.atomicWrite(
          path.join(revisionDir, `${previousRevisionId}.md`),
          `${JSON.stringify(revision, null, 2)}\n`,
        );
      }

      const record: MemoryRecord = {
        schemaVersion: MEMORY_RECORD_SCHEMA_VERSION,
        id,
        category: validated.category as any,
        scope: input.scope,
        projectId,
        title,
        content,
        createdAt: previous?.createdAt || timestamp,
        updatedAt: timestamp,
        provenance: {
          ...(input.provenance || { source: "manual" }),
          revision: {
            revisionId: headRevisionId,
            previousRevisionId,
          },
        },
        ...(validated.keywords ? { keywords: validated.keywords } : {}),
      };

      await this.atomicWrite(filepath, serializeRecord(record));
      if (input.scope === "project") {
        await this.writeActiveMetadataUnlocked(project);
      }
      // MEMORY.md is a derived convenience index (no production reader) — mark
      // dirty instead of rebuilding per save (O(N) write amplification).
      this.pendingIndexRebuild.add(this.basePath(input.scope, project.id));
      await this.invalidateCacheSlicesUnlocked(input.scope === "global" ? ["global"] : [`project:${project.id}`]);
      return record;
    });
  }

  async saveWorkingState(cwd: string, update: WorkingStateUpdate): Promise<boolean> {
    const project = resolveProjectIdentity(cwd);
    return this.withWriteLock(async () => {
      if (await exists(this.archivedProjectPath(project.id))) throw new Error("Project memory is archived");
      const base = this.basePath("project", project.id);
      const manifest = this.workingManifestPath(project.id, update.sourceHash);
      const isNew = !(await exists(manifest));
      if (isNew) await this.atomicWrite(manifest, `${JSON.stringify(update, null, 2)}\n`);

      // 2a P3: replaced the O(M) readdir+parse-all scan with an O(1) index read +
      // increment-merge. The manifest above is written before this read so a rebuild
      // fallback (missing/corrupt/count-mismatch index) always counts it. The index
      // preserves the legacy semantics: latestUpdate = max(updatedAt) across all
      // manifests; sameDay = entries whose date === incoming date.
      const manifestsDir = path.dirname(manifest);
      const index = await this.loadLatestIndexUnlocked(project.id, manifestsDir, isNew ? 1 : 0);
      const merged = await this.mergeLatestIndexUnlocked(index, update, manifestsDir, project.id);
      await this.writeLatestIndexUnlocked(project.id, merged);
      const latestUpdate = merged.latestUpdate;
      const sameDay = merged.sameDayEntries;

      const sessionKey = createHash("sha256").update(update.sessionId).digest("hex").slice(0, 24);
      const latestSessionKey = createHash("sha256").update(latestUpdate.sessionId).digest("hex").slice(0, 24);
      await this.atomicWrite(
        path.join(base, "working", "sessions", sessionKey, "SCRATCHPAD.md"),
        renderScratchpad(update),
      );
      await this.atomicWrite(
        path.join(base, "working", "latest.json"),
        `${JSON.stringify({ sessionKey: latestSessionKey, update: latestUpdate }, null, 2)}\n`,
      );

      let dailyContent = `# Daily · ${update.date}\n\n${sameDay.map(renderDailyEntry).join("\n")}`;
      if (dailyContent.length > DAILY_MAX_CHARS) {
        dailyContent = `# Daily · ${update.date}\n\n${dailyContent.slice(dailyContent.length - DAILY_MAX_CHARS + 24)}`;
      }
      await this.atomicWrite(
        path.join(base, "daily", `${update.date}.md`),
        `${dailyContent.trimEnd()}\n`,
      );
      return isNew;
    });
  }

  async diagnose(cwd: string): Promise<MemoryDiagnostics> {
    const project = resolveProjectIdentity(cwd);
    if (!(await exists(this.root))) {
      return {
        root: this.root, schemaVersion: MEMORY_RECORD_SCHEMA_VERSION, project,
        lifecycle: "new", inactivityDays: 0, longTermCount: 0,
        hasScratchpad: false, hasRecentDaily: false,
        extractionManifestCount: 0, workingManifestCount: 0, permissions: "missing",
        extractionRunning: this.extractionRunning, extractionPending: this.extractionPending,
        lastExtractionAttemptAt: this.lastExtractionAttemptAt,
        lastExtractionSuccessAt: this.lastExtractionSuccessAt,
        lastExtractionFailureAt: this.lastExtractionFailureAt,
        lastExtractionFailureStage: this.lastExtractionFailureStage,
        lastExtractionFailureCode: this.lastExtractionFailureCode,
        consecutiveExtractionFailures: this.consecutiveExtractionFailures,
        corruptRecordCount: 0, rollbackFailureCount: this.rollbackFailureCount,
      };
    }

    // Archive consistency: check archive position before and after
    const archivedBefore = await exists(this.archivedProjectPath(project.id));
    const activeBase = this.basePath("project", project.id);
    const archivedBase = this.archivedProjectPath(project.id);
    const archived = archivedBefore;
    const base = archived ? archivedBase : activeBase;

    const [metadata, recordsResult] = await Promise.all([
      this.readMetadata(base),
      this.listBaseWithDiagnostics(base),
    ]);

    // Re-check archive position
    const archivedAfter = await exists(this.archivedProjectPath(project.id));
    if (archivedBefore !== archivedAfter) {
      // Archive position changed — retry once
      const retryBase = archivedAfter ? archivedBase : activeBase;
      const [retryMeta, retryRecords] = await Promise.all([
        this.readMetadata(retryBase),
        this.listBaseWithDiagnostics(retryBase),
      ]);
      return this.buildDiagnostics(project, retryMeta ?? undefined, retryRecords, retryBase, archivedAfter);
    }

    return this.buildDiagnostics(project, metadata ?? undefined, recordsResult, base, archived);
  }

  private async buildDiagnostics(
    project: ProjectIdentity,
    metadata: ProjectMemoryMetadata | undefined,
    recordsResult: { records: MemoryRecord[]; corruptRecordCount: number },
    base: string,
    archived: boolean,
  ): Promise<MemoryDiagnostics> {
    const inactivityMs = metadata ? this.inactivityMs(metadata.lastActiveAt) : 0;
    const lifecycle: ProjectLifecycleState = archived
      ? "archived"
      : !metadata ? "new"
      : inactivityMs > 90 * DAY_MS ? "archive-due"
      : inactivityMs > 30 * DAY_MS ? "cold" : "hot";
    const latest = path.join(base, "working", "latest.json");
    const dailyDir = path.join(base, "daily");
    const countJson = async (dir: string): Promise<number> => {
      if (!(await exists(dir))) return 0;
      return (await fs.readdir(dir)).filter((name) => name.endsWith(".json")).length;
    };
    let hasRecentDaily = false;
    if (await exists(dailyDir)) {
      hasRecentDaily = (await fs.readdir(dailyDir)).some((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name));
    }
    return {
      root: this.root,
      schemaVersion: MEMORY_RECORD_SCHEMA_VERSION,
      project,
      lifecycle,
      inactivityDays: Math.floor(inactivityMs / DAY_MS),
      longTermCount: recordsResult.records.length,
      hasScratchpad: await exists(latest),
      hasRecentDaily,
      extractionManifestCount: await countJson(path.join(this.root, "extractions", project.id)),
      workingManifestCount: await countJson(path.join(this.root, "working-manifests", project.id)),
      permissions: (await fs.stat(this.root)).mode.toString(8).slice(-3),
      extractionRunning: this.extractionRunning,
      extractionPending: this.extractionPending,
      lastExtractionAttemptAt: this.lastExtractionAttemptAt,
      lastExtractionSuccessAt: this.lastExtractionSuccessAt,
      lastExtractionFailureAt: this.lastExtractionFailureAt,
      lastExtractionFailureStage: this.lastExtractionFailureStage,
      lastExtractionFailureCode: this.lastExtractionFailureCode,
      consecutiveExtractionFailures: this.consecutiveExtractionFailures,
      corruptRecordCount: recordsResult.corruptRecordCount,
      rollbackFailureCount: this.rollbackFailureCount,
    };
  }

  async setWorkingLatest(cwd: string, update?: WorkingStateUpdate): Promise<void> {
    const project = resolveProjectIdentity(cwd);
    await this.withWriteLock(async () => {
      if (await exists(this.archivedProjectPath(project.id))) return;
      const latest = path.join(this.basePath("project", project.id), "working", "latest.json");
      if (!update) {
        await fs.rm(latest, { force: true });
        return;
      }
      const sessionKey = createHash("sha256").update(update.sessionId).digest("hex").slice(0, 24);
      await this.atomicWrite(latest, `${JSON.stringify({ sessionKey, update }, null, 2)}\n`);
    });
  }

  async loadWorkingState(cwd: string, includeProject = true): Promise<WorkingStateView> {
    const project = resolveProjectIdentity(cwd);
    if (!includeProject) return { scratchpad: "", recentDaily: "", project };
    // Archive consistency
    const archivedBefore = await exists(this.archivedProjectPath(project.id));
    const base = this.basePath("project", project.id);
    const latestPath = path.join(base, "working", "latest.json");
    const dailyDir = path.join(base, "daily");
    let scratchpad = "";
    if (await exists(latestPath)) {
      try {
        const raw = JSON.parse(await fs.readFile(latestPath, "utf8"));
        try {
          const parsed = parseWorkingLatest(raw);
          if (parsed.update) scratchpad = renderScratchpad(parsed.update);
        } catch {
          // Fall back to relaxed parsing for backward compat
          const latest = raw as { update?: WorkingStateUpdate };
          if (latest.update) scratchpad = renderScratchpad(latest.update);
        }
      } catch {}
    }
    let recentDaily = "";
    if (await exists(dailyDir)) {
      const files = (await fs.readdir(dailyDir)).filter((file) => /^\d{4}-\d{2}-\d{2}\.md$/.test(file)).sort().reverse();
      if (files[0]) recentDaily = await fs.readFile(path.join(dailyDir, files[0]), "utf8");
    }
    if (archivedBefore !== await exists(this.archivedProjectPath(project.id))) {
      // Retry once
      return this.loadWorkingState(cwd, includeProject);
    }
    return {
      scratchpad: scratchpad.slice(0, SCRATCHPAD_MAX_CHARS),
      recentDaily: recentDaily.slice(-Math.min(DAILY_MAX_CHARS, 12_000)),
      project,
    };
  }

  async searchWorkingState(keyword: string, cwd: string): Promise<{ source: "scratchpad" | "daily"; content: string; date: string }[]> {
    const query = keyword.trim().toLocaleLowerCase();
    if (!query) return [];
    const state = await this.loadWorkingState(cwd);
    const results: { source: "scratchpad" | "daily"; content: string; date: string }[] = [];
    // 3c M5：结果带日期标注（审计 §3.3-M5 验收要求）。
    if (state.scratchpad.toLocaleLowerCase().includes(query)) {
      results.push({ source: "scratchpad", content: state.scratchpad, date: state.scratchpad.match(/Updated: (\d{4}-\d{2}-\d{2})/)?.[1] ?? "" });
    }
    if (state.recentDaily.toLocaleLowerCase().includes(query)) {
      results.push({ source: "daily", content: state.recentDaily, date: state.recentDaily.match(/^# Daily · (\d{4}-\d{2}-\d{2})/m)?.[1] ?? "" });
    }

    // 3c M5：多日检索窗口。loadWorkingState 只带最新一天 daily——两天前的
    // 工作状态搜不到。补扫最近 N 天（不含已检查的最新一天），有界（N 个文件、每个 ≤64KB）。
    const project = resolveProjectIdentity(cwd);
    const dailyDir = path.join(this.basePath("project", project.id), "daily");
    if (await exists(dailyDir)) {
      const files = (await fs.readdir(dailyDir))
        .filter((file) => /^\d{4}-\d{2}-\d{2}\.md$/.test(file))
        .sort()
        .reverse();
      for (const file of files.slice(1, 1 + WORKING_SEARCH_DAILY_WINDOW)) {
        const content = await fs.readFile(path.join(dailyDir, file), "utf8");
        if (content.toLocaleLowerCase().includes(query)) {
          results.push({ source: "daily", content, date: file.slice(0, 10) });
        }
      }
    }
    return results;
  }

  async loadReinforcement(cwd: string): Promise<Record<string, ReinforcementState>> {
    const project = resolveProjectIdentity(cwd);
    const filepath = this.reinforcementPath(project.id);
    if (!(await exists(filepath))) return {};
    try {
      return JSON.parse(await fs.readFile(filepath, "utf8")) as Record<string, ReinforcementState>;
    } catch {
      return {};
    }
  }

  async hasExtractionSource(cwd: string, sourceHash: string): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/.test(sourceHash)) return false;
    const project = resolveProjectIdentity(cwd);
    return exists(this.extractionManifestPath(project.id, sourceHash));
  }

  async saveExtractionBatch(
    cwd: string,
    sourceHash: string,
    entries: Omit<SaveMemoryInput, "cwd">[],
    signal?: AbortSignal,
    reinforcementUpdates: Record<string, number> = {},
  ): Promise<MemoryRecord[]> {
    const project = resolveProjectIdentity(cwd);
    return this.withWriteLock(async () => {
      if (signal?.aborted) throw new Error("Memory extraction aborted");
      const manifestFile = this.extractionManifestPath(project.id, sourceHash);
      if (await exists(manifestFile)) return [];
      const existing = await this.listUnlocked(project, { includeArchived: true });
      if (entries.some((entry) => entry.scope === "project") && await exists(this.archivedProjectPath(project.id))) {
        throw new Error("Project memory is archived; restore it before extraction");
      }

      const staged: { filepath: string; record: MemoryRecord; revisionContent?: string }[] = [];
      const revisionContentMap = new Map<string, string | undefined>();
      const stagedPaths = new Set<string>();
      const timestamp = this.now().toISOString();
      for (const input of entries) {
        if (signal?.aborted) throw new Error("Memory extraction aborted");
        const title = normalizeTitle(input.title);
        const content = input.content.trim();
        if (!isMemoryCategory(input.category) || !title || !content) throw new Error("Invalid extraction entry");
        if (validateKeywords(input.keywords) === null) throw new Error("Invalid extraction entry keywords");
        const projectId = input.scope === "global" ? "global" : project.id;
        let id = recordId(input.scope, projectId, input.category, title);
        if (input.replaceRecordId) {
          if (!/^[a-f0-9]{32}$/.test(input.replaceRecordId)) throw new Error("Invalid replacement record ID");
          const target = existing.find((record) => record.id === input.replaceRecordId);
          if (!target || target.scope !== input.scope || target.category !== input.category || target.projectId !== projectId) {
            throw new Error("Replacement record is outside the consolidation boundary");
          }
          id = input.replaceRecordId;
        } else {
          const collision = existing.find((record) => record.id === id);
          if (collision) throw new Error("Extraction create collides with an existing record; explicit replacement is required");
        }
        const filepath = this.recordPath(input.scope, project.id, input.category, id);
        if (stagedPaths.has(filepath)) throw new Error("Extraction batch targets the same record more than once");
        stagedPaths.add(filepath);
        const previous = await this.readFileIfPresent(filepath);

        const previousRevisionId = previous?.provenance.revision?.revisionId ?? (previous ? randomUUID() : undefined);
        const headRevisionId = randomUUID();

        // If replacing an existing record, snapshot it under its prior head ID.
        if (previous && previousRevisionId) {
          const revision: MemoryRevision = {
            schemaVersion: 2,
            revisionId: previousRevisionId,
            recordId: id,
            title: previous.title,
            content: previous.content,
            provenance: previous.provenance,
            createdAt: previous.createdAt,
            capturedAt: timestamp,
          };
          const revisionDir = path.join(
            this.basePath(input.scope, project.id),
            "revisions",
            id,
          );
          const revisionFilepath = path.join(revisionDir, `${revision.revisionId}.md`);
          revisionContentMap.set(revisionFilepath, undefined); // new file, no previous content
          staged.push({ filepath: revisionFilepath, record: null as any, revisionContent: `${JSON.stringify(revision, null, 2)}\n` });
        }

        const record: MemoryRecord = {
          schemaVersion: MEMORY_RECORD_SCHEMA_VERSION,
          id,
          category: input.category,
          scope: input.scope,
          projectId,
          title,
          content,
          createdAt: previous?.createdAt || timestamp,
          updatedAt: timestamp,
          provenance: {
            ...input.provenance,
            source: "extraction",
            sourceHash,
            revision: {
              revisionId: headRevisionId,
              previousRevisionId,
            },
          },
          ...(input.keywords ? { keywords: input.keywords } : {}),
        };
        staged.push({ filepath, record, revisionContent: undefined });
      }
      if (signal?.aborted) throw new Error("Memory extraction aborted");

      // ── Backup all files before writing ──
      const backups = new Map<string, string | undefined>();
      const writeOrder: { target: string; content: string | undefined }[] = [];

      // 1. Revisions (written first so they exist even if the head write fails)
      for (const item of staged) {
        if (item.revisionContent !== undefined) {
          writeOrder.push({ target: item.filepath, content: item.revisionContent });
        }
      }

      // 2. Head records (entries)
      const entryItems = staged.filter((s) => s.revisionContent === undefined);
      for (const item of entryItems) {
        writeOrder.push({ target: item.filepath, content: serializeRecord(item.record) });
      }

      // 3. Reinforcement
      const reinforcementFile = this.reinforcementPath(project.id);
      let reinforcementContent: string | undefined;
      const previousReinforcement = await exists(reinforcementFile)
        ? await fs.readFile(reinforcementFile, "utf8")
        : undefined;
      const currentReinforcement = previousReinforcement
        ? JSON.parse(previousReinforcement) as Record<string, ReinforcementState>
        : {};
      const nextReinforcement = { ...currentReinforcement };
      for (const [key, increment] of Object.entries(reinforcementUpdates)) {
        nextReinforcement[key] = {
          count: (nextReinforcement[key]?.count || 0) + increment,
          updatedAt: timestamp,
        };
      }
      reinforcementContent = `${JSON.stringify(nextReinforcement, null, 2)}\n`;
      writeOrder.push({ target: reinforcementFile, content: reinforcementContent });

      // 4. Project metadata is prepared and written only after every backup exists.

      // 5. Manifest (committed LAST as authoritative publish point)
      const manifestContent = `${JSON.stringify({ sourceHash, projectId: project.id, recordIds: staged.filter((s) => s.revisionContent === undefined).map((item) => item.record.id), committedAt: timestamp }, null, 2)}\n`;

      // Build full backup set
      for (const w of writeOrder) {
        backups.set(w.target, await exists(w.target) ? await fs.readFile(w.target, "utf8") : undefined);
      }
      // Also back up project.json before writing
      const hasProjectScope = entries.some((entry) => entry.scope === "project");
      const projectJson = hasProjectScope
        ? path.join(this.basePath("project", project.id), "project.json")
        : undefined;
      if (projectJson) {
        backups.set(projectJson, await exists(projectJson) ? await fs.readFile(projectJson, "utf8") : undefined);
      }
      backups.set(manifestFile, await exists(manifestFile) ? await fs.readFile(manifestFile, "utf8") : undefined);

      // ── Write in order ──
      try {
        for (const w of writeOrder) {
          if (signal?.aborted) throw new Error("Memory extraction aborted");
          if (w.content !== undefined) {
            await this.atomicWrite(w.target, w.content);
          }
        }
        if (signal?.aborted) throw new Error("Memory extraction aborted");
        // Write project metadata
        if (entries.some((entry) => entry.scope === "project")) {
          await this.writeActiveMetadataUnlocked(project);
        }
        // Write manifest LAST
        await this.atomicWrite(manifestFile, manifestContent);
      } catch (error) {
        // Rollback in REVERSE order, collecting errors
        const rollbackErrors: Error[] = [];
        const reverseOrder = [...writeOrder].reverse();
        for (const w of reverseOrder) {
          const previous = backups.get(w.target);
          try {
            if (previous === undefined) await fs.rm(w.target, { force: true });
            else await this.atomicWrite(w.target, previous);
          } catch (e) {
            rollbackErrors.push(e instanceof Error ? e : new Error(String(e)));
          }
        }
        // Roll back project.json if it was part of the batch
        if (projectJson) {
          const prevMeta = backups.get(projectJson);
          try {
            if (prevMeta === undefined) await fs.rm(projectJson, { force: true });
            else await this.atomicWrite(projectJson, prevMeta);
          } catch (e) {
            rollbackErrors.push(e instanceof Error ? e : new Error(String(e)));
          }
        }
        // Roll back manifest
        const prevManifest = backups.get(manifestFile);
        try {
          if (prevManifest === undefined) await fs.rm(manifestFile, { force: true });
          else await this.atomicWrite(manifestFile, prevManifest);
        } catch (e) {
          rollbackErrors.push(e instanceof Error ? e : new Error(String(e)));
        }
        if (rollbackErrors.length > 0) {
          this.rollbackFailureCount += rollbackErrors.length;
          (error as any).rollbackErrors = rollbackErrors;
        }
        throw error;
      }
      const touchedScopes = new Set(entries.map((entry) => entry.scope));
      for (const scope of touchedScopes) {
        this.pendingIndexRebuild.add(this.basePath(scope, project.id));
      }
      await this.invalidateCacheSlicesUnlocked(
        [...touchedScopes].map((scope) => (scope === "global" ? "global" : `project:${project.id}`)),
      );
      return staged.filter((s) => s.revisionContent === undefined).map((item) => item.record);
    });
  }

  async list(cwd: string, options: boolean | ListMemoryOptions = {}): Promise<MemoryRecord[]> {
    const project = resolveProjectIdentity(cwd);
    const normalized = typeof options === "boolean" ? { includeArchived: options } : options;
    // Archive consistency: check before and after
    const archivedBefore = await exists(this.archivedProjectPath(project.id));
    const result = await this.listUnlocked(project, normalized);
    if (archivedBefore !== await exists(this.archivedProjectPath(project.id))) {
      // Archive position changed — retry once
      return this.listUnlocked(project, normalized);
    }
    return result;
  }

  async search(
    keyword: string,
    cwd: string,
    options: number | SearchMemoryOptions = {},
  ): Promise<MemorySearchResult[]> {
    const query = keyword.trim().toLocaleLowerCase();
    if (!query) return [];

    const normalized = typeof options === "number" ? { max: options } : options;
    // 3d M6：逗号分隔多值（审计 §3.3-M6）；非法值忽略、空集视为无过滤，不抛错。
    const parsedCategories = normalized.category
      ? (normalized.category.split(",").map((c) => c.trim()).filter((c) => isMemoryCategory(c)) as MemoryCategory[])
      : [];
    const categoryFilter = parsedCategories.length > 0 ? new Set(parsedCategories) : undefined;
    const project = resolveProjectIdentity(cwd);
    const archivedBase = this.archivedProjectPath(project.id);
    const archivedBefore = await exists(archivedBase);
    const archivedVisible = normalized.includeArchived === true && archivedBefore;
    const records = await Promise.all([
      this.listUnlocked(project, { includeProject: normalized.includeProject }),
      archivedVisible ? this.listBase(archivedBase) : Promise.resolve([]),
    ]);
    const globalAndProject = records[0];
    const archivedRecords = records[1];
    const allRecords = [...globalAndProject, ...archivedRecords];
    // Archive consistency: retry if position changed during read
    if (archivedBefore !== await exists(archivedBase)) {
      const retryArchivedVisible = normalized.includeArchived === true && await exists(archivedBase);
      const [retryGlobal, retryArchived] = await Promise.all([
        this.listUnlocked(project, { includeProject: normalized.includeProject }),
        retryArchivedVisible ? this.listBase(archivedBase) : Promise.resolve([]),
      ]);
      return this.formatSearchResults(query, [...retryGlobal, ...retryArchived], normalized.max, new Set(retryArchived.map((r) => r.id)), categoryFilter);
    }
    return this.formatSearchResults(query, allRecords, normalized.max, new Set(archivedRecords.map((r) => r.id)), categoryFilter);
  }

  /**
   * Multi-term single-scan search (2d S2): replaces the N+1 pattern where callers
   * looped `search(term)` per term — each loop re-ran listUnlocked + filtering.
   * One listUnlocked (record-cache backed, O(1) after warm) + one per-record pass
   * computing which terms hit. Caller owns the ranking.
   */
  async searchByTerms(
    terms: string[],
    cwd: string,
    options: { includeArchived?: boolean; includeProject?: boolean } = {},
  ): Promise<{ record: MemoryRecord; hitTerms: string[]; titleHit: boolean }[]> {
    const normalizedTerms = [...new Set(terms.map((t) => t.trim().toLocaleLowerCase()).filter((t) => t.length > 0))];
    if (normalizedTerms.length === 0) return [];

    const project = resolveProjectIdentity(cwd);
    const archivedBase = this.archivedProjectPath(project.id);
    const archivedBefore = await exists(archivedBase);
    const archivedVisible = options.includeArchived === true && archivedBefore;
    const [globalAndProject, archived] = await Promise.all([
      this.listUnlocked(project, { includeProject: options.includeProject }),
      archivedVisible ? this.listBase(archivedBase) : Promise.resolve([]),
    ]);
    if (archivedBefore !== await exists(archivedBase)) {
      // Archive position changed during the read — retry once.
      const retryArchivedVisible = options.includeArchived === true && await exists(archivedBase);
      const [retryGlobal, retryArchived] = await Promise.all([
        this.listUnlocked(project, { includeProject: options.includeProject }),
        retryArchivedVisible ? this.listBase(archivedBase) : Promise.resolve([]),
      ]);
      return this.matchByTerms(normalizedTerms, [...retryGlobal, ...retryArchived]);
    }
    return this.matchByTerms(normalizedTerms, [...globalAndProject, ...archived]);
  }

  private matchByTerms(
    normalizedTerms: string[],
    records: MemoryRecord[],
  ): { record: MemoryRecord; hitTerms: string[]; titleHit: boolean }[] {
    const results: { record: MemoryRecord; hitTerms: string[]; titleHit: boolean }[] = [];
    for (const record of records) {
      const title = record.title.toLocaleLowerCase();
      const content = record.content.toLocaleLowerCase();
      let titleHit = false;
      const hitTerms: string[] = [];
      for (const term of normalizedTerms) {
        const inTitle = title.includes(term);
        if (inTitle || content.includes(term)) {
          hitTerms.push(term);
          if (inTitle) titleHit = true;
        }
      }
      if (hitTerms.length > 0) results.push({ record, hitTerms, titleHit });
    }
    return results;
  }

  private formatSearchResults(
    query: string,
    records: MemoryRecord[],
    max: number | undefined,
    archivedRecordIds: Set<string>,
    categoryFilter?: Set<string>,
  ): MemorySearchResult[] {
    // M2/M3/M4 打分排序 —— 按审计 §3.3-M2 的原始公式实现（不自行简化权重）：
    //   score = (整串命中 title ? 10 : 整串命中 content ? 4 : 0)
    //         + (整串命中 keywords ? 8 : 0)
    //         + Σ(每个查询词): (命中 title/keywords ? 3 : 命中 content ? 1 : 0)
    //   × (1 + 0.1×provenance.score + 0.02×min(5, provenance.reinforcement))
    //   并列时 updatedAt 新者在前；查询词用 tokenize 切分（多词、中文 bigram）。
    // 修复前为"filter(includes) + recency 排序"——"新而弱相关"压"旧而强相关"。
    // 权重序 10>8>4 / 3>1 天然保证：错误 keywords（8）压不过整串标题命中（10）。
    // 入围边界保持既有契约：title/keywords/content 必须整串包含查询（token 打分
    // 只影响整串命中集合内的排序——多词查询里词频高的记录排前）。
    const queryTokens = [...new Set(tokenize(query).map((t) => t.toLocaleLowerCase()))].filter((t) => t.length > 0);
    const matchTextOf = (record: MemoryRecord): string =>
      `${record.title}\n${(record.keywords ?? []).join(" ")}\n${record.content}`.toLocaleLowerCase();
    const relevanceOf = (record: MemoryRecord): number => {
      const title = record.title.toLocaleLowerCase();
      const content = record.content.toLocaleLowerCase();
      const keywords = (record.keywords ?? []).join(" ").toLocaleLowerCase();
      let rel = 0;
      if (title.includes(query)) rel += 10;
      else if (content.includes(query)) rel += 4;
      if (keywords.includes(query)) rel += 8;
      for (const tok of queryTokens) {
        if (title.includes(tok) || keywords.includes(tok)) rel += 3;
        else if (content.includes(tok)) rel += 1;
      }
      const reinforcement = typeof record.provenance?.reinforcement === "number" ? record.provenance.reinforcement : 0;
      const score = typeof record.provenance?.score === "number" ? record.provenance.score : 0;
      rel *= 1 + 0.1 * Math.min(Math.max(score, 0), 1) + 0.02 * Math.min(Math.max(reinforcement, 0), 5);
      return rel;
    };

    return records
      .filter((record) => (!categoryFilter || categoryFilter.has(record.category)) && matchTextOf(record).includes(query))
      .map((record) => ({ record, rel: relevanceOf(record) }))
      .sort((a, b) =>
        a.rel !== b.rel
          ? b.rel - a.rel
          : b.record.updatedAt.localeCompare(a.record.updatedAt),
      )
      .slice(0, Math.max(0, max ?? 10))
      .map(({ record }) => {
        // 3a M3：snippet 基于含 keywords 的匹配文本。整串未命中时（纯 token 命中）
        // 退回第一个命中 token 的位置，避免 indexOf=-1 产出空 snippet。
        const text = matchTextOf(record);
        let index = text.indexOf(query);
        if (index < 0) {
          const hitToken = queryTokens.find((tok) => text.includes(tok));
          index = hitToken ? text.indexOf(hitToken) : 0;
        }
        const start = Math.max(0, index - 60);
        const end = Math.min(text.length, index + query.length + 140);
        return {
          record,
          snippet: `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`,
          archived: archivedRecordIds.has(record.id),
        };
      });
  }

  async buildPrompt(
    cwd: string,
    limits: { maxEntries?: number; maxChars?: number; includeProject?: boolean } = {},
  ): Promise<MemoryPrompt> {
    const project = resolveProjectIdentity(cwd);
    // Archive consistency
    const archivedBefore = await exists(this.archivedProjectPath(project.id));
    const records = await this.listUnlocked(project, {
      includeProject: limits.includeProject,
    });
    if (archivedBefore !== await exists(this.archivedProjectPath(project.id))) {
      // Retry once
      const retryRecords = await this.listUnlocked(project, {
        includeProject: limits.includeProject,
      });
      return this.buildPromptFromRecords(retryRecords, project, limits);
    }
    return this.buildPromptFromRecords(records, project, limits);
  }

  private buildPromptFromRecords(
    records: MemoryRecord[],
    project: ProjectIdentity,
    limits: { maxEntries?: number; maxChars?: number },
  ): MemoryPrompt {
    if (records.length === 0) return { prompt: "", count: 0, project };

    const maxEntries = limits.maxEntries ?? DEFAULT_PROMPT_ENTRY_LIMIT;
    const maxChars = limits.maxChars ?? DEFAULT_PROMPT_CHAR_LIMIT;
    const visible = records.slice(0, maxEntries);
    const lines = [
      "## Persistent Memory",
      "",
      `Current project: ${project.displayName} (${project.id})`,
      "The entries below are an index. Use SearchMemory to load full content when needed.",
      "",
    ];

    for (const record of visible) {
      const scope = record.scope === "global" ? "global" : "project";
      const line = `- [${scope}/${record.category}] ${record.title}`;
      if ([...lines, line].join("\n").length > maxChars) break;
      lines.push(line);
    }

    return { prompt: lines.join("\n"), count: records.length, project };
  }

  async getProjectLifecycle(cwd: string): Promise<ProjectLifecycle> {
    const project = resolveProjectIdentity(cwd);
    // Archive consistency
    const archivedBefore = await exists(this.archivedProjectPath(project.id));
    const archived = await this.readMetadata(this.archivedProjectPath(project.id));
    if (archived) {
      if (archivedBefore !== await exists(this.archivedProjectPath(project.id))) {
        // Retry once
        const retryArchived = await this.readMetadata(this.archivedProjectPath(project.id));
        if (retryArchived) {
          return { state: "archived", inactivityDays: this.inactivityDays(retryArchived.lastActiveAt), project, metadata: retryArchived };
        }
      }
      return { state: "archived", inactivityDays: this.inactivityDays(archived.lastActiveAt), project, metadata: archived };
    }

    const metadata = await this.readMetadata(this.basePath("project", project.id));
    if (archivedBefore !== await exists(this.archivedProjectPath(project.id))) {
      // Retry once
      const retryMeta = await this.readMetadata(this.basePath("project", project.id));
      if (!retryMeta) return { state: "new", inactivityDays: 0, project };
      return this.buildLifecycleFromMetadata(retryMeta);
    }
    if (!metadata) return { state: "new", inactivityDays: 0, project };
    return this.buildLifecycleFromMetadata(metadata);
  }

  private buildLifecycleFromMetadata(metadata: ProjectMemoryMetadata): ProjectLifecycle {
    const inactivityMs = this.inactivityMs(metadata.lastActiveAt);
    if (metadata.status === "archived") {
      return {
        state: "archive-due",
        inactivityDays: Math.floor(inactivityMs / DAY_MS),
        project: { id: metadata.projectId, cwd: metadata.cwd, displayName: metadata.displayName, aliased: false },
        metadata,
      };
    }
    const inactivityDays = Math.floor(inactivityMs / DAY_MS);
    const state = inactivityMs > 90 * DAY_MS ? "archive-due" : inactivityMs > 30 * DAY_MS ? "cold" : "hot";
    return { state, inactivityDays, project: { id: metadata.projectId, cwd: metadata.cwd, displayName: metadata.displayName, aliased: false }, metadata };
  }

  async markProjectActive(cwd: string): Promise<ProjectMemoryMetadata> {
    const project = resolveProjectIdentity(cwd);
    // P2 节流：每轮 before_agent_start 都调一次，但生命周期阈值是 30/90 天，
    // 5 分钟粒度内重复激活无语义价值。先无锁读现有 metadata，若 lastActiveAt
    // 在活跃阈值内且未被归档，直接返回现有 metadata——跳过写锁获取 + 原子写盘。
    // 写锁/写盘从"每轮 2 次"降到"约每 5 分钟 1 次"。失败兜底：读取或比较异常
    // 一律走原路径写入，绝不因节流而静默跳过激活。
    const MARK_ACTIVE_REFRESH_MS = 5 * 60 * 1000;
    try {
      const base = this.basePath("project", project.id);
      const [archivedExists, previous] = await Promise.all([
        exists(this.archivedProjectPath(project.id)),
        this.readMetadata(base),
      ]);
      if (
        !archivedExists &&
        previous &&
        previous.status === "active" &&
        typeof previous.lastActiveAt === "string"
      ) {
        const elapsed = this.now().getTime() - new Date(previous.lastActiveAt).getTime();
        if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < MARK_ACTIVE_REFRESH_MS) {
          return previous;
        }
      }
    } catch {
      // 节流读取失败：退化到下面的权威写入路径。
    }

    return this.withWriteLock(async () => {
      const activePath = this.basePath("project", project.id);
      const archivedPath = this.archivedProjectPath(project.id);
      if (await exists(archivedPath)) throw new Error("Project memory is archived; restore it before activation");
      const previous = await this.readMetadata(activePath);
      const metadata: ProjectMemoryMetadata = {
        schemaVersion: MEMORY_RECORD_SCHEMA_VERSION,
        projectId: project.id,
        displayName: project.displayName,
        cwd: project.cwd,
        status: "active",
        lastActiveAt: this.now().toISOString(),
        archivedAt: undefined,
        ...previous,
      };
      metadata.status = "active";
      metadata.lastActiveAt = this.now().toISOString();
      metadata.archivedAt = undefined;
      await this.atomicWrite(path.join(activePath, "project.json"), `${JSON.stringify(metadata, null, 2)}\n`);
      return metadata;
    });
  }

  async archiveProject(cwd: string): Promise<ProjectMemoryMetadata | undefined> {
    const project = resolveProjectIdentity(cwd);
    return this.withWriteLock(async () => {
      const source = this.basePath("project", project.id);
      const target = this.archivedProjectPath(project.id);
      if (!(await exists(source))) return undefined;
      if (await exists(target)) throw new Error(`Archive already exists for ${project.id}`);

      const previous = await this.readMetadata(source);
      const timestamp = this.now().toISOString();
      const metadata: ProjectMemoryMetadata = {
        schemaVersion: MEMORY_RECORD_SCHEMA_VERSION,
        projectId: project.id,
        displayName: project.displayName,
        cwd: project.cwd,
        status: "archived",
        lastActiveAt: previous?.lastActiveAt || timestamp,
        archivedAt: timestamp,
      };
      await this.atomicWrite(path.join(source, "project.json"), `${JSON.stringify(metadata, null, 2)}\n`);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.rename(source, target);
      // rename moves the whole project dir between active/archive positions:
      // both partitions may have been read & cached. Invalidate both + bump stamp.
      await this.invalidateCacheSlicesUnlocked([`project:${project.id}`, `archived:${project.id}`]);
      // working-manifests/ and extractions/ live OUTSIDE basePath, so the rename
      // leaves them behind as orphans. Run a full GC sweep now that the project is
      // being archived (P4). Already inside the write lock.
      await this.pruneProjectUnlocked(project.id, { fullSweep: true });
      return metadata;
    });
  }

  async restoreProject(cwd: string): Promise<ProjectMemoryMetadata | undefined> {
    const project = resolveProjectIdentity(cwd);
    return this.withWriteLock(async () => {
      const source = this.archivedProjectPath(project.id);
      const target = this.basePath("project", project.id);
      if (!(await exists(source))) return undefined;
      if (await exists(target)) throw new Error(`Active project already exists for ${project.id}`);

      const previous = await this.readMetadata(source);
      const metadata: ProjectMemoryMetadata = {
        schemaVersion: MEMORY_RECORD_SCHEMA_VERSION,
        projectId: project.id,
        displayName: project.displayName,
        cwd: project.cwd,
        status: "active",
        lastActiveAt: this.now().toISOString(),
        archivedAt: undefined,
        ...previous,
      };
      metadata.status = "active";
      metadata.lastActiveAt = this.now().toISOString();
      metadata.archivedAt = undefined;
      await this.atomicWrite(path.join(source, "project.json"), `${JSON.stringify(metadata, null, 2)}\n`);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      try {
        await fs.rename(source, target);
      } catch (error) {
        const archivedMetadata: ProjectMemoryMetadata = {
          ...metadata,
          status: "archived",
          archivedAt: previous?.archivedAt || this.now().toISOString(),
        };
        await this.atomicWrite(path.join(source, "project.json"), `${JSON.stringify(archivedMetadata, null, 2)}\n`);
        throw error;
      }
      // rename moved the whole project dir from archive back to active: both
      // partitions may have been read & cached. Invalidate both + bump stamp.
      await this.invalidateCacheSlicesUnlocked([`project:${project.id}`, `archived:${project.id}`]);
      return metadata;
    });
  }

  /**
   * Opportunistic / full-sweep garbage collection for the four unbounded data
   * categories (Phase 2a P4). Mirrors the retention policy defined in
   * docs/technical/14-audit-memory-retrieval-and-reviewer.md §5.2-P4.
   */
  async pruneProject(cwd: string, opts?: { fullSweep?: boolean }): Promise<{ pruned: number; rebuiltIndex: boolean }> {
    const project = resolveProjectIdentity(cwd);
    return this.withWriteLock(async () => this.pruneProjectUnlocked(project.id, opts));
  }

  private async pruneProjectUnlocked(
    projectId: string,
    opts?: { fullSweep?: boolean },
  ): Promise<{ pruned: number; rebuiltIndex: boolean }> {
    const budget = opts?.fullSweep ? Number.POSITIVE_INFINITY : PRUNE_MAX_FILES;
    const deadline = this.now().getTime();
    let remaining = budget;
    let totalPruned = 0;
    let rebuiltIndex = false;

    // 1. working manifests: keep PRUNE_WORKING_DAYS by updatedAt.
    const manifestsDir = path.join(this.root, "working-manifests", projectId);
    const workingCutoff = deadline - PRUNE_WORKING_DAYS * DAY_MS;
    let workingPruned = 0;
    if (await exists(manifestsDir)) {
      for (const filename of await fs.readdir(manifestsDir)) {
        if (remaining <= 0) break;
        if (!filename.endsWith(".json") || filename === "latest-index.json") continue;
        const filepath = path.join(manifestsDir, filename);
        let shouldRemove = false;
        try {
          const raw = JSON.parse(await fs.readFile(filepath, "utf8"));
          const update = parseWorkingStateUpdate(raw);
          if (Date.parse(update.updatedAt) < workingCutoff) shouldRemove = true;
        } catch {
          // Corrupt manifest — safe to remove.
          shouldRemove = true;
        }
        if (shouldRemove) {
          await fs.rm(filepath, { force: true });
          remaining -= 1;
          workingPruned += 1;
          totalPruned += 1;
        }
      }
    }
    if (workingPruned > 0) {
      // Recompute the index from surviving manifests so it cannot reference pruned sourceHashes.
      await this.rebuildLatestIndexUnlocked(projectId, manifestsDir);
      rebuiltIndex = true;
    }

    // 2. daily files: keep PRUNE_DAILY_DAYS by filename date.
    const dailyDir = path.join(this.basePath("project", projectId), "daily");
    const dailyCutoff = deadline - PRUNE_DAILY_DAYS * DAY_MS;
    if (await exists(dailyDir)) {
      for (const filename of await fs.readdir(dailyDir)) {
        if (remaining <= 0) break;
        if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(filename)) continue;
        const dayMs = Date.parse(filename.slice(0, 10));
        if (!Number.isNaN(dayMs) && dayMs < dailyCutoff) {
          await fs.rm(path.join(dailyDir, filename), { force: true });
          remaining -= 1;
          totalPruned += 1;
        }
      }
    }

    // 3. revisions: keep PRUNE_REVISION_KEEP most-recent per recordId.
    const projectBase = this.basePath("project", projectId);
    const revisionsDir = path.join(projectBase, "revisions");
    if (await exists(revisionsDir)) {
      for (const recordId of await fs.readdir(revisionsDir, { withFileTypes: true })) {
        if (remaining <= 0) break;
        if (!recordId.isDirectory()) continue;
        const recordDir = path.join(revisionsDir, recordId.name);
        const files: { name: string; mtime: number }[] = [];
        for (const entry of await fs.readdir(recordDir, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
          const st = await fs.stat(path.join(recordDir, entry.name));
          files.push({ name: entry.name, mtime: st.mtime.getTime() });
        }
        if (files.length <= PRUNE_REVISION_KEEP) continue;
        files.sort((a, b) => b.mtime - a.mtime);
        for (const file of files.slice(PRUNE_REVISION_KEEP)) {
          if (remaining <= 0) break;
          await fs.rm(path.join(recordDir, file.name), { force: true });
          remaining -= 1;
          totalPruned += 1;
        }
      }
    }

    // 4. extraction manifests: keep PRUNE_EXTRACTION_DAYS by mtime.
    const extractionsDir = path.join(this.root, "extractions", projectId);
    const extractionCutoff = deadline - PRUNE_EXTRACTION_DAYS * DAY_MS;
    if (await exists(extractionsDir)) {
      for (const filename of await fs.readdir(extractionsDir)) {
        if (remaining <= 0) break;
        if (!filename.endsWith(".json")) continue;
        const filepath = path.join(extractionsDir, filename);
        const st = await fs.stat(filepath);
        if (st.mtime.getTime() < extractionCutoff) {
          await fs.rm(filepath, { force: true });
          remaining -= 1;
          totalPruned += 1;
        }
      }
    }

    return { pruned: totalPruned, rebuiltIndex };
  }

  async rebuildIndex(scope: MemoryScope, cwd: string): Promise<void> {
    const project = resolveProjectIdentity(cwd);
    await this.withWriteLock(async () => {
      await this.rebuildIndexUnlocked(scope, project);
      this.pendingIndexRebuild.delete(this.basePath(scope, project.id));
    });
  }

  /**
   * Flush deferred MEMORY.md rebuilds for this project (global + project bases).
   * Called opportunistically from session_start / memory-status — cheap no-op when
   * nothing is dirty. MEMORY.md is a derived convenience index, so staleness here
   * never affects retrieval or injection.
   */
  async rebuildPendingIndexes(cwd: string): Promise<void> {
    const project = resolveProjectIdentity(cwd);
    const bases = [this.basePath("global", project.id), this.basePath("project", project.id)];
    const dirty = bases.filter((b) => this.pendingIndexRebuild.has(b));
    if (dirty.length === 0) return;
    await this.withWriteLock(async () => {
      for (const base of dirty) {
        if (!this.pendingIndexRebuild.has(base)) continue;
        const scope: MemoryScope = base === this.basePath("global", project.id) ? "global" : "project";
        await this.rebuildIndexUnlocked(scope, project);
        this.pendingIndexRebuild.delete(base);
      }
    });
  }

  /** List all revision snapshots for a given record. */
  async listRevisions(recordId: string, cwd: string): Promise<MemoryRevision[]> {
    if (!/^[a-f0-9]{32}$/.test(recordId)) return [];
    const project = resolveProjectIdentity(cwd);
    const revisions: MemoryRevision[] = [];
    for (const scope of ["project", "global"] as const) {
      const revisionDir = path.join(this.basePath(scope, project.id), "revisions", recordId);
      if (!(await exists(revisionDir))) continue;
      for (const entry of await fs.readdir(revisionDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        try {
          const raw = await fs.readFile(path.join(revisionDir, entry.name), "utf8");
          const rev = JSON.parse(raw) as MemoryRevision;
          if (rev.schemaVersion === 2 && rev.recordId === recordId) revisions.push(rev);
        } catch {
          // Corrupt revision — skip
        }
      }
    }
    return revisions.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  }

  /** Get a specific revision snapshot by ID. */
  async getRevision(recordId: string, revisionId: string, cwd: string): Promise<MemoryRevision | undefined> {
    if (!/^[a-f0-9]{32}$/.test(recordId) || !revisionId) return undefined;
    const project = resolveProjectIdentity(cwd);
    for (const scope of ["project", "global"] as const) {
      const filepath = path.join(this.basePath(scope, project.id), "revisions", recordId, `${revisionId}.md`);
      if (!(await exists(filepath))) continue;
      try {
        const raw = await fs.readFile(filepath, "utf8");
        const rev = JSON.parse(raw) as MemoryRevision;
        if (rev.schemaVersion === 2 && rev.recordId === recordId && rev.revisionId === revisionId) return rev;
      } catch {
        // Corrupt revision
      }
    }
    return undefined;
  }

  private basePath(scope: MemoryScope, projectId: string): string {
    return scope === "global"
      ? path.join(this.root, "global")
      : path.join(this.root, "projects", projectId);
  }

  private archivedProjectPath(projectId: string): string {
    return path.join(this.root, "archive", "projects", projectId);
  }

  private extractionManifestPath(projectId: string, sourceHash: string): string {
    return path.join(this.root, "extractions", projectId, `${sourceHash}.json`);
  }

  private reinforcementPath(projectId: string): string {
    return path.join(this.root, "signals", projectId, "reinforcement.json");
  }

  private workingManifestPath(projectId: string, sourceHash: string): string {
    return path.join(this.root, "working-manifests", projectId, `${sourceHash}.json`);
  }

  /** Path to the working-manifest index (Phase 2a P3). Sits in the manifests dir
   *  alongside the per-turn manifest files; full-scan rebuilds skip it by name. */
  private workingLatestIndexPath(projectId: string): string {
    return path.join(this.root, "working-manifests", projectId, "latest-index.json");
  }

  // ── Working-manifest index (2a P3): O(1) saveWorkingState ──────────────────
  // All `*Unlocked` methods MUST be called inside withWriteLock: they read/write
  // the index and the manifest dir, sharing the dir with saveWorkingState. The
  // index is read fresh from disk each call (no in-process cross-call copy), so
  // it needs no .cache-stamp validation — the lock serializes writers.

  /** Read & strictly parse the index. Any malformation → undefined (triggers rebuild). */
  private async readLatestIndexUnlocked(projectId: string): Promise<WorkingLatestIndex | undefined> {
    const filepath = this.workingLatestIndexPath(projectId);
    if (!(await exists(filepath))) return undefined;
    try {
      return parseWorkingLatestIndex(JSON.parse(await fs.readFile(filepath, "utf8")));
    } catch {
      return undefined;
    }
  }

  /** Authoritative full O(M) scan fallback. Reads all manifests, derives the index,
   *  writes it, returns it. Skips latest-index.json and non-.json entries. */
  private async rebuildLatestIndexUnlocked(projectId: string, manifestsDir: string): Promise<WorkingLatestIndex> {
    const updates: WorkingStateUpdate[] = [];
    if (await exists(manifestsDir)) {
      for (const filename of await fs.readdir(manifestsDir)) {
        if (!filename.endsWith(".json") || filename === "latest-index.json") continue;
        try {
          updates.push(parseWorkingStateUpdate(JSON.parse(await fs.readFile(path.join(manifestsDir, filename), "utf8"))));
        } catch {
          // Corrupt/unreadable manifest — skip (matches the legacy scan's silent tolerance).
        }
      }
    }
    updates.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    // saveWorkingState writes the manifest before reading the index, so at least the
    // incoming manifest is present. If the dir is genuinely empty (no manifests yet),
    // there is no latestUpdate to point at — return an empty-but-valid index the caller
    // will immediately merge against.
    if (updates.length === 0) {
      const empty: WorkingLatestIndex = {
        schemaVersion: WORKING_INDEX_SCHEMA_VERSION,
        date: "",
        latestUpdate: undefined as unknown as WorkingStateUpdate,
        sameDayEntries: [],
        manifestCount: 0,
      };
      return empty;
    }
    const latestUpdate = updates[updates.length - 1];
    const sameDayEntries = updates
      .filter((u) => u.date === latestUpdate.date)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(-MAX_SAMEDAY_ENTRIES);
    const index: WorkingLatestIndex = {
      schemaVersion: WORKING_INDEX_SCHEMA_VERSION,
      date: latestUpdate.date,
      latestUpdate,
      sameDayEntries,
      manifestCount: updates.length,
    };
    await this.atomicWrite(this.workingLatestIndexPath(projectId), serializeWorkingLatestIndex(index));
    return index;
  }

  /** Increment-merge an incoming update into the index WITHOUT writing. If the index
   *  is missing/empty, rebuild is authoritative (the incoming manifest is already on
   *  disk, so rebuild counts it). The four branches below preserve the legacy
   *  `updates.at(-1)` semantics (max updatedAt wins latest) without the scan. */
  private mergeLatestIndexUnlocked(
    index: WorkingLatestIndex | undefined,
    incoming: WorkingStateUpdate,
    manifestsDir: string,
    projectId: string,
  ): Promise<WorkingLatestIndex> {
    // No usable index (missing, corrupt, or the empty placeholder) → rebuild reads
    // the manifest dir (which already contains the just-written incoming manifest)
    // and returns an authoritative index that already reflects incoming. No re-merge.
    if (!index || index.manifestCount === 0 || !index.date) {
      return this.rebuildLatestIndexUnlocked(projectId, manifestsDir);
    }

    const maxUpdate = (a: WorkingStateUpdate, b: WorkingStateUpdate): WorkingStateUpdate =>
      a.updatedAt.localeCompare(b.updatedAt) >= 0 ? a : b;

    const hadSourceHash = index.sameDayEntries.some((e) => e.sourceHash === incoming.sourceHash);

    // Date rollover: a new day's first turn resets the same-day window.
    if (incoming.date !== index.date) {
      const merged: WorkingLatestIndex = {
        schemaVersion: WORKING_INDEX_SCHEMA_VERSION,
        date: incoming.date,
        latestUpdate: maxUpdate(index.latestUpdate, incoming),
        sameDayEntries: [incoming],
        manifestCount: index.manifestCount + (hadSourceHash ? 0 : 1),
      };
      return Promise.resolve(merged);
    }

    // Same day. Replace any prior occurrence of this sourceHash, then append incoming.
    const sameDay = [...index.sameDayEntries.filter((e) => e.sourceHash !== incoming.sourceHash), incoming]
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(-MAX_SAMEDAY_ENTRIES);
    const merged: WorkingLatestIndex = {
      schemaVersion: WORKING_INDEX_SCHEMA_VERSION,
      date: index.date,
      latestUpdate: maxUpdate(index.latestUpdate, incoming),
      sameDayEntries: sameDay,
      manifestCount: index.manifestCount + (hadSourceHash ? 0 : 1),
    };
    // If the cap dropped an entry, manifestCount still reflects on-disk manifests
    // (the dropped manifest is NOT deleted — only the projection is capped), so
    // manifestCount stays accurate; the dropped entry simply ages out of the daily tail.
    return Promise.resolve(merged);
  }

  private async writeLatestIndexUnlocked(projectId: string, index: WorkingLatestIndex): Promise<void> {
    await this.atomicWrite(this.workingLatestIndexPath(projectId), serializeWorkingLatestIndex(index));
  }

  /** Read the index, falling back to a full rebuild if it is missing/corrupt.
   *  Risk-C self-heal: if the on-disk manifest count disagrees with the index by
   *  anything other than the caller's expectedExtra (e.g. a crash between writing
   *  the manifest and writing the index left an orphaned manifest), rebuild.
   *  expectedExtra is the number of manifests the caller just wrote before this
   *  read (saveWorkingState passes 1 when its manifest was new, 0 on refresh) —
   *  this keeps the steady-state path a pure O(1) index read + one readdir. */
  private async loadLatestIndexUnlocked(
    projectId: string,
    manifestsDir: string,
    expectedExtra = 0,
  ): Promise<WorkingLatestIndex> {
    const index = await this.readLatestIndexUnlocked(projectId);
    if (index && index.manifestCount > 0 && index.date) {
      try {
        const entries = await fs.readdir(manifestsDir);
        const manifestFileCount = entries.filter((n) => n.endsWith(".json") && n !== "latest-index.json").length;
        if (manifestFileCount === index.manifestCount + expectedExtra) return index;
        // Mismatch → some manifest is not reflected in the index. Rebuild.
      } catch {
        // readdir failed; trust the index (read path defense).
        return index;
      }
    }
    return this.rebuildLatestIndexUnlocked(projectId, manifestsDir);
  }

  private async listUnlocked(project: ProjectIdentity, options: ListMemoryOptions): Promise<MemoryRecord[]> {
    const [global, scoped, archived] = await Promise.all([
      this.listBase(this.basePath("global", project.id)),
      options.includeProject === false ? Promise.resolve([]) : this.listBase(this.basePath("project", project.id)),
      options.includeArchived ? this.listBase(this.archivedProjectPath(project.id)) : Promise.resolve([]),
    ]);
    return [...scoped, ...archived, ...global].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private recordPath(scope: MemoryScope, projectId: string, category: MemoryCategory, id: string): string {
    return path.join(this.basePath(scope, projectId), "entries", category, `${id}.md`);
  }

  private inactivityMs(lastActiveAt: string): number {
    const elapsed = this.now().getTime() - new Date(lastActiveAt).getTime();
    if (!Number.isFinite(elapsed)) return Number.POSITIVE_INFINITY;
    return Math.max(0, elapsed);
  }

  private inactivityDays(lastActiveAt: string): number {
    return Math.floor(this.inactivityMs(lastActiveAt) / DAY_MS);
  }

  private async readMetadata(base: string): Promise<ProjectMemoryMetadata | undefined> {
    const filepath = path.join(base, "project.json");
    if (!(await exists(filepath))) return undefined;
    try {
      const metadata = JSON.parse(await fs.readFile(filepath, "utf8")) as ProjectMemoryMetadata;
      if (metadata.schemaVersion !== MEMORY_RECORD_SCHEMA_VERSION || !metadata.projectId || !metadata.lastActiveAt) {
        return undefined;
      }
      return metadata;
    } catch {
      return undefined;
    }
  }

  private async writeActiveMetadataUnlocked(project: ProjectIdentity): Promise<ProjectMemoryMetadata> {
    const base = this.basePath("project", project.id);
    const previous = await this.readMetadata(base);
    const metadata: ProjectMemoryMetadata = {
      schemaVersion: MEMORY_RECORD_SCHEMA_VERSION,
      projectId: project.id,
      displayName: project.displayName,
      cwd: project.cwd,
      status: "active",
      lastActiveAt: this.now().toISOString(),
      archivedAt: undefined,
      ...previous,
    };
    metadata.status = "active";
    metadata.lastActiveAt = this.now().toISOString();
    metadata.archivedAt = undefined;
    await this.atomicWrite(path.join(base, "project.json"), `${JSON.stringify(metadata, null, 2)}\n`);
    return metadata;
  }

  /**
   * Cache slice key for a base directory. The three read partitions map to:
   *   global              — root/global                   (shared by all projects)
   *   project:<id>        — root/projects/<id>
   *   archived:<id>       — root/archive/projects/<id>
   * archiveProject/restoreProject rename whole directories, so a project's
   * records can appear under either partition — cache must invalidate both.
   */
  private sliceKeyFor(base: string): string {
    const archivedPrefix = path.join(this.root, "archive", "projects") + path.sep;
    const projectPrefix = path.join(this.root, "projects") + path.sep;
    const globalDir = path.join(this.root, "global");
    if (base === globalDir) return "global";
    if (base.startsWith(archivedPrefix)) return `archived:${base.slice(archivedPrefix.length)}`;
    if (base.startsWith(projectPrefix)) return `project:${base.slice(projectPrefix.length)}`;
    return base; // 未识别分区：以 base 自身为 key（退化，仍正确，只是不共享失效）
  }

  /** Read the cross-process write token. Missing/unreadable ⇒ "" (treated as stale). */
  private async readCacheStamp(): Promise<string> {
    try {
      const filepath = path.join(this.root, FilesystemMemoryRepository.CACHE_STAMP_NAME);
      if (!(await exists(filepath))) return "";
      return (await fs.readFile(filepath, "utf8")).trim();
    } catch {
      return "";
    }
  }

  /** Bump the write token inside the write lock so concurrent readers see the change. */
  private async bumpCacheStampUnlocked(): Promise<void> {
    this.cacheStampSeq = (this.cacheStampSeq + 1) % Number.MAX_SAFE_INTEGER;
    await this.atomicWrite(
      path.join(this.root, FilesystemMemoryRepository.CACHE_STAMP_NAME),
      `${this.cacheStampSeq}\n`,
    );
  }

  /**
   * Drop the given cache slices (in-process staleness) and bump the write token
   * (cross-process staleness). Must be called inside the write lock, after the
   * on-disk mutation has committed, so the token bump publishes atomically with
   * the data change.
   */
  private async invalidateCacheSlicesUnlocked(sliceKeys: string[]): Promise<void> {
    for (const key of sliceKeys) this.recordCache.delete(key);
    await this.bumpCacheStampUnlocked();
  }

  private async listBase(base: string): Promise<MemoryRecord[]> {
    const sliceKey = this.sliceKeyFor(base);

    // 跨进程失效：读前比对写令牌。令牌变了 ⇒ 别的进程写过 ⇒ 丢弃该片重读。
    // 读取失败/缺失 ⇒ 安全降级为 stale，重读，绝不返回可能过期的数据。
    const currentStamp = await this.readCacheStamp();
    const cached = this.recordCache.get(sliceKey);
    if (cached && cached.stampAtLoad === currentStamp) {
      return cached.records.slice(); // 浅拷贝：调用方不可 mutate 缓存条目
    }

    const records = await this.scanRecordsUnlocked(base);
    // 空结果也缓存（避免对空项目反复扫描）；stampAtLoad 用当前令牌。令牌为空串
    // 时（首启、无 .cache-stamp）仍缓存——首次写会 bump 令牌并删片，不会长期陈旧。
    this.recordCache.set(sliceKey, { records, stampAtLoad: currentStamp });
    return records.slice();
  }

  /** On-disk directory scan — the O(N) path the cache front-ends. */
  private async scanRecordsUnlocked(base: string): Promise<MemoryRecord[]> {
    const entriesDir = path.join(base, "entries");
    if (!(await exists(entriesDir))) return [];

    const records: MemoryRecord[] = [];
    for (const category of await fs.readdir(entriesDir, { withFileTypes: true })) {
      if (!category.isDirectory()) continue;
      const categoryDir = path.join(entriesDir, category.name);
      for (const entry of await fs.readdir(categoryDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const filepath = path.join(categoryDir, entry.name);
        try {
          records.push(parseRecord(await fs.readFile(filepath, "utf8"), filepath));
        } catch {
          // A damaged or manually edited record must not hide healthy memories.
          // Diagnostics and quarantine are added in the lifecycle block.
        }
      }
    }
    return records;
  }

  /** Like listBase but also returns corrupt record count for diagnostics. */
  private async listBaseWithDiagnostics(base: string): Promise<{ records: MemoryRecord[]; corruptRecordCount: number }> {
    const entriesDir = path.join(base, "entries");
    if (!(await exists(entriesDir))) return { records: [], corruptRecordCount: 0 };

    const records: MemoryRecord[] = [];
    let corruptRecordCount = 0;
    for (const category of await fs.readdir(entriesDir, { withFileTypes: true })) {
      if (!category.isDirectory()) continue;
      const categoryDir = path.join(entriesDir, category.name);
      for (const entry of await fs.readdir(categoryDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const filepath = path.join(categoryDir, entry.name);
        try {
          records.push(parseRecord(await fs.readFile(filepath, "utf8"), filepath));
        } catch {
          corruptRecordCount += 1;
        }
      }
    }
    return { records, corruptRecordCount };
  }

  private async readFileIfPresent(filepath: string): Promise<MemoryRecord | undefined> {
    if (!(await exists(filepath))) return undefined;
    return parseRecord(await fs.readFile(filepath, "utf8"), filepath);
  }

  private async rebuildIndexUnlocked(scope: MemoryScope, project: ProjectIdentity): Promise<void> {
    const base = this.basePath(scope, project.id);
    const records = await this.listBase(base);
    records.sort((a, b) => a.title.localeCompare(b.title));
    const lines = ["# Memory Index", ""];
    for (const record of records) {
      lines.push(`- [${record.title}](entries/${record.category}/${record.id}.md) · ${record.category} · ${record.updatedAt}`);
    }
    await this.atomicWrite(path.join(base, "MEMORY.md"), `${lines.join("\n")}\n`);
  }

  /**
   * Acquire the exclusive repository write lock.
   *
   * Write methods (save, saveExtractionBatch, archive, etc.) use this to
   * serialize concurrent writers. Read methods intentionally do NOT hold this
   * lock: individual entry files are written atomically (temp + rename), so a
   * reader always sees a complete per-file state — never a half-written entry.
   */
  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    await fs.chmod(this.root, 0o700);
    const release = await lock(this.root, {
      realpath: true,
      retries: { retries: 20, minTimeout: 10, maxTimeout: 100 },
      stale: 10_000,
    });
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  private async atomicWrite(filepath: string, content: string): Promise<void> {
    await this.beforeWrite?.(filepath);
    const dir = path.dirname(filepath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700);
    const temporary = path.join(dir, `.${path.basename(filepath)}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporary, filepath);
      await fs.chmod(filepath, 0o600);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
}

export function createMemoryRepository(options?: MemoryRepositoryOptions): FilesystemMemoryRepository {
  return new FilesystemMemoryRepository(options);
}
