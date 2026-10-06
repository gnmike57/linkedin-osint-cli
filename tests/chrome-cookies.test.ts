import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  spawnSync: vi.fn(),
  spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })),
}));

import { execFileSync, spawn } from 'node:child_process';
import {
  chromiumCookieStoreAvailable,
  decryptChromeCookieValue,
  deriveChromeCookieKey,
  getWindowsChromiumCookieKey,
} from '../src/core/chrome-cookies.js';
import { openInBrowser } from '../src/commands/auth/login.js';

function encryptV10(plaintext: Buffer, key: Buffer): Buffer {
  const iv = Buffer.alloc(16, 0x20);
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([Buffer.from('v10'), cipher.update(plaintext), cipher.final()]);
}

describe('decryptChromeCookieValue', () => {
  const key = deriveChromeCookieKey('peanuts', 1);

  it('decrypts a v10 cookie without a host-hash prefix', () => {
    const encrypted = encryptV10(Buffer.from('ajax:unit-test-session'), key);
    expect(decryptChromeCookieValue(encrypted, key)).toBe('ajax:unit-test-session');
  });

  it('strips the Chrome M130 32-byte host-hash prefix', () => {
    const hostHash = randomBytes(32);
    const encrypted = encryptV10(Buffer.concat([hostHash, Buffer.from('unit-test-value')]), key);
    expect(decryptChromeCookieValue(encrypted, key)).toBe('unit-test-value');
  });

  it('returns legacy unencrypted bytes as utf8', () => {
    expect(decryptChromeCookieValue(Buffer.from('plain-cookie'), key)).toBe('plain-cookie');
  });

  it('returns empty string for empty input', () => {
    expect(decryptChromeCookieValue(Buffer.alloc(0), key)).toBe('');
  });
});

describe('decryptChromeCookieValue (Windows AES-256-GCM)', () => {
  const key32 = randomBytes(32);

  function encryptV10Gcm(value: string, hostHash?: Buffer): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key32, nonce);
    const plaintext = hostHash
      ? Buffer.concat([hostHash, Buffer.from(value, 'utf8')])
      : Buffer.from(value, 'utf8');
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([Buffer.from('v10', 'utf8'), nonce, encrypted, cipher.getAuthTag()]);
  }

  it('round-trips a v10 cookie', () => {
    const value = 'AQEB-unit-test-li_at-value';
    expect(decryptChromeCookieValue(encryptV10Gcm(value), key32)).toBe(value);
  });

  it('strips the M130 host-key hash prefix', () => {
    const value = 'ajax:unit-jsessionid';
    expect(decryptChromeCookieValue(encryptV10Gcm(value, randomBytes(32)), key32)).toBe(value);
  });

  it('refuses v11 app-bound cookies instead of returning garbage', () => {
    const buf = Buffer.concat([Buffer.from('v11', 'utf8'), randomBytes(40)]);
    expect(() => decryptChromeCookieValue(buf, key32)).toThrow(/Unsupported encrypted cookie format/);
  });
});

describe('getWindowsChromiumCookieKey', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
    vi.mocked(execFileSync).mockReset();
  });

  function makeLocalState(encryptedKeyB64: string | null): string {
    const dir = mkdtempSync(join(tmpdir(), 'linkedin-cli-ls-'));
    tmpDirs.push(dir);
    const state: Record<string, unknown> = {};
    if (encryptedKeyB64 !== null) state.os_crypt = { encrypted_key: encryptedKeyB64 };
    writeFileSync(join(dir, 'Local State'), JSON.stringify(state));
    return dir;
  }

  it('unprotects the DPAPI-prefixed master key via PowerShell', () => {
    const masterKey = randomBytes(32);
    const blob = Buffer.concat([Buffer.from('DPAPI', 'ascii'), randomBytes(48)]);
    const dir = makeLocalState(Buffer.from(blob).toString('base64'));
    vi.mocked(execFileSync).mockReturnValue(Buffer.from(masterKey).toString('base64'));

    const key = getWindowsChromiumCookieKey(dir);
    expect(key).toEqual(masterKey);

    const [bin, , opts] = vi.mocked(execFileSync).mock.calls[0];
    expect(bin).toBe('powershell.exe');
    // Only the post-DPAPI-prefix blob reaches PowerShell; no key material in argv.
    expect((opts as { input: string }).input).toBe(blob.subarray(5).toString('base64'));
  });

  it('rejects a key blob without the DPAPI prefix', () => {
    const raw = Buffer.concat([Buffer.from('XXXX', 'ascii'), randomBytes(48)]);
    const dir = makeLocalState(raw.toString('base64'));
    expect(() => getWindowsChromiumCookieKey(dir)).toThrow(/missing DPAPI prefix/);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('errors clearly when Local State has no os_crypt key', () => {
    const dir = makeLocalState(null);
    expect(() => getWindowsChromiumCookieKey(dir)).toThrow(/No os_crypt.encrypted_key/);
  });
});

describe('chromiumCookieStoreAvailable', () => {
  afterEach(() => {
    delete process.env.LINKEDIN_CHROME_USER_DATA_DIR;
  });

  it('is false when no profile database exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'linkedin-cli-empty-'));
    process.env.LINKEDIN_CHROME_USER_DATA_DIR = dir;
    expect(chromiumCookieStoreAvailable()).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('is true when Network/Cookies exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'linkedin-cli-store-'));
    mkdirSync(join(dir, 'Default', 'Network'), { recursive: true });
    writeFileSync(join(dir, 'Default', 'Network', 'Cookies'), '');
    process.env.LINKEDIN_CHROME_USER_DATA_DIR = dir;
    expect(chromiumCookieStoreAvailable()).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('openInBrowser', () => {
  afterEach(() => {
    vi.mocked(spawn).mockClear();
  });

  it('spawns the platform opener detached and never throws', () => {
    expect(() => openInBrowser('https://www.linkedin.com/login')).not.toThrow();
    expect(spawn).toHaveBeenCalledTimes(1);
    const [, args, opts] = vi.mocked(spawn).mock.calls[0];
    expect((args as string[]).at(-1)).toBe('https://www.linkedin.com/login');
    expect((opts as { detached: boolean }).detached).toBe(true);
  });
});
