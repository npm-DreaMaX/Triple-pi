#!/usr/bin/env node
/**
 * install-extension.mjs — 安装 unified triple-pi extension
 *
 * 将 extensions/ 整个目录链接到 ~/.pi/agent/extensions/triple-pi
 * 兼容旧安装: 自动删除指向本项目 extensions/memory 的旧 symlink
 */

import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(projectRoot, "extensions");  // entire extensions directory
const agentDir = process.env.PI_CODING_AGENT_DIR
  ? path.resolve(process.env.PI_CODING_AGENT_DIR)
  : path.join(homedir(), ".pi", "agent");
const extensionsDir = path.join(agentDir, "extensions");
const target = path.join(extensionsDir, "triple-pi");  // new unified target
const oldTarget = path.join(extensionsDir, "memory");   // old per-extension target

// Verify source exists
await fs.access(source);

// ── 1. Remove old symlink if it points to our project ──
try {
  const oldStat = await fs.lstat(oldTarget);
  if (oldStat.isSymbolicLink()) {
    let existing = "broken";
    try { existing = await fs.realpath(oldTarget); } catch {}
    const oldSourceOld = path.join(projectRoot, "extensions", "memory");
    const oldSourceNew = path.join(projectRoot, "extensions");
    if (existing === await fs.realpath(oldSourceOld) || existing === await fs.realpath(oldSourceNew)) {
      await fs.unlink(oldTarget);
      console.log(`[triple-pi] Removed old symlink: ${oldTarget}`);
    }
  } else {
    // Refuse to overwrite non-symlink path
    console.error(`Refusing to overwrite non-symlink path: ${oldTarget}`);
    process.exit(1);
  }
} catch (error) {
  if ((error).code !== "ENOENT") {
    // ENOENT means old target doesn't exist, which is fine
    // Other errors might be serious
    if ((error).code !== "ENOENT") throw error;
  }
}

// ── 2. Check if our new target already exists ──
try {
  const stat = await fs.lstat(target);
  if (!stat.isSymbolicLink()) {
    console.error(`Refusing to overwrite non-symlink extension path: ${target}`);
    process.exit(1);
  }
  let existing = "broken";
  try { existing = await fs.realpath(target); } catch {}
  if (existing === await fs.realpath(source)) {
    console.log(`[triple-pi] Unified extension already installed: ${target}`);
    process.exit(0);
  }
  // It's a symlink pointing elsewhere; replace it
  await fs.unlink(target);
} catch (error) {
  if ((error).code !== "ENOENT") throw error;
}

// ── 3. Create the new symlink ──
await fs.mkdir(extensionsDir, { recursive: true, mode: 0o700 });
await fs.symlink(source, target, "dir");
console.log(`[triple-pi] Installed unified extension: ${target} -> ${source}`);
