#!/usr/bin/env node
/**
 * Remove the Triple-pi cron job.
 */
import { execSync } from 'node:child_process';

try {
  const existing = execSync('crontab -l 2>/dev/null || true', { encoding: 'utf-8' });
  const filtered = existing.split('\n')
    .filter(line => !line.includes('triple-pi') || !line.includes('extract'))
    .join('\n')
    .replace(/\n{2,}/g, '\n');

  if (filtered.trim()) {
    execSync(`echo "${filtered.replace(/"/g, '\\"')}" | crontab -`);
  } else {
    execSync('crontab -r 2>/dev/null || true');
  }
  console.log('[triple-pi] Cron removed.');
} catch (err) {
  console.error('[triple-pi] Failed to remove cron:', err.message);
  process.exit(1);
}
