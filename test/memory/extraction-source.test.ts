import { describe, expect, it } from "vitest";
import { buildExtractionSource, findCheckpoint, MEMORY_CHECKPOINT_TYPE } from "../../extensions/memory/extraction/source.ts";

function user(id: string, content: string, parentId: string | null = null) {
  return { type: "message", id, parentId, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content, timestamp: 0 } };
}
function assistant(id: string, content: string, parentId: string) {
  return { type: "message", id, parentId, timestamp: "2026-01-01T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: content }], timestamp: 1 } };
}
function manager(branch: any[], leafId = branch.at(-1)?.id || null) {
  return { getBranch: () => branch, getLeafId: () => leafId } as any;
}

describe("branch-aware extraction source", () => {
  it("uses only entries returned by the current branch", () => {
    const active = [user("u1", "Use ports and adapters."), assistant("a1", "Understood.", "u1")];
    const source = buildExtractionSource(manager(active));

    expect(source?.sourceEntryIds).toEqual(["u1", "a1"]);
    expect(source?.messages.map((message) => message.content)).not.toContain("abandoned branch");
  });

  it("only includes entries after the branch-local checkpoint", () => {
    const checkpoint = {
      type: "custom", id: "cp", parentId: "a1", timestamp: "2026-01-01T00:00:02Z",
      customType: MEMORY_CHECKPOINT_TYPE,
      data: { version: 1, sourceHash: "old", lastEntryId: "a1", branchLeafId: "a1", savedCount: 1 },
    };
    const branch = [
      user("u1", "Old rule"), assistant("a1", "Old answer", "u1"), checkpoint,
      user("u2", "New durable rule", "cp"), assistant("a2", "Acknowledged", "u2"),
    ];
    const source = buildExtractionSource(manager(branch));

    expect(source?.sourceEntryIds).toEqual(["u2", "a2"]);
    expect(findCheckpoint(branch as any)?.lastEntryId).toBe("a1");
  });

  it("returns no source without a user/assistant segment", () => {
    expect(buildExtractionSource(manager([user("u1", "Only one message")]))).toBeUndefined();
  });

  it("produces a stable hash for the same branch delta", () => {
    const branch = [user("u1", "Remember strict TypeScript."), assistant("a1", "Okay", "u1")];
    expect(buildExtractionSource(manager(branch))?.sourceHash)
      .toBe(buildExtractionSource(manager(branch))?.sourceHash);
  });
});
