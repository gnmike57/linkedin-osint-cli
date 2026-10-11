import { describe, expect, it } from 'vitest';
import {
  captureSessionFromExtension,
  isBridgeListening,
  normalizeExtensionPayload,
  serveSessionFromExtension,
} from '../src/core/extension-bridge.js';

describe('normalizeExtensionPayload', () => {
  it('accepts a cookies object and builds a full jar header', () => {
    const r = normalizeExtensionPayload({
      li_at: 'LI',
      jsessionid: 'ajax:1',
      cookies: { li_at: 'LI', JSESSIONID: 'ajax:1', lidc: 'x' },
    });
    expect(r).not.toBeNull();
    expect(r!.liAt).toBe('LI');
    expect(r!.jsessionid).toBe('ajax:1');
    expect(r!.cookieHeader).toContain('li_at=LI');
    expect(r!.cookieHeader).toContain('lidc=x');
  });

  it('accepts a cookies array', () => {
    const r = normalizeExtensionPayload({
      cookies: [
        { name: 'li_at', value: 'LI' },
        { name: 'JSESSIONID', value: 'ajax:9' },
      ],
    });
    expect(r!.liAt).toBe('LI');
    expect(r!.jsessionid).toBe('ajax:9');
  });

  it('parses a raw cookie_header string', () => {
    const r = normalizeExtensionPayload({ cookie_header: 'li_at=LI; JSESSIONID="ajax:5"; bcookie=b' });
    expect(r!.liAt).toBe('LI');
    expect(r!.jsessionid).toBe('"ajax:5"');
    expect(r!.cookieHeader).toContain('bcookie=b');
  });

  it('passes through a captured queryId and omits it when absent', () => {
    const withId = normalizeExtensionPayload({
      li_at: 'LI',
      jsessionid: 'ajax:1',
      query_id: 'voyagerSearchDashClusters.abc123',
      voyager_ops: [
        'voyagerSearchDashClusters@1696000000000',
        'voyagerIdentityDashProfiles@1696000000001',
        '',
      ],
    });
    expect(withId!.queryId).toBe('voyagerSearchDashClusters.abc123');
    // The observed-operation list is a diagnostic; junk entries are dropped.
    expect(withId!.voyagerOps).toEqual([
      'voyagerSearchDashClusters@1696000000000',
      'voyagerIdentityDashProfiles@1696000000001',
    ]);

    const withoutId = normalizeExtensionPayload({ li_at: 'LI', jsessionid: 'ajax:1' });
    expect(withoutId!.queryId).toBeUndefined();
    expect(withoutId!.voyagerOps).toBeUndefined();
  });

  it('returns null when the session is incomplete', () => {
    expect(normalizeExtensionPayload({ li_at: 'LI' })).toBeNull();
    expect(normalizeExtensionPayload({ cookies: { li_at: 'LI' } })).toBeNull();
    expect(normalizeExtensionPayload(null)).toBeNull();
    expect(normalizeExtensionPayload('nope')).toBeNull();
  });
});

describe('captureSessionFromExtension', () => {
  it('resolves when a valid session is POSTed (and does not hang afterwards)', async () => {
    const pending = captureSessionFromExtension({
      port: 8899,
      timeoutMs: 5000,
      validate: false,
      onStatus: () => {},
    });
    await new Promise((r) => setTimeout(r, 200));
    const res = await fetch('http://127.0.0.1:8899/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ li_at: 'LI', jsessionid: 'ajax:1', cookies: { li_at: 'LI', JSESSIONID: 'ajax:1' } }),
    });
    expect(res.status).toBe(200);
    const captured = await pending;
    expect(captured.liAt).toBe('LI');
    expect(captured.jsessionid).toBe('ajax:1');
  });

  it('rejects with a timeout when nothing posts', async () => {
    await expect(
      captureSessionFromExtension({ port: 8898, timeoutMs: 300, validate: false, onStatus: () => {} }),
    ).rejects.toThrow(/Timed out/);
  });
});

describe('isBridgeListening', () => {
  it('reports true while a bridge is bound and false once it is closed', async () => {
    const handle = await serveSessionFromExtension({
      port: 8895,
      onStatus: () => {},
      onCapture: () => {},
    });
    try {
      expect(await isBridgeListening(8895)).toBe(true);
    } finally {
      await handle.close();
    }
    // Logout relies on this returning false so it does not warn spuriously.
    expect(await isBridgeListening(8895)).toBe(false);
  }, 10_000);
});
