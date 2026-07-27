import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
let agentDir: string;
beforeEach(async () => { agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "triple-pi-install-")); });
afterEach(async () => fs.rm(agentDir, { recursive: true, force: true }));

async function install() {
  return run(process.execPath, [path.resolve("scripts/install-extension.mjs")], {
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
  });
}

describe("extension installer", () => {
  it("installs unified extension and is idempotent", async () => {
    await install();

    // Unified extension should be installed at extensions/triple-pi
    const unifiedTarget = path.join(agentDir, "extensions", "triple-pi");
    expect((await fs.lstat(unifiedTarget)).isSymbolicLink()).toBe(true);

    // Idempotent
    await expect(install()).resolves.toMatchObject({ stdout: expect.stringContaining("already installed") });
  });

  it("replaces a broken symlink", async () => {
    const unifiedTarget = path.join(agentDir, "extensions", "triple-pi");
    await fs.mkdir(path.dirname(unifiedTarget), { recursive: true });
    await fs.symlink(path.join(agentDir, "missing"), unifiedTarget);
    await install();
    expect(await fs.realpath(unifiedTarget)).toBe(await fs.realpath(path.resolve("extensions")));
  });

  it("refuses to overwrite a regular directory", async () => {
    await fs.mkdir(path.join(agentDir, "extensions", "triple-pi"), { recursive: true });
    await expect(install()).rejects.toMatchObject({ code: 1 });
  });

  it("migrates legacy memory-only symlink to unified extension", async () => {
    // Create legacy memory symlink pointing to our project
    const legacyMemory = path.join(agentDir, "extensions", "memory");
    await fs.mkdir(path.dirname(legacyMemory), { recursive: true });
    await fs.symlink(path.resolve("extensions/memory"), legacyMemory);

    await install();

    // Legacy should be removed
    await expect(fs.lstat(legacyMemory)).rejects.toThrow("ENOENT");
    // Unified should be installed
    const unifiedTarget = path.join(agentDir, "extensions", "triple-pi");
    expect((await fs.lstat(unifiedTarget)).isSymbolicLink()).toBe(true);
  });
});
