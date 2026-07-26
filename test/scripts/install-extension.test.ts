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
  it("installs and is idempotent in a custom Pi agent dir", async () => {
    await install();
    const target = path.join(agentDir, "extensions", "memory");
    expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
    await expect(install()).resolves.toMatchObject({ stdout: expect.stringContaining("already installed") });
  });

  it("replaces a broken symlink", async () => {
    const target = path.join(agentDir, "extensions", "memory");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(path.join(agentDir, "missing"), target);
    await install();
    expect(await fs.realpath(target)).toBe(await fs.realpath(path.resolve("extensions/memory")));
  });

  it("refuses to overwrite a regular directory", async () => {
    await fs.mkdir(path.join(agentDir, "extensions", "memory"), { recursive: true });
    await expect(install()).rejects.toMatchObject({ code: 1 });
  });
});
