/*
 * Persistent shell history at <configDir>/history (spec §4.5).
 *
 * Fail-safe by contract: read/write errors warn once and never break the
 * session. Works on macOS, Windows and Linux via the existing config dir.
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConfigDir } from '../core/config.js';

const MAX_ENTRIES = 200;
let warned = false;

/**
 * Flags whose value is a credential. `linkedin login --li-at <cookie>` is a
 * supported auth path, and the shell persists every typed line — so without
 * redaction a raw `li_at`/`JSESSIONID` would land in `~/.linkedin-cli/history`
 * in plaintext, outliving the config it came from.
 */
const SECRET_FLAGS = ['--li-at', '--jsessionid', '--token', '--password', '--secret'];

/** Mask the value of any secret-bearing flag (`--li-at x`, `--li-at=x`, quoted). */
export function redactSecrets(line: string): string {
  let out = line;
  for (const flag of SECRET_FLAGS) {
    const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(
      new RegExp(`(${escaped}[=\\s]+)("[^"]*"|'[^']*'|\\S+)`, 'gi'),
      '$1***',
    );
  }
  return out;
}

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

/**
 * Append one entry; the directory is created on demand; failures warn once.
 *
 * Secrets are masked here rather than at the call sites: this is the single
 * boundary that touches disk, so no future caller can bypass it. The file is
 * created owner-only (0600) — it can still hold fragments of real commands.
 */
export function appendHistory(line: string, configDir: string = getConfigDir()): void {
  const trimmed = redactSecrets(line.trim());
  if (!trimmed) return;
  try {
    const file = historyFilePath(configDir);
    const existed = existsSync(file);
    mkdirSync(configDir, { recursive: true });
    appendFileSync(file, `${trimmed}\n`, { encoding: 'utf-8', mode: 0o600 });
    if (!existed) chmodSync(file, 0o600); // 0600 on create, but be explicit
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    warnOnce(`could not write ${historyFilePath(configDir)} (${code ?? 'unknown error'})`);
  }
}
