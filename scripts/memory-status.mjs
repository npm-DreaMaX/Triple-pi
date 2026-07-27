#!/usr/bin/env node
/**
 * memory-status.mjs — 报告 unified triple-pi extension 状态
 *
 * 检查:
 *  - unified extension 是否存在
 *  - memoryInstalled (memory 子模块可用)
 *  - reviewerInstalled (reviewer 子模块可用)
 *  - legacyDuplicateDetected (旧 memory 独立链接是否存在)
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { FilesystemMemoryRepository } from "../extensions/memory/repository.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionSource = path.join(projectRoot, "extensions");
const agentDir = process.env.PI_CODING_AGENT_DIR
  ? path.resolve(process.env.PI_CODING_AGENT_DIR)
  : path.join(process.env.HOME || "", ".pi", "agent");
const extensionDir = path.join(agentDir, "extensions");
const unifiedLink = path.join(extensionDir, "triple-pi");
const oldMemoryLink = path.join(extensionDir, "memory");
const cwdArg = process.argv.find((argument) => argument.startsWith("--cwd="));
const cwd = cwdArg ? path.resolve(cwdArg.slice("--cwd=".length)) : process.cwd();

// ── Check unified extension installation ──
let extensionInstalled = false;
let extensionTarget = "missing";
try {
  extensionTarget = await fs.realpath(unifiedLink);
  extensionInstalled = extensionTarget === await fs.realpath(extensionSource);
} catch {}

// ── Check sub-module availability ──
let memoryInstalled = false;
let reviewerInstalled = false;
if (extensionInstalled) {
  try {
    await fs.access(path.join(extensionSource, "memory", "index.ts"));
    memoryInstalled = true;
  } catch {}
  try {
    await fs.access(path.join(extensionSource, "subagent", "index.ts"));
    reviewerInstalled = true;
  } catch {}
}

// ── Check legacy duplicate ──
let legacyDuplicateDetected = false;
try {
  const oldStat = await fs.lstat(oldMemoryLink);
  if (oldStat.isSymbolicLink()) {
    const oldTargetPath = await fs.realpath(oldMemoryLink);
    const oldSourcePath = await fs.realpath(path.join(projectRoot, "extensions", "memory"));
    const sourceReal = await fs.realpath(extensionSource);
    if (oldTargetPath === oldSourcePath || oldTargetPath === sourceReal) {
      legacyDuplicateDetected = true;
    }
  } else if (oldStat.isDirectory()) {
    // A non-symlink directory at the old path counts as duplicate
    legacyDuplicateDetected = true;
  }
} catch {}

// ── Memory diagnostics ──
const diagnostics = await new FilesystemMemoryRepository().diagnose(cwd);
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
const nodeCompatible = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 19);
const rootExists = diagnostics.permissions !== "missing";
const securePermissions = !rootExists || diagnostics.permissions === "700";
const verbose = process.argv.includes("--verbose");

console.log(JSON.stringify({
  version: "1.0.0-rc.1",
  nodeCompatible,
  extensionInstalled,
  memoryInstalled,
  reviewerInstalled,
  legacyDuplicateDetected,
  schemaVersion: diagnostics.schemaVersion,
  projectId: diagnostics.project.id,
  lifecycle: diagnostics.lifecycle,
  inactivityDays: diagnostics.inactivityDays,
  longTermCount: diagnostics.longTermCount,
  extractionManifestCount: diagnostics.extractionManifestCount,
  workingManifestCount: diagnostics.workingManifestCount,
  hasScratchpad: diagnostics.hasScratchpad,
  hasRecentDaily: diagnostics.hasRecentDaily,
  rootExists,
  rootMode: diagnostics.permissions,
  securePermissions,
  ...(verbose ? { extensionTarget, unifiedLink, cwd, root: diagnostics.root } : {}),
}, null, 2));

process.exitCode = extensionInstalled && securePermissions && nodeCompatible ? 0 : 1;
