/** Per-record schema version (may differ from storage layout version). */
export const MEMORY_RECORD_SCHEMA_VERSION = 2;

export const MEMORY_CATEGORIES = [
  "preference",
  "decision",
  "rule",
  "fact",
  "knowledge",
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];
export type MemoryScope = "global" | "project";
export type ProjectMemoryStatus = "active" | "archived";

// ── Project metadata (separate version from records) ──────────────
export interface ProjectMemoryMetadata {
  schemaVersion: number;
  projectId: string;
  displayName: string;
  cwd: string;
  status: ProjectMemoryStatus;
  lastActiveAt: string;
  archivedAt?: string;
}

// ── Evidence & scope decision ─────────────────────────────────────
export interface MemoryEvidence {
  quote: string;
  sourceEntryId: string;
  role: "user";
  quoteHash: string;
}

export interface ScopeDecision {
  requested: MemoryScope;
  resolved: MemoryScope;
  reason:
    | "user-confirmed-manual"
    | "explicit-cross-project-evidence"
    | "missing-cross-project-evidence"
    | "default-project";
  evidence?: MemoryEvidence;
}

// ── Revision pointer ──────────────────────────────────────────────
export interface RevisionPointer {
  revisionId: string;
  previousRevisionId?: string;
}

// ── Provenance ────────────────────────────────────────────────────
export interface MemoryProvenance {
  source: "manual" | "extraction";
  sessionId?: string;
  sourceEntryIds?: string[];
  sourceHash?: string;
  fingerprint?: string;
  score?: number;
  reinforcement?: number;
  correction?: boolean;
  /** Evidence quote(s) that grounded this record. Present for extraction records, absent for manual. */
  evidence?: MemoryEvidence[];
  /** Scope decision for automatic extraction records. */
  scopeDecision?: ScopeDecision;
  /** Immutable revision chain pointer. */
  revision?: RevisionPointer;
  /** @deprecated Use revision.previousRevisionId instead. */
  revisionOf?: string;
}

// ── Record ────────────────────────────────────────────────────────
export interface MemoryRecord {
  schemaVersion: typeof MEMORY_RECORD_SCHEMA_VERSION;
  id: string;
  category: MemoryCategory;
  scope: MemoryScope;
  projectId: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  provenance: MemoryProvenance;
  /** 3a M3: retrieval keywords (aliases/synonyms/acronyms), e.g. "PyG" for PyTorch Geometric.
   *  Optional for backward compat with pre-keywords records. Indexed into search matching
   *  with top weight; extraction emits them, manual saves may provide them. */
  keywords?: string[];
}

// ── V1 compatibility (for reading old records) ────────────────────
export interface MemoryRecordV1 {
  schemaVersion: 1;
  id: string;
  category: MemoryCategory;
  scope: MemoryScope;
  projectId: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  provenance: Omit<MemoryProvenance, "evidence" | "scopeDecision" | "revision">;
}

export interface MemorySearchResult {
  record: MemoryRecord;
  snippet: string;
  archived: boolean;
}

// ── Revision ──────────────────────────────────────────────────────
export interface MemoryRevision {
  schemaVersion: 2;
  revisionId: string;
  recordId: string;
  title: string;
  content: string;
  provenance: MemoryProvenance;
  createdAt: string;
  capturedAt: string;
}

export function isMemoryCategory(value: string): value is MemoryCategory {
  return (MEMORY_CATEGORIES as readonly string[]).includes(value);
}
