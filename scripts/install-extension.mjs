#!/usr/bin/env node
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(projectRoot, "extensions", "memory");
const agentDir = process.env.PI_CODING_AGENT_DIR
  ? path.resolve(process.env.PI_CODING_AGENT_DIR)
  : path.join(homedir(), ".pi", "agent");
const extensionsDir = path.join(agentDir, "extensions");
const target = path.join(extensionsDir, "memory");
await fs.access(path.join(source, "index.ts"));
await fs.mkdir(extensionsDir, { recursive: true, mode: 0o700 });

try {
  const stat = await fs.lstat(target);
  if (!stat.isSymbolicLink()) {
    console.error(`Refusing to overwrite non-symlink extension path: ${target}`);
    process.exit(1);
  }
  let existing = "broken";
  try { existing = await fs.realpath(target); } catch {}
  if (existing === await fs.realpath(source)) {
    console.log(`[triple-pi] Memory extension already installed: ${target}`);
    process.exit(0);
  }
  await fs.unlink(target);
} catch (error) {
  if ((error).code !== "ENOENT") throw error;
}

await fs.symlink(source, target, "dir");
console.log(`[triple-pi] Installed memory extension: ${target} -> ${source}`);
