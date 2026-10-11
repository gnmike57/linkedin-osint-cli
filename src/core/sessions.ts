import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConfigDir } from './config.js';
import type { LinkedInAuth } from './types.js';

/**
 * Multi-account session registry.
 *
 * `~/.linkedin-cli/config.json` holds ONE active session, but every capture the
 * extension bridge receives is ALSO written here, keyed by a fingerprint of
 * `li_at`. That way several accounts can auto-send concurrently (each from its
 * own browser profile) without overwriting each other, and a command can pin
 * itself to one account with `LINKEDIN_SESSION=<fingerprint|latest>`.
 *
 * Files hold full cookie jars, so they are created 0600 like config.json.
 */

export interface RegisteredSession {
  fingerprint: string;
  li_at: string;
  jsessionid: string;
  cookie_header?: string;
  query_id?: string;
  source?: string;
  first_seen: string;
  last_seen: string;
  captures: number;
}

/** Stable per-account identifier derived from the session token. */
export function sessionFingerprint(liAt: string): string {
  return createHash('sha1').update(liAt).digest('hex').slice(0, 16);
}

function sessionsDir(): string {
  return join(getConfigDir(), 'sessions');
}

/** Record (or refresh) a capture in the registry. */
export function saveRegisteredSession(input: {
  liAt: string;
  jsessionid: string;
  cookieHeader?: string;
  queryId?: string;
  source?: string;
}): RegisteredSession {
  const fingerprint = sessionFingerprint(input.liAt);
  const file = join(sessionsDir(), `${fingerprint}.json`);

  let existing: RegisteredSession | undefined;
  try {
    existing = JSON.parse(readFileSync(file, 'utf-8')) as RegisteredSession;
  } catch {
    /* first capture for this account */
  }

  const now = new Date().toISOString();
  const next: RegisteredSession = {
    fingerprint,
    li_at: input.liAt,
    jsessionid: input.jsessionid,
    ...(input.cookieHeader ? { cookie_header: input.cookieHeader } : {}),
    ...(input.queryId ? { query_id: input.queryId } : {}),
    ...(input.source ? { source: input.source } : {}),
    first_seen: existing?.first_seen ?? now,
    last_seen: now,
    captures: (existing?.captures ?? 0) + 1,
  };

  mkdirSync(sessionsDir(), { recursive: true });
  writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return next;
}

/** All registered sessions, newest first. */
export function listRegisteredSessions(): RegisteredSession[] {
  try {
    return readdirSync(sessionsDir())
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        try {
          return JSON.parse(readFileSync(join(sessionsDir(), name), 'utf-8')) as RegisteredSession;
        } catch {
          return null;
        }
      })
      .filter((s): s is RegisteredSession => s !== null)
      .sort((a, b) => b.last_seen.localeCompare(a.last_seen));
  } catch {
    return [];
  }
}

/** Pick a session: 'latest', an exact fingerprint, or a unique prefix of one. */
export function loadRegisteredSession(selector: string): RegisteredSession | null {
  const sessions = listRegisteredSessions();
  if (sessions.length === 0) return null;
  if (selector === 'latest' || selector === '*') return sessions[0] ?? null;

  const exact = sessions.find((s) => s.fingerprint === selector);
  if (exact) return exact;

  const prefixed = sessions.filter((s) => s.fingerprint.startsWith(selector));
  return prefixed.length === 1 ? prefixed[0] : null;
}

/** A registered session as request auth (replays its full jar). */
export function registeredSessionToAuth(session: RegisteredSession): LinkedInAuth {
  return {
    liAt: session.li_at,
    jsessionid: session.jsessionid,
    ...(session.cookie_header ? { cookieHeader: session.cookie_header } : {}),
  };
}
