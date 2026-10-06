import { describe, expect, it } from 'vitest';
import {
  chromiumBinaryCandidates,
  parseDevToolsActivePort,
  pickLinkedInSessionCookies,
} from '../src/core/cdp-cookies.js';
import { decryptChromeCookieValue } from '../src/core/chrome-cookies.js';

describe('parseDevToolsActivePort', () => {
  it('parses port and websocket path', () => {
    const parsed = parseDevToolsActivePort('52572\n/devtools/browser/8ab3-c0ffee\n');
    expect(parsed).toEqual({ port: 52572, wsPath: '/devtools/browser/8ab3-c0ffee' });
  });

  it('rejects invalid ports', () => {
    expect(parseDevToolsActivePort('0\n/devtools/browser/x')).toBeNull();
    expect(parseDevToolsActivePort('99999\n/devtools/browser/x')).toBeNull();
    expect(parseDevToolsActivePort('not-a-port\n/devtools/browser/x')).toBeNull();
  });

  it('rejects missing or malformed websocket path', () => {
    expect(parseDevToolsActivePort('52572')).toBeNull();
    expect(parseDevToolsActivePort('52572\nrelative/path')).toBeNull();
  });
});

describe('pickLinkedInSessionCookies', () => {
  it('extracts li_at and JSESSIONID from linkedin domains', () => {
    const { liAt, jsessionid, jar } = pickLinkedInSessionCookies([
      { name: 'li_at', value: 'LI', domain: '.linkedin.com' },
      { name: 'JSESSIONID', value: '"ajax:123"', domain: 'www.linkedin.com' },
      { name: 'bcookie', value: 'BC', domain: '.linkedin.com' },
      { name: 'sid', value: 'other', domain: '.example.com' },
    ]);
    expect(liAt).toBe('LI');
    expect(jsessionid).toBe('"ajax:123"');
    expect(jar).toEqual({ li_at: 'LI', JSESSIONID: '"ajax:123"', bcookie: 'BC' });
  });

  it('ignores lookalike domains', () => {
    const { liAt } = pickLinkedInSessionCookies([
      { name: 'li_at', value: 'EVIL', domain: '.evil-linkedin.com' },
    ]);
    expect(liAt).toBeUndefined();
  });

  it('returns undefined when cookies are absent', () => {
    const { liAt, jsessionid } = pickLinkedInSessionCookies([
      { name: 'bcookie', value: 'BC', domain: '.linkedin.com' },
    ]);
    expect(liAt).toBeUndefined();
    expect(jsessionid).toBeUndefined();
  });
});

describe('chromiumBinaryCandidates', () => {
  it('returns a non-empty candidate list for this platform', () => {
    expect(chromiumBinaryCandidates().length).toBeGreaterThan(0);
  });
});

describe('decryptChromeCookieValue app-bound handling', () => {
  it('refuses v20 app-bound cookies with a 32-byte key', () => {
    const key = Buffer.alloc(32, 7);
    const buf = Buffer.concat([Buffer.from('v20', 'utf8'), Buffer.alloc(12), Buffer.alloc(16)]);
    expect(() => decryptChromeCookieValue(buf, key)).toThrow(/app-bound/);
  });

  it('refuses v11 app-bound cookies with a 32-byte key', () => {
    const key = Buffer.alloc(32, 7);
    const buf = Buffer.concat([Buffer.from('v11', 'utf8'), Buffer.alloc(12), Buffer.alloc(16)]);
    expect(() => decryptChromeCookieValue(buf, key)).toThrow(/app-bound/);
  });
});