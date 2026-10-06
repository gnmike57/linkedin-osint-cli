import { describe, expect, it } from 'vitest';
import { findChromiumBinary, parseDevToolsActivePort, cdpGetCookies } from '../src/core/cdp-cookies.js';
import { linkedInCookiesAreAppBound, chromiumCookieStoreAvailable } from '../src/core/chrome-cookies.js';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('live machine probe', () => {
  it('classifies the local cookie stores', async () => {
    const appBound = await linkedInCookiesAreAppBound();
    const available = chromiumCookieStoreAvailable();
    console.log(`probe: storeAvailable=${available} appBound=${appBound}`);
    expect(typeof appBound).toBe('boolean');
  }, 30_000);
});

// Live end-to-end CDP smoke: launch Chromium with a throwaway profile and
// read LinkedIn cookies over the DevTools Protocol. Skipped when no browser.
const binary = findChromiumBinary();
const suite = binary ? describe : describe.skip;

suite('CDP live smoke', () => {
  it('launches a browser and reads cookies over CDP', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'linkedin-cli-smoke-'));
    const child = spawn(
      binary!,
      [
        `--user-data-dir=${profileDir}`,
        '--remote-debugging-port=0',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-sync',
        'https://www.linkedin.com/login',
      ],
      { stdio: 'ignore' },
    );
    try {
      const portFile = join(profileDir, 'DevToolsActivePort');
      const deadline = Date.now() + 30_000;
      while (!existsSync(portFile) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(existsSync(portFile)).toBe(true);
      const parsed = parseDevToolsActivePort(readFileSync(portFile, 'utf8'));
      expect(parsed).not.toBeNull();
      const wsUrl = `ws://127.0.0.1:${parsed!.port}${parsed!.wsPath}`;

      // LinkedIn sets anonymous cookies (bcookie/lidc) as soon as the page loads.
      let cookies: Awaited<ReturnType<typeof cdpGetCookies>> = [];
      const cookieDeadline = Date.now() + 30_000;
      while (Date.now() < cookieDeadline) {
        try {
          cookies = await cdpGetCookies(wsUrl);
          if (cookies.some((c) => c.name === 'bcookie')) break;
        } catch {
          /* page still loading */
        }
        await new Promise((r) => setTimeout(r, 1_000));
      }
      console.log(`smoke: ${cookies.length} cookies, bcookie=${cookies.some((c) => c.name === 'bcookie')}`);
      expect(cookies.some((c) => c.name === 'bcookie')).toBe(true);
    } finally {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      try {
        rmSync(profileDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }, 90_000);
});