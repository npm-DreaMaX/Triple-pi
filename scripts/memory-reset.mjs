#!/usr/bin/env node
import * as fs from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import * as path from "node:path";

const args = new Set(process.argv.slice(2));
const yes = args.has("--yes");
const dryRun = args.has("--dry-run");
const scope = [...args].find((argument) => argument.startsWith("--scope="))?.slice(8) || "current";
if (!new Set(["current", "all", "legacy"]).has(scope)) {
  console.error("--scope must be current, all, or legacy");
  process.exit(2);
}

const tripleRoot = path.join(homedir(), ".triple-pi");
const canonicalRoot = process.env.TRIPLE_PI_MEMORY_ROOT
  ? path.resolve(process.env.TRIPLE_PI_MEMORY_ROOT)
  : path.join(tripleRoot, "memory-v1");
const legacyRoot = path.join(tripleRoot, "memory");
const cwdArg = [...args].find((argument) => argument.startsWith("--cwd="));
const cwd = cwdArg ? path.resolve(cwdArg.slice(6)) : process.cwd();

function assertSafeRoot(target) {
  const resolved = path.resolve(target);
  const home = path.resolve(homedir());
  if (resolved === path.parse(resolved).root || resolved === home || resolved === tripleRoot) {
    throw new Error(`Refusing unsafe reset target: ${resolved}`);
  }
  const allowed = resolved === path.resolve(canonicalRoot) || resolved === path.resolve(legacyRoot);
  if (!allowed) throw new Error(`Reset target is outside configured/canonical memory roots: ${resolved}`);
  return resolved;
}

const requested = [];
if (scope === "all") requested.push(canonicalRoot);
else if (scope === "legacy") requested.push(legacyRoot);
else {
  const { resolveProjectIdentity } = await import("../extensions/memory/project-identity.ts");
  const project = resolveProjectIdentity(cwd);
  requested.push(path.join(canonicalRoot, "projects", project.id));
  requested.push(path.join(canonicalRoot, "archive", "projects", project.id));
  requested.push(path.join(canonicalRoot, "extractions", project.id));
  requested.push(path.join(canonicalRoot, "signals", project.id));
  requested.push(path.join(canonicalRoot, "working-manifests", project.id));
}

const existing = [];
for (const raw of requested) {
  const root = scope === "current" ? canonicalRoot : raw;
  assertSafeRoot(root);
  const target = path.resolve(raw);
  if (scope === "current" && !target.startsWith(`${path.resolve(canonicalRoot)}${path.sep}`)) {
    throw new Error(`Project reset target escaped memory root: ${target}`);
  }
  try {
    const relative = path.relative(path.resolve(canonicalRoot), target);
    if (scope === "current") {
      let cursor = path.resolve(canonicalRoot);
      for (const segment of relative.split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, segment);
        try {
          if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error(`Refusing symlink path component: ${cursor}`);
        } catch (error) {
          if (error.code === "ENOENT") break;
          throw error;
        }
      }
    }
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic-link reset target: ${target}`);
    if (stat.isDirectory()) existing.push(target);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

console.log(`Triple-pi memory reset scope: ${scope}`);
console.log("Targets:");
if (existing.length === 0) console.log("  (none)");
for (const target of existing) console.log(`  ${target}`);
if (dryRun || existing.length === 0) process.exit(0);

const token = scope === "current" ? "RESET" : `RESET ${scope.toUpperCase()}`;
if (!yes) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(`Interactive confirmation unavailable. Review --dry-run, then use --yes --scope=${scope}.`);
    process.exit(2);
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await readline.question(`Type "${token}" to move the listed data to quarantine: `);
  readline.close();
  if (answer !== token) {
    console.error("Reset cancelled.");
    process.exit(1);
  }
}

const quarantineBase = scope === "all" && process.env.TRIPLE_PI_MEMORY_ROOT
  ? path.join(path.dirname(canonicalRoot), "triple-pi-quarantine")
  : path.join(tripleRoot, "quarantine");
const quarantine = path.join(quarantineBase, new Date().toISOString().replace(/[:.]/g, "-"));
await fs.mkdir(quarantine, { recursive: true, mode: 0o700 });
for (const [index, target] of existing.entries()) {
  await fs.rename(target, path.join(quarantine, `${index}-${path.basename(target)}`));
}
console.log(`Moved ${existing.length} target(s) to quarantine: ${quarantine}`);
console.log("Pi sessions, auth, and extension installation were not changed. Quarantine is never auto-purged.");
