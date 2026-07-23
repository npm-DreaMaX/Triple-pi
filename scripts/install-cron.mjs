#!/usr/bin/env node
/**
 * Install cron job for daily auto-extraction.
 * Runs `npm run extract` at 3 AM daily.
 * Skips if no session was created today (saves LLM cost).
 * Only installs if not already present.
 */
import { execSync } from 'node:child_process';

const PROJECT_DIR = process.cwd();
const CRON_ENTRY = `0 3 * * * cd ${PROJECT_DIR} && npm run extract >> ~/.triple-pi/extract.log 2>&1`;

try {
  // Check if already installed
  const existing = execSync('crontab -l 2>/dev/null || true', { encoding: 'utf-8' });
  if (existing.includes('triple-pi') && existing.includes('extract')) {
    console.log('[triple-pi] Cron already installed, skipping.');
    process.exit(0);
  }

  // Install
  const updated = (existing.trim() ? existing.trim() + '\n' : '') + CRON_ENTRY + '\n';
  execSync(`echo "${updated.replace(/"/g, '\\"')}" | crontab -`);
  console.log('[triple-pi] Cron installed: daily 3 AM extraction.');
} catch (err) {
  console.error('[triple-pi] Failed to install cron:', err.message);
  process.exit(1);
}
