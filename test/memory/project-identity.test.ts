import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveProjectIdentity } from "../../extensions/memory/project-identity.ts";

let tempDir: string;
beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "triple-pi-project-id-"));
});
afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

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

  it("uses auto-derived id when no alias file exists", () => {
    const identity = resolveProjectIdentity(tempDir);
    expect(identity.aliased).toBe(false);
    expect(identity.aliasPath).toBeUndefined();
  });

  it("uses explicit alias id from .triple-pi/project.json", () => {
    const aliasDir = path.join(tempDir, ".triple-pi");
    fs.mkdirSync(aliasDir, { recursive: true });
    fs.writeFileSync(path.join(aliasDir, "project.json"), JSON.stringify({ projectId: "my-stable-proj" }));

    const identity = resolveProjectIdentity(tempDir);
    expect(identity.aliased).toBe(true);
    expect(identity.id).toBe("my-stable-proj");
    expect(identity.displayName).toBe("my-stable-proj");
  });

  it("two cloned directories with the same alias share the same id", () => {
    const cloneA = path.join(tempDir, "clone-a");
    const cloneB = path.join(tempDir, "clone-b");
    fs.mkdirSync(cloneA, { recursive: true });
    fs.mkdirSync(cloneB, { recursive: true });

    for (const clone of [cloneA, cloneB]) {
      const aliasDir = path.join(clone, ".triple-pi");
      fs.mkdirSync(aliasDir, { recursive: true });
      fs.writeFileSync(path.join(aliasDir, "project.json"), JSON.stringify({ projectId: "shared-project" }));
    }

    const idA = resolveProjectIdentity(cloneA);
    const idB = resolveProjectIdentity(cloneB);
    expect(idA.id).toBe("shared-project");
    expect(idB.id).toBe("shared-project");
    expect(idA.cwd).not.toBe(idB.cwd); // different cwd but same project
  });

  it("ignores malformed alias files", () => {
    const aliasDir = path.join(tempDir, ".triple-pi");
    fs.mkdirSync(aliasDir, { recursive: true });
    fs.writeFileSync(path.join(aliasDir, "project.json"), JSON.stringify({ projectId: "bad/id/with/slashes" }));

    const identity = resolveProjectIdentity(tempDir);
    expect(identity.aliased).toBe(false);
  });

  it("ignores alias file that is not valid JSON", () => {
    const aliasDir = path.join(tempDir, ".triple-pi");
    fs.mkdirSync(aliasDir, { recursive: true });
    fs.writeFileSync(path.join(aliasDir, "project.json"), "not json");

    const identity = resolveProjectIdentity(tempDir);
    expect(identity.aliased).toBe(false);
  });
});
