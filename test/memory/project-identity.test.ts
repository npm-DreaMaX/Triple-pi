import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveProjectIdentity } from "../../extensions/memory/project-identity.ts";

describe("resolveProjectIdentity", () => {
  it("is stable for the same canonical cwd", () => {
    const cwd = path.join(path.sep, "work", "team", "service-a");
    expect(resolveProjectIdentity(cwd)).toEqual(resolveProjectIdentity(path.join(cwd, ".")));
  });

  it("isolates workspaces even when their basename is the same", () => {
    const first = resolveProjectIdentity(path.join(path.sep, "work", "team-a", "api"));
    const second = resolveProjectIdentity(path.join(path.sep, "work", "team-b", "api"));

    expect(first.displayName).toBe("api");
    expect(second.displayName).toBe("api");
    expect(first.id).not.toBe(second.id);
  });

  it("does not allow path characters into the id", () => {
    const identity = resolveProjectIdentity(path.join(path.sep, "work", "中文 project"));
    expect(identity.id).toMatch(/^[a-zA-Z0-9._-]+$/);
    expect(identity.id).not.toContain(path.sep);
  });

  it("rejects an empty cwd", () => {
    expect(() => resolveProjectIdentity("  ")).toThrow("must not be empty");
  });
});
