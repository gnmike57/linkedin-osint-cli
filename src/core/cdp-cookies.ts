import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getConfigDir } from './config.js';

/**
 * Cookie capture via the Chrome DevTools Protocol (CDP).
 *
 * Chrome/Edge encrypt LinkedIn cookies as v11/v20 "app-bound" values that no
 * external process can decrypt, and since Chrome 136 the *default* profile can
 * no longer be debugged at all (the remote-debugging switches are ignored for
 * it). So instead of reading Chrome's on-disk store, this module launches
 * Chromium on a **tool-owned persistent profile** with a non-standard
 * `--user-data-dir` and `--remote-debugging-port=0`, then reads cookies live
 * over CDP — Chrome hands CDP the decrypted values, so app-bound encryption is
 * irrelevant.
 *
 * The profile is stable across runs (`~/.linkedin-cli/browser-profile`), so the
 * user signs in **once**. Later captures are silent and headless: if the profile
 * is already signed in, the session is read instantly with no window shown.
 */

/**
 * Landing page for capture. `/feed/` covers both cases: a signed-in profile
 * lands on the feed (instant capture); a signed-out one is redirected by
 * LinkedIn to the login page, where the user signs in once.
 */
const LOGIN_URL = 'https://www.linkedin.com/feed/';
const PROFILE_DIR_NAME = 'browser-profile';
const DEFAULT_TIMEOUT_MS = 300_000;
/** Budget for the silent headless reuse pass before falling back to sign-in. */
const REUSE_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 2_000;
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Wait budget for the sign-in, overridable via LINKEDIN_LOGIN_TIMEOUT_MS
 * (milliseconds, minimum 30s). The default of 5 minutes leaves room for
 * 2FA prompts and identity checks — killing the window earlier discards a
 * login the user is about to complete.
 */
export function loginTimeoutMs(): number {
  const raw = Number(process.env.LINKEDIN_LOGIN_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 30_000 ? raw : DEFAULT_TIMEOUT_MS;
}

/**
 * Stable, tool-owned Chromium profile directory. Kept across runs so a single
 * sign-in is reused forever; lives beside the config file so `logout` can clean
 * it up. Exported for tests and for callers that want to inspect/clear it.
 */
export function getBrowserProfileDir(): string {
  return join(getConfigDir(), PROFILE_DIR_NAME);
}

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
      // Chrome first: this project's profile-sourced auth targets Chrome, and
      // capturing a session in a different browser than the one the CLI reads
      // from would silently split the two. Edge stays as a last-resort
      // fallback for machines without Chrome.
      join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(pfx, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ...(local ? [join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')] : []),
      join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(pfx, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
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

/** Options for {@link captureLinkedInCookiesViaCdp}. */
export interface CdpCaptureOptions {
  /** Persistent profile dir (default: {@link getBrowserProfileDir}). */
  profileDir?: string;
  /** Overall sign-in wait budget in ms (default: {@link loginTimeoutMs}). */
  timeoutMs?: number;
  /** Launch headless (only useful when the profile is already signed in). */
  headless?: boolean;
  /** Page to open on launch (default: the LinkedIn feed). */
  loginUrl?: string;
  /** Progress sink (default: stderr). */
  onStatus?: (message: string) => void;
}

/**
 * Capture the LinkedIn session from the tool-owned *persistent* browser profile.
 *
 * Silent pass: if the profile already exists, launch headless and read cookies
 * immediately (no window, no user action). If that yields nothing (first run or
 * an expired session), open a headful window for a one-time sign-in and wait up
 * to `timeoutMs`. Throws when no Chromium binary is available or the sign-in
 * window times out.
 */
export async function captureLinkedInCookiesViaCdp(
  options: CdpCaptureOptions = {},
): Promise<CdpCaptureResult> {
  const bin = findChromiumBinary();
  if (!bin) {
    throw new Error('No Chrome or Edge installation found for browser-assisted login.');
  }
  const profileDir = options.profileDir ?? getBrowserProfileDir();
  const loginUrl = options.loginUrl ?? LOGIN_URL;
  const timeoutMs = options.timeoutMs ?? loginTimeoutMs();
  const onStatus = options.onStatus ?? ((m: string) => process.stderr.write(`${m}\n`));

  const hadProfile = existsSync(profileDir) && readdirSync(profileDir).length > 0;
  // The profile holds the live LinkedIn session (Chromium's encrypted cookie
  // store plus browsing state), so keep it owner-only. `mode` only applies when
  // the directory is created, hence the explicit chmod for a profile left by an
  // earlier build.
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(profileDir, 0o700);
  } catch {
    /* best effort: Windows and some filesystems have no POSIX modes */
  }

  // Pass 1 — silent reuse of an existing sign-in (headless, short budget).
  if (hadProfile && options.headless !== false) {
    const reused = await runCdpCapture(bin, profileDir, loginUrl, {
      headless: true,
      budgetMs: Math.min(timeoutMs, REUSE_TIMEOUT_MS),
      onStatus: () => {},
    });
    if (reused) return reused;
  }

  // Pass 2 — headful sign-in window (or headless when explicitly requested).
  const captured = await runCdpCapture(bin, profileDir, loginUrl, {
    headless: options.headless === true,
    budgetMs: timeoutMs,
    onStatus,
  });
  if (captured) return captured;
  throw new Error(
    `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the LinkedIn login ` +
      'in the browser window.',
  );
}

/** One CDP capture attempt against `profileDir`; null when no session appears. */
async function runCdpCapture(
  bin: string,
  profileDir: string,
  loginUrl: string,
  opts: { headless: boolean; budgetMs: number; onStatus: (m: string) => void },
): Promise<CdpCaptureResult | null> {
  const args = [
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-session-crashed-bubble',
  ];
  if (opts.headless) args.push('--headless=new');
  args.push(loginUrl);

  const child = spawn(bin, args, { stdio: 'ignore' });

  const portFile = join(profileDir, 'DevToolsActivePort');
  const readWsUrl = (): string => {
    if (!existsSync(portFile)) return '';
    const p = parseDevToolsActivePort(readFileSync(portFile, 'utf8'));
    return p ? `ws://127.0.0.1:${p.port}${p.wsPath}` : '';
  };

  try {
    const startDeadline = Date.now() + 30_000;
    while (!existsSync(portFile)) {
      // On Windows the launched chrome.exe is only a launcher that hands off to
      // the real browser process and exits; the 30s deadline is the authority on
      // whether CDP came up.
      if (Date.now() > startDeadline) return null;
      await sleep(250);
    }
    const wsUrl = readWsUrl();
    if (!wsUrl) return null;

    const deadline = Date.now() + opts.budgetMs;
    let nextHeartbeat = Date.now() + HEARTBEAT_INTERVAL_MS;
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
      if (Date.now() >= nextHeartbeat) {
        const remainingS = Math.max(0, Math.round((deadline - Date.now()) / 1000));
        opts.onStatus(
          `Still waiting for sign-in… ${remainingS}s remaining. ` +
            'Complete the login in the browser window and leave it open.',
        );
        nextHeartbeat = Date.now() + HEARTBEAT_INTERVAL_MS;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    return null;
  } finally {
    await closeBrowser(readWsUrl()).catch(() => undefined);
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    // The profile is intentionally preserved — the sign-in is meant to persist.
  }
}