/**
 * Memory Storage Layer — Project-scoped
 *
 * ============================================================================
 * ARCHITECTURE: Global + Project memories
 * ============================================================================
 *
 * ~/.triple-pi/memory/
 *   global/              ← cross-project (communication style, general prefs)
 *     MEMORY.md
 *     knowledge/ preference/ decision/ rule/ fact/
 *
 *   <project-slug>/      ← project-specific (per git repo)
 *     MEMORY.md
 *     knowledge/ preference/ decision/ rule/ fact/
 *
 * Startup:  detect current project → load global/index + project/index
 * Extractor: saves to the project where the session happened
 * SaveMemory: defaults to current project; --global for cross-project
 * SearchMemory: searches current project + global
 *
 * WHY PROJECT SCOPING:
 *   A developer works on multiple projects. Memories about Pi internals
 *   shouldn't pollute a React project's context. Project isolation keeps
 *   the memory index small and relevant per-project.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';

// Types
export type MemoryCategory = 'preference' | 'decision' | 'rule' | 'fact' | 'knowledge';
export type MemoryScope = 'global' | 'project';

export interface MemoryEntry {
  path: string;
  category: MemoryCategory;
  title: string;
  scope: MemoryScope;
  project: string; // project slug or "global"
  createdAt: string;
  updatedAt: string;
  content: string;
}

export interface SearchResult {
  entry: MemoryEntry;
  snippet: string;
}

export interface MemoryContext {
  /** Full system prompt snippet for current project + global */
  prompt: string;
  /** Number of memories loaded */
  count: number;
  /** Current project slug */
  project: string;
}

// Paths
const ROOT = path.join(homedir(), '.triple-pi', 'memory');
const CATS: MemoryCategory[] = ['preference', 'decision', 'rule', 'fact', 'knowledge'];

// ═══════════════════════════════════════════════════════════════
// Project detection
// ═══════════════════════════════════════════════════════════════

let _cachedProjectSlug: string | null = null;

/** Get a stable, filesystem-safe project identifier. */
export function getProjectSlug(cwd?: string): string {
  if (_cachedProjectSlug) return _cachedProjectSlug;

  const dir = cwd || process.cwd();
  // Prefer git remote URL (stable across renames), fall back to workspace path.
  // OpenClaw principle: workspace path is the canonical identity for memory scoping.
  // We NEVER generate a random fallback — that would merge unrelated projects.
  try {
    const remote = execSync('git remote get-url origin', { cwd: dir, stdio: 'pipe', timeout: 5000 })
      .toString().trim();
    _cachedProjectSlug = remote
      .replace(/^https?:\/\//, '')
      .replace(/\.git$/, '')
      .replace(/[^a-zA-Z0-9-_.]/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 64);
  } catch {
    // No git remote: use resolved absolute path as workspace identity
    const resolved = path.resolve(dir);
    _cachedProjectSlug = resolved
      .replace(/^\//, '')          // strip leading /
      .replace(/\//g, '-')         // path separators → dashes
      .replace(/[^a-zA-Z0-9-_.]/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 80);
  }
  return _cachedProjectSlug;
}

// ═══════════════════════════════════════════════════════════════
// Init
// ═══════════════════════════════════════════════════════════════

export function ensureDir(scope: MemoryScope = 'global', project?: string): void {
  const base = scope === 'global' ? path.join(ROOT, 'global') : path.join(ROOT, project || getProjectSlug());
  fs.mkdirSync(base, { recursive: true });
  for (const c of CATS) fs.mkdirSync(path.join(base, c), { recursive: true });
  const idx = path.join(base, 'MEMORY.md');
  if (!fs.existsSync(idx)) fs.writeFileSync(idx, '# Memory Index\n\n');
}

// ═══════════════════════════════════════════════════════════════
// Index
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// Activity tracking & dormancy
// ═══════════════════════════════════════════════════════════════

/** Mark a project as active (called on save, extract, or user interaction). */
export function touchProject(project?: string): void {
  const proj = project || getProjectSlug();
  if (proj === 'global') return;
  const base = path.join(ROOT, proj);
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, '.last-active'), new Date().toISOString());
}

/** Days since last activity. Returns -1 if project has no memories. */
export function getDormancy(project?: string): number {
  const proj = project || getProjectSlug();
  const marker = path.join(ROOT, proj, '.last-active');
  if (!fs.existsSync(marker)) return -1;
  const lastActive = new Date(fs.readFileSync(marker, 'utf-8').trim());
  return Math.floor((Date.now() - lastActive.getTime()) / (1000 * 60 * 60 * 24));
}

/** Delete project memories that have been dormant > 90 days. */
export function cleanupDormant(): { project: string; days: number }[] {
  const deleted: { project: string; days: number }[] = [];
  if (!fs.existsSync(ROOT)) return deleted;
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'global') continue;
    const dormancy = getDormancy(entry.name);
    if (dormancy > 90) {
      fs.rmSync(path.join(ROOT, entry.name), { recursive: true, force: true });
      deleted.push({ project: entry.name, days: dormancy });
    }
  }
  return deleted;
}

function indexFor(scope: MemoryScope, project?: string): string {
  const base = scope === 'global' ? path.join(ROOT, 'global') : path.join(ROOT, project || getProjectSlug());
  return path.join(base, 'MEMORY.md');
}

export function loadIndex(scope: MemoryScope, project?: string): string | null {
  ensureDir(scope, project);
  const idx = indexFor(scope, project);
  return fs.existsSync(idx) ? fs.readFileSync(idx, 'utf-8') : null;
}

