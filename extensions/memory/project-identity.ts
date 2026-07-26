import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface ProjectIdentity {
  id: string;
  cwd: string;
  displayName: string;
}

function normalizeCwd(cwd: string): string {
  let resolved = path.resolve(cwd);
  // Resolve symlinks so that /home/user/project and /home/user/link-to-project
  // produce the same identity.
  try { resolved = fs.realpathSync(resolved); } catch { /* use path.resolve result */ }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function safeDisplayName(cwd: string): string {
  const name = path.basename(cwd) || "workspace";
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-");
  return safe.slice(0, 48) || "workspace";
}

export function resolveProjectIdentity(cwd: string): ProjectIdentity {
  if (!cwd.trim()) throw new Error("Project cwd must not be empty");

  const canonicalCwd = normalizeCwd(cwd);
  const displayName = safeDisplayName(canonicalCwd);
  const digest = createHash("sha256").update(canonicalCwd).digest("hex").slice(0, 20);

  return {
    id: `${displayName}-${digest}`,
    cwd: canonicalCwd,
    displayName,
  };
}
