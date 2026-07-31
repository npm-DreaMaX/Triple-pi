import { describe, expect, it, vi } from "vitest";
import { ExtractionScheduler } from "../../extensions/memory/extraction/scheduler.ts";
import { deferred } from "../helpers/deferred.ts";

const extraction = vi.hoisted(() => ({ runExtraction: vi.fn() }));
vi.mock("../../extensions/memory/extraction/coordinator.ts", () => extraction);

function branch(leaf: string) {
  const entries = [
    { type: "message", id: "u1", parentId: null },
    { type: "message", id: "a1", parentId: "u1" },
  ];
  if (leaf !== "a1") entries.push({ type: "message", id: leaf, parentId: "a1" });
  return entries as any[];
}

function snapshot(leaf: string, lastProcessedEntryId?: string) {
  return {
    cwd: "/workspace/scheduler",
    sessionId: "session",
    branch: branch(leaf),
    branchLeafId: leaf,
    lastProcessedEntryId,
    model: {} as any,
    modelRegistry: {} as any,
  };
}

const repository = {
  updateExtractionDiagnostics: vi.fn(),
} as any;

describe("ExtractionScheduler races", () => {
  it("drops stale pending work and ignores a late result after a tree switch", async () => {
    const first = deferred<any>();
    extraction.runExtraction.mockReset().mockReturnValueOnce(first.promise);
    const scheduler = new ExtractionScheduler();
    const checkpoints: any[] = [];
    const settled = vi.fn();

    scheduler.start(snapshot("a1"), repository, (cp) => checkpoints.push(cp), settled);
    scheduler.start(snapshot("a2"), repository, (cp) => checkpoints.push(cp), settled);
    expect(scheduler.hasPending).toBe(true);

    scheduler.bumpGeneration();
    expect(scheduler.hasPending).toBe(false);
    first.resolve({ checkpoint: { lastEntryId: "a1", branchLeafId: "a1", sourceHash: "x", version: 1, savedCount: 1 }, savedCount: 1 });
    await first.promise;
    await vi.waitFor(() => expect(scheduler.isRunning).toBe(false));

    expect(checkpoints).toEqual([]);
    expect(extraction.runExtraction).toHaveBeenCalledOnce();
  });

  it("inherits a successful same-branch checkpoint offset into queued work", async () => {
    const first = deferred<any>();
    const second = deferred<any>();
    extraction.runExtraction.mockReset()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const scheduler = new ExtractionScheduler();
    const queued = snapshot("a2");

    scheduler.start(snapshot("a1"), repository, () => {}, () => {});
    scheduler.start(queued, repository, () => {}, () => {});
    first.resolve({ checkpoint: { lastEntryId: "a1", branchLeafId: "a1", sourceHash: "x", version: 1, savedCount: 1 }, savedCount: 1 });
    await vi.waitFor(() => expect(extraction.runExtraction).toHaveBeenCalledTimes(2));

    expect(queued.lastProcessedEntryId).toBe("a1");
    second.resolve({ status: "no-source", savedCount: 0 });
    await second.promise;
    await vi.waitFor(() => expect(scheduler.isRunning).toBe(false));
  });
});
