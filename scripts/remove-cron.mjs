#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

try {
  let existing = "";
  try { existing = execFileSync("crontab", ["-l"], { encoding: "utf8" }); } catch {}
  const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const exact = `0 3 * * * cd ${projectDir} && npm run extract >> ~/.triple-pi/extract.log 2>&1`;
  const lines = existing.split("\n");
  const filtered = lines.filter((line) => line.trim() !== exact && line.trim() !== "# triple-pi-memory-legacy");
  const removed = lines.length - filtered.length;
  if (removed === 0) {
    console.log("[triple-pi] No canonical legacy cron entry found.");
    process.exit(0);
  }
  const content = filtered.join("\n").replace(/^\n+|\n+$/g, "");
  if (content) execFileSync("crontab", ["-"], { input: `${content}\n` });
  else {
    try { execFileSync("crontab", ["-r"]); } catch {}
  }
  console.log(`[triple-pi] Removed ${removed} canonical legacy cron line(s).`);
} catch (error) {
  console.error("[triple-pi] Failed to remove legacy cron:", error instanceof Error ? error.message : String(error));
  process.exit(1);
}
