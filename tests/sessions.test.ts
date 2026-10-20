import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// sessions.ts resolves its directory from config.ts, which reads XDG_CONFIG_HOME
// once at import time — so set it before the dynamic imports (same pattern as
// tests/config.test.ts). Keeps this suite off the operator's real registry.
const sandbox = mkdtempSync(join(tmpdir(), 'linkedin-cli-sessions-'));
process.env.XDG_CONFIG_HOME = sandbox;

const {
  listRegisteredSessions,
  loadRegisteredSession,
  purgeRegisteredSessions,
  registeredSessionToAuth,
  saveRegisteredSession,
  sessionFingerprint,
  summarizeRegisteredSessions,
} = await import('../src/core/sessions.js');

beforeEach(async () => {
  rmSync(join(sandbox, 'linkedin-cli', 'sessions'), { recursive: true, force: true });
});

afterAll(() => {
  delete process.env.XDG_CONFIG_HOME;
  rmSync(sandbox, { recursive: true, force: true });
});

const ACCOUNT_A = 'AQED-token-account-A';
const ACCOUNT_B = 'AQED-token-account-B';

describe('session registry', () => {
  it('keyed by li_at: two accounts never overwrite each other', async () => {
    saveRegisteredSession({ liAt: ACCOUNT_A, jsessionid: 'a:1', cookieHeader: 'li_at=A; JSESSIONID=a:1' });
    saveRegisteredSession({ liAt: ACCOUNT_B, jsessionid: 'b:1', cookieHeader: 'li_at=B; JSESSIONID=b:1' });

    const sessions = listRegisteredSessions();
    expect(sessions).toHaveLength(2);
    expect(new Set(sessions.map((s) => s.li_at))).toEqual(new Set([ACCOUNT_A, ACCOUNT_B]));
  });

  it('re-capturing the same account refreshes it instead of duplicating', async () => {
    saveRegisteredSession({ liAt: ACCOUNT_A, jsessionid: 'a:1' });
    await new Promise((r) => setTimeout(r, 20));
    const second = saveRegisteredSession({ liAt: ACCOUNT_A, jsessionid: 'a:2', queryId: 'q1' });

    expect(listRegisteredSessions()).toHaveLength(1);
    expect(second.captures).toBe(2);
    expect(second.jsessionid).toBe('a:2');
    expect(second.query_id).toBe('q1');
    expect(second.last_seen >= second.first_seen).toBe(true);
  });

  it("'latest' returns the most recently captured session", async () => {
    saveRegisteredSession({ liAt: ACCOUNT_A, jsessionid: 'a:1' });
    await new Promise((r) => setTimeout(r, 20));
    saveRegisteredSession({ liAt: ACCOUNT_B, jsessionid: 'b:1' });

    expect(loadRegisteredSession('latest')?.li_at).toBe(ACCOUNT_B);
  });

  it('selects by exact fingerprint or unique prefix; ambiguous prefixes are refused', async () => {
    saveRegisteredSession({ liAt: ACCOUNT_A, jsessionid: 'a:1' });
    saveRegisteredSession({ liAt: ACCOUNT_B, jsessionid: 'b:1' });

    const fpA = sessionFingerprint(ACCOUNT_A);
    expect(loadRegisteredSession(fpA)?.li_at).toBe(ACCOUNT_A);
    expect(loadRegisteredSession(fpA.slice(0, 2))?.li_at).toBe(ACCOUNT_A);
    expect(loadRegisteredSession('zzzz')).toBeNull();
  });

  it('replays the stored jar when converted to request auth', async () => {
    saveRegisteredSession({ liAt: ACCOUNT_A, jsessionid: 'a:1', cookieHeader: 'li_at=A; JSESSIONID=a:1; lidc=x' });
    const auth = registeredSessionToAuth(loadRegisteredSession('latest')!);
    expect(auth.liAt).toBe(ACCOUNT_A);
    expect(auth.cookieHeader).toContain('lidc=x');
  });

  it('is empty when nothing has been captured', () => {
    expect(listRegisteredSessions()).toEqual([]);
    expect(loadRegisteredSession('latest')).toBeNull();
  });
});

describe('session summary (`linkedin sessions`)', () => {
  it('never carries credentials — fingerprints and metadata only', async () => {
    // The registry files hold full cookie jars, so the listing is the one place
    // a careless change could leak them into logs or an issue report.
    saveRegisteredSession({
      liAt: ACCOUNT_A,
      jsessionid: 'a:1',
      cookieHeader: 'li_at=A; JSESSIONID=a:1',
      source: 'extension',
    });
    saveRegisteredSession({ liAt: ACCOUNT_B, jsessionid: 'b:1' });

    const summaries = summarizeRegisteredSessions(
      listRegisteredSessions(),
      sessionFingerprint(ACCOUNT_A),
    );

    expect(summaries).toHaveLength(2);
    const serialized = JSON.stringify(summaries);
    expect(serialized).not.toContain(ACCOUNT_A);
    expect(serialized).not.toContain(ACCOUNT_B);
    expect(serialized).not.toContain('a:1');
    expect(serialized).not.toContain('jsessionid');
    expect(serialized).not.toContain('cookie_header');

    const active = summaries.filter((s) => s.active);
    expect(active).toHaveLength(1);
    expect(active[0].fingerprint).toBe(sessionFingerprint(ACCOUNT_A));
  });

  it('reports per-account jar, queryId and capture state', async () => {
    saveRegisteredSession({
      liAt: ACCOUNT_A,
      jsessionid: 'a:1',
      cookieHeader: 'li_at=A; JSESSIONID=a:1',
      queryId: 'voyagerSearchDashClusters.q1',
      source: 'extension',
    });

    const [summary] = summarizeRegisteredSessions(listRegisteredSessions(), undefined);
    expect(summary.has_jar).toBe(true);
    expect(summary.captures).toBe(1);
    expect(summary.query_id).toBe('voyagerSearchDashClusters.q1');
    expect(summary.source).toBe('extension');
    expect(summary.first_seen).toBe(summary.last_seen);
    // No active fingerprint passed in → nothing is marked active.
    expect(summary.active).toBe(false);
  });

  it('purges the registry without touching the active config session', async () => {
    const { loadConfig, saveSession } = await import('../src/core/config.js');
    await saveSession({ li_at: ACCOUNT_A, jsessionid: 'a:1' }); // the ACTIVE session
    saveRegisteredSession({ liAt: ACCOUNT_A, jsessionid: 'a:1' });
    saveRegisteredSession({ liAt: ACCOUNT_B, jsessionid: 'b:1' });

    const result = purgeRegisteredSessions();

    expect(result.removed).toBe(2);
    expect(result.dir).toContain('sessions');
    expect(listRegisteredSessions()).toEqual([]);
    expect(loadRegisteredSession('latest')).toBeNull();
    // The operator stays logged in — purging only removes the ability to pin a
    // *different* account with LINKEDIN_SESSION.
    expect((await loadConfig())?.li_at).toBe(ACCOUNT_A);
  });
});
