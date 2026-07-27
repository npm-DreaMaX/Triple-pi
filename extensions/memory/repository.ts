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
  SCRATCHPAD_MAX_CHARS,
  parseWorkingLatest,
  renderDailyEntry,
  renderScratchpad,
  type WorkingStateUpdate,
} from "./working-state.ts";
import { containsSecret, describeRejection, validateMemoryWrite } from "./validation.ts";

const RECORD_START = "<!-- triple-pi-memory";
const RECORD_END = "-->";
const DEFAULT_PROMPT_ENTRY_LIMIT = 50;
const DEFAULT_PROMPT_CHAR_LIMIT = 12_000;

export interface MemoryRepositoryOptions {
  root?: string;
  now?: () => Date;
}

export interface SaveMemoryInput {
  category: MemoryCategory;
  scope: MemoryScope;
  cwd: string;
  title: string;
  content: string;
  provenance?: MemoryProvenance;
  replaceRecordId?: string;
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
  return {
    ...(metadata as Omit<MemoryRecord, "content" | "title">),
    schemaVersion: MEMORY_RECORD_SCHEMA_VERSION as 2,
    title,
    content,
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

  constructor(options: MemoryRepositoryOptions = {}) {
    this.root = path.resolve(options.root || defaultRoot());
    this.now = options.now || (() => new Date());
  }

  async save(input: SaveMemoryInput): Promise<MemoryRecord> {
    // Validate via shared validator
    const validated = validateMemoryWrite(
      { category: input.category, title: input.title, content: input.content, scope: input.scope },
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

      // If updating an existing record, create an immutable revision snapshot first
      if (previous) {
        const revision: MemoryRevision = {
          schemaVersion: 2,
          revisionId: randomUUID(),
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
        await fs.mkdir(revisionDir, { recursive: true, mode: 0o700 });
        await this.atomicWrite(
          path.join(revisionDir, `${revision.revisionId}.md`),
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
        provenance: input.provenance || { source: "manual" },
      };

      // Wire revision pointer into the new record's provenance
      if (previous) {
        record.provenance = {
          ...record.provenance,
          revision: {
            revisionId: randomUUID(),
            previousRevisionId: previous.provenance?.revision?.revisionId,
          },
        };
      }

      await this.atomicWrite(filepath, serializeRecord(record));
      if (input.scope === "project") {
        await this.writeActiveMetadataUnlocked(project);
      }
      try {
        await this.rebuildIndexUnlocked(input.scope, project);
      } catch {
        // MEMORY.md is a derived convenience index. The authoritative entry
        // remains readable and a later rebuild can repair the index.
      }
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

      const manifestsDir = path.dirname(manifest);
      const updates: WorkingStateUpdate[] = [];
      for (const filename of await fs.readdir(manifestsDir)) {
        if (!filename.endsWith(".json")) continue;
        try {
          updates.push(JSON.parse(await fs.readFile(path.join(manifestsDir, filename), "utf8")) as WorkingStateUpdate);
        } catch {}
      }
      updates.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
      const latestUpdate = updates.at(-1) || update;
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

      const sameDay = updates.filter((item) => item.date === update.date);
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
        extractionRunning: false, extractionPending: false,
        consecutiveExtractionFailures: 0, corruptRecordCount: 0, rollbackFailureCount: 0,
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
      extractionRunning: false,
      extractionPending: false,
      consecutiveExtractionFailures: 0,
      corruptRecordCount: recordsResult.corruptRecordCount,
      rollbackFailureCount: 0,
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

  async searchWorkingState(keyword: string, cwd: string): Promise<{ source: "scratchpad" | "daily"; content: string }[]> {
    const query = keyword.trim().toLocaleLowerCase();
    if (!query) return [];
    const state = await this.loadWorkingState(cwd);
    const results: { source: "scratchpad" | "daily"; content: string }[] = [];
    if (state.scratchpad.toLocaleLowerCase().includes(query)) results.push({ source: "scratchpad", content: state.scratchpad });
    if (state.recentDaily.toLocaleLowerCase().includes(query)) results.push({ source: "daily", content: state.recentDaily });
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

        // If replacing an existing record, capture an immutable revision snapshot
        if (previous) {
          const revision: MemoryRevision = {
            schemaVersion: 2,
            revisionId: randomUUID(),
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
            revision: previous?.provenance?.revision
              ? {
                  revisionId: randomUUID(),
                  previousRevisionId: previous.provenance.revision.revisionId,
                }
              : undefined,
          },
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

      // 4. Project metadata (project.json)
      if (entries.some((entry) => entry.scope === "project")) {
        const meta = await this.writeActiveMetadataUnlocked(project);
        // Already written; we'll back it up during the write phase
      }

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
          if (prevMeta !== undefined) {
            try {
              await this.atomicWrite(projectJson, prevMeta);
            } catch (e) {
              rollbackErrors.push(e instanceof Error ? e : new Error(String(e)));
            }
          }
        }
        // Roll back manifest
        const prevManifest = backups.get(manifestFile);
        if (prevManifest !== undefined) {
          try {
            await this.atomicWrite(manifestFile, prevManifest);
          } catch (e) {
            rollbackErrors.push(e instanceof Error ? e : new Error(String(e)));
          }
        }
        // Attach rollback errors to the original error
        if (rollbackErrors.length > 0) {
          (error as any).rollbackErrors = rollbackErrors;
        }
        throw error;
      }
      for (const scope of new Set(entries.map((entry) => entry.scope))) {
        try { await this.rebuildIndexUnlocked(scope, project); } catch {}
      }
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
      return this.formatSearchResults(query, [...retryGlobal, ...retryArchived], normalized.max, new Set(retryArchived.map((r) => r.id)));
    }
    return this.formatSearchResults(query, allRecords, normalized.max, new Set(archivedRecords.map((r) => r.id)));
  }

  private formatSearchResults(
    query: string,
    records: MemoryRecord[],
    max: number | undefined,
    archivedRecordIds: Set<string>,
  ): MemorySearchResult[] {
    const sorted = records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return sorted
      .filter((record) => `${record.title}\n${record.content}`.toLocaleLowerCase().includes(query))
      .slice(0, Math.max(0, max ?? 10))
      .map((record) => {
        const text = `${record.title}\n${record.content}`;
        const index = text.toLocaleLowerCase().indexOf(query);
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
      return metadata;
    });
  }

  async rebuildIndex(scope: MemoryScope, cwd: string): Promise<void> {
    const project = resolveProjectIdentity(cwd);
    await this.withWriteLock(() => this.rebuildIndexUnlocked(scope, project));
  }

  /** List all revision snapshots for a given record. */
  async listRevisions(recordId: string, cwd: string): Promise<MemoryRevision[]> {
    if (!/^[a-f0-9]{32}$/.test(recordId)) return [];
    const project = resolveProjectIdentity(cwd);
    const base = this.basePath("project", project.id);
    const revisionDir = path.join(base, "revisions", recordId);
    if (!(await exists(revisionDir))) return [];

    const revisions: MemoryRevision[] = [];
    for (const entry of await fs.readdir(revisionDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      try {
        const raw = await fs.readFile(path.join(revisionDir, entry.name), "utf8");
        const rev = JSON.parse(raw) as MemoryRevision;
        if (rev.schemaVersion === 2 && rev.recordId === recordId) {
          revisions.push(rev);
        }
      } catch {
        // Corrupt revision — skip
      }
    }
    return revisions.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  }

  /** Get a specific revision snapshot by ID. */
  async getRevision(recordId: string, revisionId: string, cwd: string): Promise<MemoryRevision | undefined> {
    if (!/^[a-f0-9]{32}$/.test(recordId) || !revisionId) return undefined;
    const project = resolveProjectIdentity(cwd);
    const revisionDir = path.join(this.basePath("project", project.id), "revisions", recordId);
    const filepath = path.join(revisionDir, `${revisionId}.md`);
    if (!(await exists(filepath))) return undefined;
    try {
      const raw = await fs.readFile(filepath, "utf8");
      const rev = JSON.parse(raw) as MemoryRevision;
      if (rev.schemaVersion === 2 && rev.recordId === recordId && rev.revisionId === revisionId) {
        return rev;
      }
    } catch {
      // Corrupt revision
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

  private async listBase(base: string): Promise<MemoryRecord[]> {
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
