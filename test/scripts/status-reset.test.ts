import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
let home: string;
let agentDir: string;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "triple-pi-ops-"));
  agentDir = path.join(home, "agent");
  await fs.mkdir(path.join(agentDir, "extensions"), { recursive: true });
  await fs.symlink(path.resolve("extensions/memory"), path.join(agentDir, "extensions", "memory"));
});
afterEach(async () => fs.rm(home, { recursive: true, force: true }));

const env = () => ({ ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, TRIPLE_PI_MEMORY_ROOT: path.join(home, ".triple-pi", "memory-v1") });

describe("memory operations scripts", () => {
  it("status is read-only when the memory root is missing", async () => {
    const root = path.join(home, ".triple-pi", "memory-v1");
    const { stdout } = await run(process.execPath, ["--experimental-strip-types", path.resolve("scripts/memory-status.mjs")], { env: env() });
    expect(JSON.parse(stdout)).toMatchObject({ extensionInstalled: true, rootExists: false, securePermissions: true });
    await expect(fs.access(root)).rejects.toThrow();
  });

  it("status rejects insecure root permissions", async () => {
    const root = path.join(home, ".triple-pi", "memory-v1");
    await fs.mkdir(root, { recursive: true, mode: 0o777 });
    await fs.chmod(root, 0o777);
    await expect(run(process.execPath, ["--experimental-strip-types", path.resolve("scripts/memory-status.mjs")], { env: env() }))
      .rejects.toMatchObject({ code: 1 });
  });

  it("reset dry-run does not move current project data", async () => {
    const project = path.join(home, "project");
    await fs.mkdir(project);
    const { resolveProjectIdentity } = await import("../../extensions/memory/project-identity.ts");
    const target = path.join(home, ".triple-pi", "memory-v1", "projects", resolveProjectIdentity(project).id);
    await fs.mkdir(target, { recursive: true });
    await run(process.execPath, [path.resolve("scripts/memory-reset.mjs"), "--dry-run", `--cwd=${project}`], { env: env() });
    expect((await fs.stat(target)).isDirectory()).toBe(true);
  });

  it("reset moves current project data to quarantine", async () => {
    const project = path.join(home, "project");
    await fs.mkdir(project);
    const { resolveProjectIdentity } = await import("../../extensions/memory/project-identity.ts");
    const target = path.join(home, ".triple-pi", "memory-v1", "projects", resolveProjectIdentity(project).id);
    await fs.mkdir(target, { recursive: true });
    const projectId = resolveProjectIdentity(project).id;
    const manifest = path.join(home, ".triple-pi", "memory-v1", "extractions", projectId);
    const signals = path.join(home, ".triple-pi", "memory-v1", "signals", projectId);
    await fs.mkdir(manifest, { recursive: true });
    await fs.mkdir(signals, { recursive: true });
    await run(process.execPath, [path.resolve("scripts/memory-reset.mjs"), "--yes", `--cwd=${project}`], { env: env() });
    await expect(fs.access(target)).rejects.toThrow();
    await expect(fs.access(manifest)).rejects.toThrow();
    await expect(fs.access(signals)).rejects.toThrow();
    const quarantine = path.join(home, ".triple-pi", "quarantine");
    expect((await fs.readdir(quarantine)).length).toBe(1);
  });
});
