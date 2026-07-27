#!/usr/bin/env node
/**
 * Install Triple-pi globally:
 *   1. Link extensions/ to Pi's agent directory
 *   2. Link bin/trip to ~/.local/bin/ or ~/bin/
 */

import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = process.env.PI_CODING_AGENT_DIR
  ? path.resolve(process.env.PI_CODING_AGENT_DIR)
  : path.join(homedir(), ".pi", "agent");

// ═══════════════════════════════════════════════════════════
// 1. Install extension
// ═══════════════════════════════════════════════════════════

const extSource = path.join(projectRoot, "extensions");
const extTarget = path.join(agentDir, "extensions", "triple-pi");
const oldTarget = path.join(agentDir, "extensions", "memory");

// Clean up old per-extension symlink
try {
  const oldStat = await fs.lstat(oldTarget);
  if (oldStat.isSymbolicLink()) {
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

const launcherSource = path.join(projectRoot, "bin", "trip");
const pathCandidates = [
  path.join(homedir(), ".local", "bin"),
  path.join(homedir(), "bin"),
];

let linked = false;
for (const binDir of pathCandidates) {
  const dest = path.join(binDir, "trip");
  try {
    await fs.mkdir(binDir, { recursive: true, mode: 0o755 });

    // Check existing
    let needsLink = true;
    try {
      const s = await fs.lstat(dest);
      if (s.isSymbolicLink()) {
        try {
          if (await fs.realpath(dest) === launcherSource) {
            console.log(`[triple-pi] Launcher already linked: ${dest}`);
            needsLink = false;
          }
        } catch {}
      }
      if (needsLink) await fs.unlink(dest);
    } catch (e) {
      if (e.code !== "ENOENT") { needsLink = false; }
    }

    if (needsLink) {
      await fs.symlink(launcherSource, dest);
      console.log(`[triple-pi] Linked launcher: ${dest}`);
    }
    linked = true;
    break;
  } catch (e) {
    // Permission denied, try next candidate
    if (e.code !== "EACCES" && e.code !== "EPERM") throw e;
  }
}

if (!linked) {
  console.log(`[triple-pi] Add alias manually:`);
  console.log(`  echo "alias trip='${launcherSource}'" >> ~/.zshrc && source ~/.zshrc`);
}
