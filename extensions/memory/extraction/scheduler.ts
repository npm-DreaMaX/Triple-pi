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
  onFailure?: (stage: string, code: string, error: unknown) => void;
}

export class ExtractionScheduler {
  private task: Promise<void> | undefined;
  private abort: AbortController | undefined;
  private generation = 0;
  private pending: ExtractionSnapshot | undefined;
  private currentJob: SchedulerJob | undefined;
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
      // Merge pending only when same session AND same branch ancestor
      if (
        this.pending &&
        this.pending.sessionId === snapshot.sessionId
      ) {
        // Carry forward the lastProcessedEntryId so the delta offset is preserved
        if (this.currentJob) {
          (snapshot as { lastProcessedEntryId?: string }).lastProcessedEntryId =
            this.pending.lastProcessedEntryId;
        }
      }
      this.pending = snapshot;
      return;
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
          appendCheckpoint(result.checkpoint);
        }
      })
      .catch((error) => {
        // Extraction is fail-closed. Notify diagnostics callbacks.
        for (const cb of this.diagnosticsCallbacks) {
          try {
            cb.onFailure?.("extraction", "EXTRACTION_FAILED", error);
          } catch {
            // Diagnostics must not throw.
          }
        }
      })
      .finally(() => {
        if (this.abort === controller) this.abort = undefined;
        if (this.currentJob === job) this.currentJob = undefined;
        this.task = undefined;
        const next = this.pending;
        this.pending = undefined;
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
  }

  /** Increment generation (for tree switches) — abort current but keep pending. */
  bumpGeneration(): void {
    this.generation += 1;
    this.abort?.abort();
  }

  /** Flush and wait up to 1s for shutdown. */
  async shutdown(): Promise<void> {
    this.generation += 1;
    this.pending = undefined;
    this.currentJob = undefined;
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
