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
  registeredSessionToAuth,
  saveRegisteredSession,
  sessionFingerprint,
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