/**
 * Load combined memory prompt for current context: global + project.
 * This is what gets injected into the system prompt.
 */
export function loadContextPrompt(cwd?: string): MemoryContext {
  const project = getProjectSlug(cwd);
  const globalIdx = loadIndex('global');
  const projIdx = loadIndex('project', project);

  const globalEntries = (globalIdx?.match(/^-\s*\[/gm) ?? []).length;
  const projEntries = (projIdx?.match(/^-\s*\[/gm) ?? []).length;

  let prompt = '## Persistent Memory\n\n';

  if (globalEntries === 0 && projEntries === 0) {
    prompt += 'No memories yet. They are extracted from sessions automatically.\n';
    return { prompt, count: 0, project };
  }

  prompt += `${globalEntries + projEntries} memories (${globalEntries} global, ${projEntries} project-specific).\n`;
  prompt += `Memory root: ${ROOT}\n`;
  prompt += `Current project: ${project}\n\n`;

  if (projIdx && projEntries > 0) {
    prompt += `### Project Memories (${projEntries})\n\n${projIdx}\n\n`;
  }
  if (globalIdx && globalEntries > 0) {
    prompt += `### Global Memories\n\n${globalIdx}\n`;
  }

  prompt += '\nUse Read tool to load specific memory files, or SearchMemory to search by keyword.';

  // Daily log + scratchpad paths
  const projectDir = path.join(ROOT, project);
  const dailyLog = path.join(projectDir, 'DAILY.md');
  const scratchpad = path.join(projectDir, 'SCRATCHPAD.md');

  prompt += `\n\n## Working State\n\n`;
  prompt += `Daily log: ${dailyLog} — append a summary at the end of each session.\n`;
  prompt += `Scratchpad: ${scratchpad} — track what you're currently working on.\n`;
  prompt += `Keep these updated. They help you resume context quickly.\n`;

  return { prompt, count: globalEntries + projEntries, project };
}

// ═══════════════════════════════════════════════════════════════
// Save
// ═══════════════════════════════════════════════════════════════

export function save(
  category: MemoryCategory,
  title: string,
  content: string,
  scope: MemoryScope = 'project',
  project?: string,
): string {
  const proj = scope === 'global' ? 'global' : (project || getProjectSlug());
  ensureDir(scope, proj);

  const base = path.join(ROOT, proj);
  const date = new Date().toISOString().split('T')[0];
  const filename = title
    .toLowerCase()
    .replace(/[一-鿿]+/g, (m) => '-' + Buffer.from(m).toString('hex') + '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') + '.md';
  const filepath = path.join(base, category, filename);

  const body = [
    '---',
    `category: ${category}`,
    `scope: ${scope}`,
    `project: ${proj}`,
    `created: ${date}`,
    `updated: ${date}`,
    '---', '', `# ${title}`, '', content,
  ].join('\n');
  fs.writeFileSync(filepath, body);

  // Update index
  const rel = `${category}/${filename}`;
  const entry = `- [${title}](${rel})`;
  const idxPath = indexFor(scope, proj);
  let idx = fs.existsSync(idxPath) ? fs.readFileSync(idxPath, 'utf-8') : '# Memory Index\n\n';
  const lines = idx.split('\n');
  const dup = lines.findIndex((l) => l.includes(`(${rel})`));
  if (dup >= 0) lines[dup] = entry;
  else if (!lines.includes(entry)) lines.push(entry);
  fs.writeFileSync(idxPath, lines.join('\n').trimEnd() + '\n');

  // Mark project as active
  touchProject(proj);

  return filepath;
}

// ═══════════════════════════════════════════════════════════════
// Search (current project + global)
// ═══════════════════════════════════════════════════════════════

export function search(keyword: string, max = 10, cwd?: string): SearchResult[] {
  const project = getProjectSlug(cwd);
  const results: SearchResult[] = [];
  const lower = keyword.toLowerCase();

  // Search in global + current project
  const scopes = ['global', project];
  for (const scope of scopes) {
    const dir = path.join(ROOT, scope);
    if (!fs.existsSync(dir)) continue;
    walk(dir, scope, lower);
  }

  function walk(dir: string, scope: string, keyword: string): void {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && e.name !== 'MEMORY.md') walk(full, scope, keyword);
      else if (e.isFile() && e.name.endsWith('.md') && e.name !== 'MEMORY.md') {
        const c = fs.readFileSync(full, 'utf-8');
        const i = c.toLowerCase().indexOf(keyword);
        if (i >= 0) {
          const relPath = path.relative(path.join(ROOT, scope), full);
          const cat = relPath.split(path.sep)[0] as MemoryCategory;
          const start = Math.max(0, i - 50);
          const end = Math.min(c.length, i + keyword.length + 100);
          results.push({
            entry: {
              path: `${scope}/${relPath}`,
              category: cat,
              title: path.basename(e.name, '.md'),
              scope: scope === 'global' ? 'global' : 'project',
              project: scope,
              createdAt: (c.match(/created:\s*(.+)/)?.[1] ?? '').trim(),
              updatedAt: (c.match(/updated:\s*(.+)/)?.[1] ?? '').trim(),
              content: c,
            },
            snippet: (start > 0 ? '…' : '') + c.slice(start, end) + (end < c.length ? '…' : ''),
          });
        }
      }
    }
  }

  results.sort((a, b) => b.entry.updatedAt.localeCompare(a.entry.updatedAt));
  return results.slice(0, max);
}
