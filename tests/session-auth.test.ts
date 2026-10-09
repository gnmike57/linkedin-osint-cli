import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/core/client.js';
import { getBrowserProfileDir } from '../src/core/cdp-cookies.js';

describe('getBrowserProfileDir', () => {
  it('is a stable dir named browser-profile', () => {
    expect(getBrowserProfileDir()).toMatch(/browser-profile$/);
  });
});

describe('client auth refresh', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('re-authenticates and retries once on a 401', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) {
        return {
          status: 401,
          ok: false,
          headers: new Headers(),
          text: async () => '{}',
        } as Response;
      }
      return {
        status: 200,
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => '{"ok":true}',
      } as Response;
    }) as typeof fetch;

    const refresh = vi.fn(async () => ({ liAt: 'new-li', jsessionid: 'ajax:new' }));
    const client = createClient(
      { liAt: 'old-li', jsessionid: 'ajax:old' },
      { refresh },
    );

    const res = await client.get<{ ok: boolean }>('/me');
    expect(res.ok).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(calls).toBe(2);
  });

  it('does not loop when refresh yields nothing', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return {
        status: 401,
        ok: false,
        headers: new Headers(),
        text: async () => '{}',
      } as Response;
    }) as typeof fetch;

    const refresh = vi.fn(async () => null);
    const client = createClient(
      { liAt: 'old-li', jsessionid: 'ajax:old' },
      { refresh },
    );

    await expect(client.get('/me')).rejects.toMatchObject({ code: 'AUTH_ERROR' });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(calls).toBe(1);
  });
});
