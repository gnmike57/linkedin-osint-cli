import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Cookie capture via the Chrome DevTools Protocol (CDP).
 *
 * Chrome/Edge on Windows encrypt LinkedIn cookies as v11/v20 "app-bound"
 * values when the browser is running, and no external process can decrypt
 * them. This module instead starts a Chromium browser with a throwaway
 * profile and `--remote-debugging-port=0`, and reads cookies live over CDP
 * while the user signs in — no decryption involved.
 *
 * The temporary profile is deleted afterwards, so the browser keeps no copy
 * of the login; only the CLI's config receives the session cookies.
 */

const LOGIN_URL = 'https://www.linkedin.com/login';
const DEFAULT_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 2_000;

export interface CdpCookie {
  name: string;
  value: string;
  domain: string;
}

export interface CdpCaptureResult {
  liAt: string;
  jsessionid: string;
  cookieHeader: string;
  cookies: Record<string, string>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Candidate Chromium executables for this platform, in preference order. */
export function chromiumBinaryCandidates(): string[] {
  if (process.platform === 'win32') {
    const pf = process.env.PROGRAMFILES ?? 'C:\\Program Files';
    const pfx = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA ?? '';
    return [
      join(pfx, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(pfx, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ...(local ? [join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')] : []),
    ];
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    ];
  }
  return [
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    'microsoft-edge',
    'microsoft-edge-stable',
  ];
}

/** Locate a Chromium executable usable for CDP capture, or null. */
export function findChromiumBinary(): string | null {
  for (const candidate of chromiumBinaryCandidates()) {
    if (process.platform === 'linux') {
      try {
        execFileSync('which', [candidate], { stdio: 'ignore' });
        return candidate;
      } catch {
        /* try next candidate */
      }
    } else if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** Parse the browser-written `DevToolsActivePort` file. */
export function parseDevToolsActivePort(
  content: string,
): { port: number; wsPath: string } | null {
  const [portLine, wsLine] = content.trim().split(/\r?\n/);
  const port = Number(portLine);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const wsPath = (wsLine ?? '').trim();
  if (!wsPath.startsWith('/')) return null;
  return { port, wsPath };
}

/**
 * Extract the LinkedIn session from a CDP cookie list. Only linkedin.com and
 * its subdomains are accepted — a bare suffix check would also match
 * lookalike hosts such as "evil-linkedin.com".
 */
export function pickLinkedInSessionCookies(cookies: CdpCookie[]): {
  liAt?: string;
  jsessionid?: string;
  jar: Record<string, string>;
} {
  const jar: Record<string, string> = {};
  for (const c of cookies) {
    const domain = c.domain.replace(/^\./, '');
    if (domain === 'linkedin.com' || domain.endsWith('.linkedin.com')) {
      jar[c.name] = c.value;
    }
  }
  return { liAt: jar['li_at'], jsessionid: jar['JSESSIONID'], jar };
}
interface CdpResponse {
  id?: number;
  result?: { cookies?: CdpCookie[] };
  error?: { message?: string };
}

/** One-shot CDP query: return all browser cookies over the browser-level socket. */
export async function cdpGetCookies(wsUrl: string, timeoutMs = 10_000): Promise<CdpCookie[]> {
  const WebSocketCtor = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!WebSocketCtor) throw new Error('Node WebSocket is unavailable');
  const ws = new WebSocketCtor(wsUrl);
  try {
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('CDP WebSocket connection failed'));
      setTimeout(() => reject(new Error('CDP WebSocket connection timed out')), timeoutMs);
    });
    const id = 1;
    ws.send(JSON.stringify({ id, method: 'Storage.getCookies' }));
    return await new Promise<CdpCookie[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP query timed out')), timeoutMs);
      ws.onmessage = (event) => {
        let msg: CdpResponse;
        try {
          msg = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (msg.id !== id) return;
        clearTimeout(timer);
        if (msg.error) {
          reject(new Error(`CDP error: ${msg.error.message ?? 'unknown'}`));
          return;
        }
        resolve(msg.result?.cookies ?? []);
      };
    });
  } finally {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
}

/** Ask the browser to shut down cleanly; ignore failures (caller force-kills). */
async function closeBrowser(wsUrl: string): Promise<void> {
  const WebSocketCtor = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!WebSocketCtor || !wsUrl) return;
  try {
    const ws = new WebSocketCtor(wsUrl);
    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
      ws.onerror = () => resolve();
      setTimeout(resolve, 3_000);
    });
    ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    await sleep(500);
    ws.close();
  } catch {
    /* ignore */
  }
}

/**
 * Open a dedicated Chromium window at the LinkedIn login page and capture the
 * session cookies over CDP once the user signs in. Throws on timeout or when
 * no Chromium binary is available.
 */
export async function captureLinkedInCookiesViaCdp(
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<CdpCaptureResult> {
  const bin = findChromiumBinary();
  if (!bin) {
    throw new Error('No Chrome or Edge installation found for browser-assisted login.');
  }

  const profileDir = mkdtempSync(join(tmpdir(), 'linkedin-cli-cdp-'));
  const child = spawn(
    bin,
    [
      `--user-data-dir=${profileDir}`,
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-session-crashed-bubble',
      LOGIN_URL,
    ],
    { stdio: 'ignore' },
  );

  const portFile = join(profileDir, 'DevToolsActivePort');
  const readWsUrl = (): string => {
    if (!existsSync(portFile)) return '';
    const p = parseDevToolsActivePort(readFileSync(portFile, 'utf8'));
    return p ? `ws://127.0.0.1:${p.port}${p.wsPath}` : '';
  };

  try {
    const startDeadline = Date.now() + 30_000;
    while (!existsSync(portFile)) {
      if (child.exitCode !== null) {
        throw new Error('The browser exited before CDP became available.');
      }
      if (Date.now() > startDeadline) {
        throw new Error('Timed out waiting for the browser to start.');
      }
      await sleep(250);
    }
    const wsUrl = readWsUrl();
    if (!wsUrl) {
      throw new Error('The browser wrote an invalid DevToolsActivePort file.');
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const cookies = await cdpGetCookies(wsUrl);
        const { liAt, jsessionid, jar } = pickLinkedInSessionCookies(cookies);
        if (liAt && jsessionid) {
          const cookieHeader = Object.entries(jar)
            .map(([n, v]) => `${n}=${v}`)
            .join('; ');
          return { liAt, jsessionid, cookieHeader, cookies: jar };
        }
      } catch {
        /* browser still starting or transient CDP failure — keep polling */
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error('Timed out waiting for the LinkedIn login in the browser window.');
  } finally {
    await closeBrowser(readWsUrl()).catch(() => undefined);
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
}