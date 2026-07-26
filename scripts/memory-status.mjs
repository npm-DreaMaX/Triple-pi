#!/usr/bin/env node
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { FilesystemMemoryRepository } from "../extensions/memory/repository.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionSource = path.join(projectRoot, "extensions", "memory");
const agentDir = process.env.PI_CODING_AGENT_DIR
  ? path.resolve(process.env.PI_CODING_AGENT_DIR)
  : path.join(process.env.HOME || "", ".pi", "agent");
const extensionLink = path.join(agentDir, "extensions", "memory");
const cwdArg = process.argv.find((argument) => argument.startsWith("--cwd="));
const cwd = cwdArg ? path.resolve(cwdArg.slice("--cwd=".length)) : process.cwd();

let extensionInstalled = false;
let extensionTarget = "missing";
try {
  extensionTarget = await fs.realpath(extensionLink);
  extensionInstalled = extensionTarget === await fs.realpath(extensionSource);
} catch {}

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
  ...(verbose ? { extensionTarget, cwd, root: diagnostics.root } : {}),
}, null, 2));
process.exitCode = extensionInstalled && securePermissions && nodeCompatible ? 0 : 1;
