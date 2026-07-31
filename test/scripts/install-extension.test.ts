import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
let root: string;
let agentDir: string;
let binDir: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "triple-pi-install-"));
  agentDir = path.join(root, "agent");
  binDir = path.join(root, "bin");
});
afterEach(async () => fs.rm(root, { recursive: true, force: true }));

async function install(extraEnv: NodeJS.ProcessEnv = {}) {
  return run(process.execPath, [path.resolve("scripts/install-extension.mjs")], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      PI_CODING_AGENT_DIR: agentDir,
      TRIPLE_PI_BIN_DIR: binDir,
      ...extraEnv,
    },
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
    const legacyMemory = path.join(agentDir, "extensions", "memory");
    await fs.mkdir(path.dirname(legacyMemory), { recursive: true });
    await fs.symlink(path.resolve("extensions/memory"), legacyMemory);

    await install();

    await expect(fs.lstat(legacyMemory)).rejects.toThrow("ENOENT");
    const unifiedTarget = path.join(agentDir, "extensions", "triple-pi");
    expect((await fs.lstat(unifiedTarget)).isSymbolicLink()).toBe(true);
  });

  it("preserves an unrelated legacy memory symlink", async () => {
    const unrelated = path.join(root, "unrelated-memory");
    const legacyMemory = path.join(agentDir, "extensions", "memory");
    await fs.mkdir(unrelated);
    await fs.mkdir(path.dirname(legacyMemory), { recursive: true });
    await fs.symlink(unrelated, legacyMemory);

    await install();

    expect(await fs.realpath(legacyMemory)).toBe(await fs.realpath(unrelated));
  });

  it("installs the launcher only in the injected bin directory", async () => {
    await install();
    const launcher = path.join(binDir, "trip");
    expect((await fs.lstat(launcher)).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(launcher)).toBe(await fs.realpath(path.resolve("bin/trip")));
  });

  it.each([
    ["unrelated symlink", async (dest: string) => {
      const unrelated = path.join(root, "other-trip");
      await fs.writeFile(unrelated, "#!/bin/sh\n");
      await fs.symlink(unrelated, dest);
    }],
    ["regular file", async (dest: string) => fs.writeFile(dest, "user launcher\n")],
  ])("refuses to overwrite an existing %s", async (_label, createDest) => {
    const dest = path.join(binDir, "trip");
    await fs.mkdir(binDir, { recursive: true });
    await createDest(dest);

    await expect(install()).rejects.toMatchObject({ code: 1 });
  });

  it("installs a Windows launcher that calls back to the checkout and is idempotent", async () => {
    const env = { TRIPLE_PI_TEST_PLATFORM: "win32" };
    await install(env);
    const launcher = path.join(binDir, "trip.cmd");
    expect((await fs.lstat(launcher)).isFile()).toBe(true);
    const wrapper = await fs.readFile(launcher, "utf8");
    expect(wrapper).toContain(path.resolve("bin/trip"));
    await expect(install(env)).resolves.toMatchObject({ stdout: expect.stringContaining("already installed") });
  });
});
