import type { FilesystemMemoryRepository } from "../repository.ts";
import { runExtraction, type ExtractionSnapshot } from "./coordinator.ts";
import type { ExtractionCheckpoint } from "./source.ts";

// ═══════════════════════════════════════════════════════════════
// Branch-safe Extraction Scheduler
// ═══════════════════════════════════════════════════════════════

export interface SchedulerJob {
  generation: number;
  sessionId: string;
  branchLeafId: string | null;
  snapshot: ExtractionSnapshot;
}

export interface ExtractionDiagnosticsCallback {
  onAttempt?: (snapshot: ExtractionSnapshot) => void;
  onSuccess?: (snapshot: ExtractionSnapshot) => void;
  onFailure?: (stage: string, code: string, error: unknown, snapshot: ExtractionSnapshot) => void;
}

function isSameBranchLine(
  ancestor: Pick<ExtractionSnapshot, "sessionId" | "branchLeafId">,
  descendant: ExtractionSnapshot,
): boolean {
  if (ancestor.sessionId !== descendant.sessionId) return false;
  if (ancestor.branchLeafId === descendant.branchLeafId) return true;
  if (ancestor.branchLeafId === null) return true;
  const entries = new Map(descendant.branch.map((entry) => [entry.id, entry]));
  let cursor = descendant.branchLeafId;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    if (cursor === ancestor.branchLeafId) return true;
    seen.add(cursor);
    cursor = entries.get(cursor)?.parentId ?? null;
  }
  return false;
}

export class ExtractionScheduler {
  private task: Promise<void> | undefined;
  private abort: AbortController | undefined;
  private generation = 0;
  private pending: ExtractionSnapshot | undefined;
  private currentJob: SchedulerJob | undefined;
  private lastSuccessful: {
    checkpoint: ExtractionCheckpoint;
    sessionId: string;
    branchLeafId: string | null;
  } | undefined;
  private diagnosticsCallbacks: ExtractionDiagnosticsCallback[] = [];

  /** Register an extraction-failure diagnostics callback. */
  onDiagnostics(cb: ExtractionDiagnosticsCallback): void {
    this.diagnosticsCallbacks.push(cb);
  }

  /** Start extraction; queue if one is already running. */
  start(
    snapshot: ExtractionSnapshot,
    repository: FilesystemMemoryRepository,
    appendCheckpoint: (checkpoint: ExtractionCheckpoint) => void,
    onSettled: () => void,
  ): void {
    const gen = this.generation;
    if (this.task || this.abort) {
      const base = this.pending ?? this.currentJob?.snapshot;
      if (base && isSameBranchLine(base, snapshot)) {
        snapshot.lastProcessedEntryId = base.lastProcessedEntryId;
      }
      this.pending = snapshot;
      repository.updateExtractionDiagnostics({ running: true, pending: true });
      return;
    }
    if (
      this.lastSuccessful &&
      isSameBranchLine(this.lastSuccessful, snapshot)
    ) {
      snapshot.lastProcessedEntryId = this.lastSuccessful.checkpoint.lastEntryId;
    }
    repository.updateExtractionDiagnostics({ running: true, pending: false, attempted: true });
    for (const cb of this.diagnosticsCallbacks) {
      try { cb.onAttempt?.(snapshot); } catch {}
    }
    const controller = new AbortController();
    this.abort = controller;
    const job: SchedulerJob = {
      generation: gen,
      sessionId: snapshot.sessionId,
      branchLeafId: snapshot.branchLeafId,
      snapshot,
    };
    this.currentJob = job;
    this.task = runExtraction(repository, snapshot, controller.signal)
      .then((result) => {
        // Only commit the checkpoint when:
        //  1. The generation hasn't been bumped (no tree switch / shutdown).
        //  2. The session and branch leaf still match.
        //  3. The abort hasn't been signalled.
        if (
          result.checkpoint &&
          gen === this.generation &&
          job.sessionId === snapshot.sessionId &&
          job.branchLeafId === snapshot.branchLeafId &&
          !controller.signal.aborted
        ) {
          if (this.pending?.sessionId === snapshot.sessionId) {
            (result.checkpoint as { savedCount: number }).savedCount =
              result.savedCount;
          }
          this.lastSuccessful = {
            checkpoint: result.checkpoint,
            sessionId: snapshot.sessionId,
            branchLeafId: snapshot.branchLeafId,
          };
          repository.updateExtractionDiagnostics({ succeeded: true });
          appendCheckpoint(result.checkpoint);
          for (const cb of this.diagnosticsCallbacks) {
            try { cb.onSuccess?.(snapshot); } catch {}
          }
        }
      })
      .catch((error) => {
        // A cancelled task that was aborted by the scheduler itself (tree switch,
        // shutdown, cancel) is expected lifecycle, not a real failure.
        if (controller.signal.aborted) {
          repository.updateExtractionDiagnostics({ running: false });
        } else {
          repository.updateExtractionDiagnostics({
            failureStage: "extraction",
            failureCode: "EXTRACTION_FAILED",
          });
        }

        // Extraction is fail-closed. Notify diagnostics callbacks if it wasn't
        // an intentional abort (callbacks may still fire for real failures).
        if (!controller.signal.aborted) {
          for (const cb of this.diagnosticsCallbacks) {
            try {
              cb.onFailure?.("extraction", "EXTRACTION_FAILED", error, snapshot);
            } catch {
              // Diagnostics must not throw.
            }
          }
        }
      })
      .finally(() => {
        if (this.abort === controller) this.abort = undefined;
        if (this.currentJob === job) this.currentJob = undefined;
        this.task = undefined;
        const next = this.pending;
        this.pending = undefined;
        repository.updateExtractionDiagnostics({ running: false, pending: next !== undefined });
        onSettled();
        if (next) this.start(next, repository, appendCheckpoint, onSettled);
      });
  }

  /** Cancel in-flight extraction, increment generation, and clear pending. */
  cancel(): void {
    this.generation += 1;
    this.abort?.abort();
    this.pending = undefined;
    this.currentJob = undefined;
    this.lastSuccessful = undefined;
  }

  /** Invalidate all work from the previous tree, including queued snapshots. */
  bumpGeneration(): void {
    this.generation += 1;
    this.abort?.abort();
    this.pending = undefined;
    this.currentJob = undefined;
    this.lastSuccessful = undefined;
  }

  /** Flush and wait up to 1s for shutdown. */
  async shutdown(): Promise<void> {
    this.generation += 1;
    this.pending = undefined;
    this.currentJob = undefined;
    this.lastSuccessful = undefined;
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

  get hasPending(): boolean {
    return this.pending !== undefined;
  }
}
