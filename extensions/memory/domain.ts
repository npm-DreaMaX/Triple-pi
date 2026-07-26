export const MEMORY_SCHEMA_VERSION = 1;

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

export interface ProjectMemoryMetadata {
  schemaVersion: typeof MEMORY_SCHEMA_VERSION;
  projectId: string;
  displayName: string;
  cwd: string;
  status: ProjectMemoryStatus;
  lastActiveAt: string;
  archivedAt?: string;
}

export interface MemoryProvenance {
  source: "manual" | "extraction";
  sessionId?: string;
  sourceEntryIds?: string[];
  sourceHash?: string;
  fingerprint?: string;
  score?: number;
  reinforcement?: number;
  correction?: boolean;
  revisionOf?: string;
}

export interface MemoryRecord {
  schemaVersion: typeof MEMORY_SCHEMA_VERSION;
  id: string;
  category: MemoryCategory;
  scope: MemoryScope;
  projectId: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  provenance: MemoryProvenance;
}

export interface MemorySearchResult {
  record: MemoryRecord;
  snippet: string;
  archived: boolean;
}

export function isMemoryCategory(value: string): value is MemoryCategory {
  return (MEMORY_CATEGORIES as readonly string[]).includes(value);
}
