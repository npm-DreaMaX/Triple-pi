#!/usr/bin/env node
/**
 * Install Triple-pi globally:
 *   1. Link extensions/ to Pi's agent directory
 *   2. Link bin/trip to ~/.local/bin/ or ~/bin/
 */

import * as fs from "node:fs/promises";
import { homedir, platform as hostPlatform } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const homeDir = homedir();
const agentDir = process.env.PI_CODING_AGENT_DIR
  ? path.resolve(process.env.PI_CODING_AGENT_DIR)
  : path.join(homeDir, ".pi", "agent");
const installPlatform = process.env.NODE_ENV === "test" && process.env.TRIPLE_PI_TEST_PLATFORM
  ? process.env.TRIPLE_PI_TEST_PLATFORM
  : hostPlatform();

async function sameRealpath(left, right) {
  try {
    return await fs.realpath(left) === await fs.realpath(right);
  } catch {
    return false;
  }
}

function refuseOverwrite(target) {
  console.error(`[triple-pi] Refusing to overwrite unowned launcher: ${target}`);
  process.exitCode = 1;
}

// ═══════════════════════════════════════════════════════════
// 1. Install extension
// ═══════════════════════════════════════════════════════════

const extSource = path.join(projectRoot, "extensions");
const extTarget = path.join(agentDir, "extensions", "triple-pi");
const oldTarget = path.join(agentDir, "extensions", "memory");

// Clean up only the legacy link owned by this checkout. Unrelated links are user data.
try {
  const oldStat = await fs.lstat(oldTarget);
  const legacySources = [path.join(extSource, "memory"), extSource];
  if (oldStat.isSymbolicLink()
    && (await Promise.all(legacySources.map((source) => sameRealpath(oldTarget, source)))).some(Boolean)) {
    await fs.unlink(oldTarget);
    console.log(`[triple-pi] Removed old symlink: ${oldTarget}`);
  }
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}

// Install unified extension
let extNeedsInstall = true;
try {
  const stat = await fs.lstat(extTarget);
  if (stat.isSymbolicLink()) {
    try {
      if (await fs.realpath(extTarget) === await fs.realpath(extSource)) {
        console.log(`[triple-pi] Extension already installed: ${extTarget}`);
        extNeedsInstall = false;
      } else {
        await fs.unlink(extTarget);
      }
    } catch {
      await fs.unlink(extTarget);
    }
  } else {
    console.error(`Refusing to overwrite non-symlink: ${extTarget}`);
    process.exit(1);
  }
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}

if (extNeedsInstall) {
  const extDir = path.dirname(extTarget);
  await fs.mkdir(extDir, { recursive: true, mode: 0o700 });
  await fs.symlink(extSource, extTarget, "dir");
  console.log(`[triple-pi] Installed extension: ${extTarget} -> ${extSource}`);
}

// ═══════════════════════════════════════════════════════════
// 2. Install global launcher (trip)
// ═══════════════════════════════════════════════════════════

const windows = installPlatform === "win32";
const launcherSource = path.join(projectRoot, "bin", "trip");
const explicitBinDir = process.env.TRIPLE_PI_BIN_DIR;
const pathCandidates = explicitBinDir
  ? [path.resolve(explicitBinDir)]
  : windows
    ? [path.join(homeDir, "bin")]
    : [path.join(homeDir, ".local", "bin"), path.join(homeDir, "bin")];

let installed = false;
for (const binDir of pathCandidates) {
  const dest = path.join(binDir, windows ? "trip.cmd" : "trip");
  try {
    await fs.mkdir(binDir, { recursive: true, mode: 0o755 });

    try {
      const stat = await fs.lstat(dest);
      if (windows && stat.isFile()) {
        // The installed wrapper calls the checkout launcher at the absolute path.
        // If the wrapper already contains the current projectRoot, it is installed.
        const current = await fs.readFile(dest, "utf8");
        if (current.includes(launcherSource)) {
          console.log(`[triple-pi] Launcher already installed: ${dest}`);
          installed = true;
          break;
        }
      } else if (!windows && stat.isSymbolicLink() && await sameRealpath(dest, launcherSource)) {
        console.log(`[triple-pi] Launcher already linked: ${dest}`);
        installed = true;
        break;
      }

      refuseOverwrite(dest);
      break;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }

    if (windows) {
      // Generate a self-contained .cmd wrapper that does NOT depend on its own
      // location. Copying trip.bat would break because it resolves REPO_ROOT via
      // %~dp0 relative to the installed location, not the checkout.
      const wrapper = [
        "@echo off",
        `call "${launcherSource}" %*`,
        "exit /b %ERRORLEVEL%",
      ].join("\r\n") + "\r\n";
      await fs.writeFile(dest, wrapper, { flag: "wx", mode: 0o755 });
      console.log(`[triple-pi] Installed Windows launcher: ${dest}`);
    } else {
      await fs.symlink(launcherSource, dest);
      console.log(`[triple-pi] Linked launcher: ${dest}`);
    }
    installed = true;
    break;
  } catch (e) {
    // Permission denied, try the next default candidate. An explicit target is final.
    if (e.code !== "EACCES" && e.code !== "EPERM") throw e;
    if (explicitBinDir) throw e;
  }
}

if (!installed && process.exitCode !== 1) {
  process.exitCode = 1;
  if (windows) {
    console.error(`[triple-pi] Launcher was not installed. Run ${launcherSource} directly.`);
  } else {
    console.error(`[triple-pi] Launcher was not installed. Run ${launcherSource} directly.`);
  }
}
