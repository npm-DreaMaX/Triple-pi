import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface ProjectIdentity {
  id: string;
  cwd: string;
  displayName: string;
  /** True when the identity came from an explicit alias file, false when derived from cwd. */
  aliased: boolean;
  /** Resolved path to the alias file, or undefined when auto-derived. */
  aliasPath?: string;
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

const ALIAS_FILE = ".triple-pi/project.json";
const ALIAS_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

function readProjectAlias(canonicalCwd: string): string | undefined {
  const aliasPath = path.join(canonicalCwd, ALIAS_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(aliasPath, "utf8");
  } catch {
    return undefined;
  }
  try {
    const doc = JSON.parse(raw) as Record<string, unknown>;
    const id = doc?.projectId;
    if (typeof id !== "string" || !ALIAS_ID_PATTERN.test(id)) return undefined;
    return id;
  } catch {
    return undefined;
  }
}

export function resolveProjectIdentity(cwd: string): ProjectIdentity {
  if (!cwd.trim()) throw new Error("Project cwd must not be empty");

  const canonicalCwd = normalizeCwd(cwd);
  const explicitId = readProjectAlias(canonicalCwd);
  if (explicitId) {
    return {
      id: explicitId,
      cwd: canonicalCwd,
      displayName: explicitId,
      aliased: true,
      aliasPath: path.join(canonicalCwd, ALIAS_FILE),
    };
  }

  const displayName = safeDisplayName(canonicalCwd);
  const digest = createHash("sha256").update(canonicalCwd).digest("hex").slice(0, 20);

  return {
    id: `${displayName}-${digest}`,
    cwd: canonicalCwd,
    displayName,
    aliased: false,
  };
}
