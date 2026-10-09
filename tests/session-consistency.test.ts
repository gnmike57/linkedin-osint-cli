import { describe, expect, it } from 'vitest';
import { createClient, jarBelongsToSession } from '../src/core/client.js';

/**
 * The stored Cookie jar wins over `li_at`/`JSESSIONID` when request headers are
 * built (LinkedIn ignores the thin pair when a jar is present). A jar captured
 * for an earlier session therefore silently keeps the CLI on the OLD
 * credentials, however fresh `li_at` is. `jarBelongsToSession` is the invariant
 * that makes that impossible regardless of what is on disk.
 */
describe('jarBelongsToSession', () => {
  const liAt = 'AQED-li-at-value';
  const jsessionid = 'ajax:1234';

  it('accepts a jar captured for the same session', () => {
    expect(jarBelongsToSession(`li_at=${liAt}; JSESSIONID="${jsessionid}"; lidc=x`, liAt, jsessionid)).toBe(true);
  });

  it('accepts a jar whose cookies are unquoted or surrounded by others', () => {
    expect(
      jarBelongsToSession(`bcookie=b; li_at=${liAt}; lidc=l; JSESSIONID=${jsessionid}`, liAt, jsessionid),
    ).toBe(true);
  });

  it('rejects a jar whose li_at differs', () => {
    expect(jarBelongsToSession('li_at=OTHER-SESSION; JSESSIONID="ajax:1"', liAt, jsessionid)).toBe(false);
  });

  it('rejects a jar whose JSESSIONID differs (stale CSRF token)', () => {
    expect(jarBelongsToSession(`li_at=${liAt}; JSESSIONID="ajax:9999"`, liAt, jsessionid)).toBe(false);
  });

  it('accepts a jar carrying neither identity cookie (nothing to contradict)', () => {
    expect(jarBelongsToSession('bcookie=b; lidc=l', liAt, jsessionid)).toBe(true);
  });
});

describe('client cookie header selection', () => {
  const originalFetch = globalThis.fetch;

  /** Run one GET and return the Cookie header the client actually sent. */
  async function sentCookieHeader(auth: {
    liAt: string;
    jsessionid: string;
    cookieHeader?: string;
  }): Promise<string> {
    let sent = '';
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent = String((init.headers as Record<string, string>).cookie ?? '');
      return {
        status: 200,
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => '{"ok":true}',
      } as Response;
    }) as typeof fetch;

    try {
      await createClient(auth).get('/me');
    } finally {
      globalThis.fetch = originalFetch;
    }
    return sent;
  }

  it('replays the full jar when it belongs to the same session', async () => {
    const sent = await sentCookieHeader({
      liAt: 'LI',
      jsessionid: 'ajax:1',
      cookieHeader: 'li_at=LI; JSESSIONID="ajax:1"; lidc=fulljar',
    });
    expect(sent).toContain('lidc=fulljar');
    expect(sent).toContain('li_at=LI');
  });

  it('falls back to the fresh credentials when the jar is from another session', async () => {
    const sent = await sentCookieHeader({
      liAt: 'NEW-li',
      jsessionid: 'ajax:new',
      cookieHeader: 'li_at=OLD-li; JSESSIONID="ajax:old"; lidc=stalejar',
    });
    expect(sent).toContain('li_at=NEW-li');
    expect(sent).not.toContain('OLD-li');
    expect(sent).not.toContain('stalejar');
  });

  it('uses the thin pair when no jar is stored', async () => {
    const sent = await sentCookieHeader({ liAt: 'LI', jsessionid: 'ajax:1' });
    expect(sent).toBe('JSESSIONID="ajax:1"; li_at=LI');
  });
});
