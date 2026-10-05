/*
 * Persistent shell history at <configDir>/history (spec §4.5).
 *
 * Fail-safe by contract: read/write errors warn once and never break the
 * session. Works on macOS, Windows and Linux via the existing config dir.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConfigDir } from '../core/config.js';

const MAX_ENTRIES = 200;
let warned = false;

function warnOnce(message: string): void {
  if (warned) return;
  warned = true;
  console.error(`note: shell history unavailable — ${message}`);
}

export function historyFilePath(configDir: string = getConfigDir()): string {
  return join(configDir, 'history');
}

/**
 * Last MAX_ENTRIES entries, deduplicated keeping the newest occurrence,
 * returned oldest → newest (the order readline's history expects).
 */
export function loadHistory(configDir: string = getConfigDir()): string[] {
  try {
    const raw = readFileSync(historyFilePath(configDir), 'utf-8');
    const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
    const deduped: string[] = [];
    const seen = new Set<string>();
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (seen.has(line)) continue;
      seen.add(line);
      deduped.push(line);
      if (deduped.length >= MAX_ENTRIES) break;
    }
    return deduped.reverse();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      warnOnce(`could not read ${historyFilePath(configDir)} (${code ?? 'unknown error'})`);
    }
    return [];
  }
}

/** Append one entry; the directory is created on demand; failures warn once. */
export function appendHistory(line: string, configDir: string = getConfigDir()): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    mkdirSync(configDir, { recursive: true });
    appendFileSync(historyFilePath(configDir), `${trimmed}\n`, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    warnOnce(`could not write ${historyFilePath(configDir)} (${code ?? 'unknown error'})`);
  }
}
