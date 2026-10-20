import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Pluggable HTTP transport. Defaults to global `fetch` (Node), but can
 * shell out to `curl_chrome123` (curl-impersonate-chrome) when
 * `LINKEDIN_HTTP=curl-impersonate` is set. That binary is opt-in and
 * local-harness only — install it on the same machine that holds the session.
 * It sends a TLS ClientHello that matches real Chrome so Voyager calls are
 * less likely to get the session killed.
 *
 * Redirects are never followed (fetch `redirect: 'manual'`, curl `--max-redirs 0`)
 * so expired sessions surface as 3xx instead of "redirect count exceeded".
 *
 * Extension Transport (`LINKEDIN_HTTP=extension`): Routes requests through a
 * Chrome extension (assets/browser-extension) that executes fetch() in the
 * browser context, providing real TLS/HTTP/2 fingerprints and automatic
 * cookie handling. Requires the extension to be installed and connected.
 */

export interface HttpResponse {
  status: number;
  headers: Headers;
  text(): Promise<string>;
}

export type HttpRequestInit = {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
};

export type TransportType = 'fetch' | 'curl-impersonate' | 'extension';

export function getTransportType(): TransportType {
  const t = process.env.LINKEDIN_HTTP?.toLowerCase();
  if (t === 'curl-impersonate' || process.env.LINKEDIN_USE_CURL_IMPERSONATE === '1') {
    return 'curl-impersonate';
  }
  if (t === 'extension') {
    return 'extension';
  }
  return 'fetch';
}

export async function httpRequest(url: string, init: HttpRequestInit): Promise<HttpResponse> {
  const transport = getTransportType();
  if (transport === 'curl-impersonate') {
    return curlImpersonateRequest(url, init);
  }
  if (transport === 'extension') {
    return extensionRequest(url, init);
  }
  const res = await fetch(url, { ...init, redirect: 'manual' });
  return res;
}

// --- Extension Transport (CLI <-> Browser Extension) ---

interface ProxyRequest {
  requestId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

interface ProxyResponse {
  requestId: string;
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  error?: string;
}

interface PendingRequest {
  /** The queued request, handed to the extension on its next /next-request poll. */
  request: ProxyRequest;
  resolve: (response: ProxyResponse) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  /** True once a poll has picked the request up — never hand it out twice. */
  sent: boolean;
}

const PROXY_PORT = Number(process.env.LINKEDIN_EXTENSION_PROXY_PORT) || 8788;
const PROXY_POLL_INTERVAL_MS = 100;
const PROXY_REQUEST_TIMEOUT_MS = 60_000;
// How long a request waits for the service worker's next ping before giving
// up. A one-shot CLI process often starts while the worker is suspended —
// its keepalive alarm (30s) or heartbeat (5 min) wakes it, and this wait must
// cover that gap. Set LINKEDIN_EXTENSION_CONNECT_TIMEOUT_MS=0 to fail
// immediately instead (tests do).
const EXTENSION_CONNECT_WAIT_MS =
  process.env.LINKEDIN_EXTENSION_CONNECT_TIMEOUT_MS !== undefined
    ? Number(process.env.LINKEDIN_EXTENSION_CONNECT_TIMEOUT_MS)
    : 45_000;

let proxyServer: ReturnType<typeof createServer> | null = null;
const pendingRequests = new Map<string, PendingRequest>();
let extensionConnected = false;
let lastExtensionPing = 0;

/** Start the proxy HTTP server that the extension polls. */
function ensureProxyServer(): void {
  if (proxyServer) return;

  proxyServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    // CORS for extension
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Extension polls this endpoint for pending requests
    if (req.method === 'GET' && req.url?.startsWith('/next-request')) {
      handleNextRequest(req, res);
      return;
    }

    // Extension posts response here after executing the fetch
    if (req.method === 'POST' && req.url?.startsWith('/response/')) {
      handleProxyResponse(req, res);
      return;
    }

    // Extension pings this to signal it's alive
    if (req.method === 'POST' && req.url?.startsWith('/ping')) {
      handlePing(req, res);
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  proxyServer.on('error', (err) => {
    console.error('[extension-proxy] Server error:', err.message);
  });

  proxyServer.listen(PROXY_PORT, '127.0.0.1', () => {
    console.error(`[extension-proxy] Listening on http://127.0.0.1:${PROXY_PORT}`);
  });

  // A one-shot CLI process must be able to exit once its work is done — the
  // proxy must never hold the event loop open by itself. Unref the listening
  // handle and every accepted socket (the service worker keeps a long-poll
  // connection open ~25s at a time). In-flight CLI requests still pin the
  // process via their own ref'd timers, so active work always completes.
  proxyServer.unref();
  proxyServer.on('connection', (socket) => socket.unref());
}

/** Handle extension polling for next request. */
function handleNextRequest(req: IncomingMessage, res: ServerResponse): void {
  extensionConnected = true;
  lastExtensionPing = Date.now();

  // Check if there's a pending request to send
  for (const pending of pendingRequests.values()) {
    if (!pending.sent) {
      pending.sent = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(pending.request));
      return;
    }
  }

  // No pending request - long poll (hold connection)
  const waitStart = Date.now();
  const checkInterval = setInterval(() => {
    for (const pending of pendingRequests.values()) {
      if (!pending.sent) {
        clearInterval(checkInterval);
        pending.sent = true;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(pending.request));
        return;
      }
    }
    // Timeout after 25 seconds (long poll)
    if (Date.now() - waitStart > 25_000) {
      clearInterval(checkInterval);
      res.writeHead(204);
      res.end();
    }
  }, PROXY_POLL_INTERVAL_MS);
  // This interval lives up to ~25s — it must not pin a one-shot CLI process
  // open after its real work is done (the socket is unref'd separately).
  checkInterval.unref();

  req.on('close', () => clearInterval(checkInterval));
}

/** Handle extension posting the fetch response. */
function handleProxyResponse(req: IncomingMessage, res: ServerResponse): void {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    try {
      const response: ProxyResponse = JSON.parse(body);
      const pending = pendingRequests.get(response.requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        pendingRequests.delete(response.requestId);
        if (response.error) {
          pending.reject(new Error(response.error));
        } else {
          pending.resolve(response);
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch {
      res.writeHead(400);
      res.end('bad json');
    }
  });
}

/** Handle extension ping. */
function handlePing(req: IncomingMessage, res: ServerResponse): void {
  extensionConnected = true;
  lastExtensionPing = Date.now();
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

/** Check if extension is connected (has pinged recently). */
export function isExtensionConnected(): boolean {
  return extensionConnected && (Date.now() - lastExtensionPing) < 10_000;
}

/**
 * Ensure the proxy server is listening and wait up to `timeoutMs` for the
 * service worker's first ping — lets a one-shot process (`linkedin extension
 * status`) actually observe the worker instead of only reading stale module
 * state. `timeoutMs <= 0` is a pure state read with no server bind (tests).
 */
export async function waitForExtensionPing(timeoutMs = 5_000): Promise<boolean> {
  if (timeoutMs <= 0) return isExtensionConnected();
  ensureProxyServer();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isExtensionConnected()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return isExtensionConnected();
}

/**
 * Execute a request via the extension proxy. Exported for unit tests — tests
 * call it directly instead of going through `httpRequest`, so a concurrently
 * running test file's `delete process.env.LINKEDIN_HTTP` (vitest threads share
 * the process env) cannot silently reroute the call to plain `fetch`.
 */
export async function extensionRequest(url: string, init: HttpRequestInit): Promise<HttpResponse> {
  ensureProxyServer();

  // A one-shot CLI process often starts between the service worker's ~25s
  // long-polls, so the bridge can legitimately look "disconnected" right
  // after proxy startup — wait for the worker's next ping instead of
  // failing fast (override/fail-fast: LINKEDIN_EXTENSION_CONNECT_TIMEOUT_MS).
  const connectDeadline = Date.now() + EXTENSION_CONNECT_WAIT_MS;
  while (!isExtensionConnected()) {
    if (Date.now() >= connectDeadline) {
      throw new Error(
        'Extension not connected. Install the extension (assets/browser-extension) ' +
          "and ensure it's running. Run `linkedin extension status` to verify.",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const requestId = crypto.randomUUID();
  const request: ProxyRequest = {
    requestId,
    url,
    method: init.method,
    headers: init.headers,
    body: init.body,
  };

  // Abort handling
  const onAbort = () => {
    const pending = pendingRequests.get(requestId);
    if (pending) {
      clearTimeout(pending.timeout);
      pendingRequests.delete(requestId);
      pending.reject(new Error('Request aborted'));
    }
  };
  init.signal?.addEventListener('abort', onAbort);

  // Wait for extension to pick up the request and respond
  const response = await new Promise<ProxyResponse>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error(`Extension proxy timeout after ${PROXY_REQUEST_TIMEOUT_MS}ms`));
    }, PROXY_REQUEST_TIMEOUT_MS);

    pendingRequests.set(requestId, {
      request,
      resolve,
      reject,
      timeout,
      sent: false,
    });
  });

  init.signal?.removeEventListener('abort', onAbort);

  if (process.env.LINKEDIN_DEBUG === '1') {
    const bodyPreview = JSON.stringify((response.body ?? '').slice(0, 120));
    process.stderr.write(
      `[transport] ${init.method} ${url} -> ${response.status} ${response.statusText} ` +
        `(${(response.body ?? '').length}b) ${bodyPreview}\n`,
    );
  }

  if (!response.ok) {
    const err = new Error(`HTTP ${response.status} ${response.statusText}`);
    (err as any).status = response.status;
    (err as any).responseHeaders = response.headers;
    throw err;
  }

  const headers = new Headers();
  for (const [key, value] of Object.entries(response.headers)) {
    headers.append(key, value);
  }

  return {
    status: response.status,
    headers,
    async text() {
      return response.body;
    },
  };
}

export function useCurlImpersonate(): boolean {
  return (
    process.env.LINKEDIN_HTTP === 'curl-impersonate' ||
    process.env.LINKEDIN_USE_CURL_IMPERSONATE === '1'
  );
}

/**
 * Locate the curl-impersonate binary, in priority order:
 *   1. `LINKEDIN_CURL_IMPERSONATE_BIN` — but only if that file actually exists
 *      (stale absolute paths after a repo move must not hard-fail every call);
 *   2. the repo-bundled copy under `.tmp/curl-impersonate/`;
 *   3. the env value verbatim / the classic `curl_chrome123` PATH default.
 */
function resolveCurlBin(): string {
  const fromEnv = process.env.LINKEDIN_CURL_IMPERSONATE_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const here = dirname(dirname(fileURLToPath(import.meta.url))); // dist/ -> repo root
  const bundled = join(
    here,
    '.tmp',
    'curl-impersonate',
    process.platform === 'win32' ? 'curl-impersonate.exe' : 'curl-impersonate',
  );
  if (existsSync(bundled)) return bundled;
  return fromEnv ?? 'curl_chrome123';
}

/**
 * v2-style curl-impersonate builds ship a single `curl-impersonate` binary
 * plus per-target `.bat` wrappers. Node cannot spawn `.bat`/`.cmd` without a
 * shell (EINVAL on Node >= 18.12), so if CURL_BIN points at one of those
 * wrappers, transparently redirect to the sibling `curl-impersonate`
 * executable and pass `--impersonate <target>`. When CURL_BIN *is* the
 * combined binary, the impersonation target must come from
 * `LINKEDIN_CURL_IMPERSONATE_TARGET` — previously the stem check nullified
 * that env var, silently sending plain-curl TLS.
 */
function curlBinAndArgs(): { bin: string; preArgs: string[] } {
  const CURL_BIN = resolveCurlBin();
  const base = CURL_BIN.replace(/\\/g, '/').split('/').pop() ?? CURL_BIN;
  const stem = base.replace(/\.(exe|bat|cmd)$/i, '').toLowerCase();
  const envTarget = process.env.LINKEDIN_CURL_IMPERSONATE_TARGET;
  const stemTarget = /^curl_(chrome|edge|firefox|safari|tor)\w*$/.test(stem)
    ? stem.replace(/^curl_/, '')
    : null;
  const impersonateTarget = envTarget ?? stemTarget;

  // Wrapper stem (curl_chrome123.bat): redirect to the sibling combined
  // binary and pass the derived target (env target wins when both exist).
  if (stemTarget && stem !== 'curl-impersonate') {
    const dir = CURL_BIN.slice(0, CURL_BIN.length - base.length);
    const hasTargetSuffix = /(_android|_ios|a)$/i.test(stem);
    const exe = dir + 'curl-impersonate' + (process.platform === 'win32' ? '.exe' : '');
    const target: string = impersonateTarget ?? stemTarget;
    return {
      bin: exe,
      preArgs: ['--impersonate', hasTargetSuffix ? stemTarget : target],
    };
  }

  // Combined binary: pass the env target when present; without one there is
  // nothing to pass (and guessing a profile for a bare binary would be wrong).
  if (stem === 'curl-impersonate') {
    return { bin: CURL_BIN, preArgs: impersonateTarget ? ['--impersonate', impersonateTarget] : [] };
  }

  // Anything else (plain curl, custom binaries): no impersonation.
  return { bin: CURL_BIN, preArgs: [] };
}

function curlImpersonateRequest(url: string, init: HttpRequestInit): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const { bin, preArgs } = curlBinAndArgs();
    const args: string[] = [
      ...preArgs,
      '-sS',
      '-i', // include response headers in output
      '--compressed',
      '--max-redirs',
      '0',
      '-X',
      init.method,
      '--max-time',
      '30',
    ];
    for (const [name, value] of Object.entries(init.headers)) {
      // curl-impersonate already sets sec-ch-ua, user-agent, sec-fetch-*, etc.
      // Skip any we redundantly set so we don't override the Chrome-matching
      // values it provides.
      const lower = name.toLowerCase();
      if (
        lower === 'user-agent' ||
        lower.startsWith('sec-') ||
        lower === 'accept-encoding' ||
        lower === 'accept-language' ||
        lower === 'upgrade-insecure-requests'
      ) {
        continue;
      }
      args.push('-H', `${name}: ${value}`);
    }
    if (init.body !== undefined) {
      args.push('--data-binary', '@-');
    }
    args.push(url);

    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    const onAbort = () => child.kill('SIGTERM');
    init.signal?.addEventListener('abort', onAbort);

    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => (stderr += d.toString()));

    child.on('error', (err) => {
      init.signal?.removeEventListener('abort', onAbort);
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(
          new Error(
            `curl-impersonate binary "${bin}" not found in PATH. ` +
              `Install curl-impersonate-chrome (binary: curl_chrome123) or set LINKEDIN_CURL_IMPERSONATE_BIN. ` +
              `See README for install options.`,
          ),
        );
      } else {
        reject(err);
      }
    });

    child.on('close', (code) => {
      init.signal?.removeEventListener('abort', onAbort);
      // curl exits 47 when --max-redirs is exceeded; with max-redirs 0 a 3xx
      // is still a successful capture of the redirect response if -i printed it.
      const raw = Buffer.concat(chunks);
      if (code !== 0 && raw.length === 0) {
        reject(new Error(`${bin} exited ${code}: ${stderr.trim() || 'no output'}`));
        return;
      }
      try {
        const parsed = parseRawHttpResponse(raw);
        if (process.env.LINKEDIN_DEBUG === '1') {
          process.stderr.write(
            `[transport] ${init.method} ${url} -> ${parsed.status} location=${parsed.headers.get('location') ?? '-'}\n`,
          );
        }
        resolve(parsed);
      } catch (err) {
        if (code !== 0) {
          reject(new Error(`${bin} exited ${code}: ${stderr.trim() || 'unparseable response'}`));
          return;
        }
        reject(err);
      }
    });

    if (init.body !== undefined) {
      // If the binary dies instantly (bad install, ENOENT handled above), the
      // stdin write can surface EPIPE on the stream — swallow it here so the
      // process error path stays on the promise rejection.
      child.stdin.on('error', () => {});
      child.stdin.write(init.body);
    }
    child.stdin.on('error', () => {});
    child.stdin.end();
  });
}

function findHeaderBodySplit(raw: Buffer, from: number): { idx: number; sepLen: number } | null {
  const crlf = raw.indexOf('\r\n\r\n', from);
  const lf = raw.indexOf('\n\n', from);
  if (crlf !== -1 && (lf === -1 || crlf <= lf)) {
    return { idx: crlf, sepLen: 4 };
  }
  if (lf !== -1) {
    return { idx: lf, sepLen: 2 };
  }
  return null;
}

/** Parse `curl -i` output. Exported for unit tests. Never logs cookie values. */
export function parseRawHttpResponse(raw: Buffer): HttpResponse {
  // curl -i includes one or more header blocks (one per redirect) then the body.
  // Take the last header block.
  let lastHeadersEnd = -1;
  let lastHeadersStart = 0;
  let lastSepLen = 4;
  while (true) {
    const split = findHeaderBodySplit(raw, lastHeadersStart);
    if (!split) break;
    const next = raw.subarray(split.idx + split.sepLen);
    // Only treat the following block as a new header block when it starts with
    // a full HTTP status line ("HTTP/1.1 200 ...") — a response body that
    // merely contains "\r\n\r\nHTTP/" must not be re-parsed as headers.
    if (/^HTTP\/[\d.]+\s+\d{3}[\s\r\n]/.test(next.subarray(0, 64).toString('utf8'))) {
      lastHeadersStart = split.idx + split.sepLen;
      continue;
    }
    lastHeadersEnd = split.idx;
    lastSepLen = split.sepLen;
    break;
  }
  if (lastHeadersEnd === -1) {
    throw new Error('Could not parse curl-impersonate response');
  }

  const headerBlock = raw.subarray(lastHeadersStart, lastHeadersEnd).toString('utf8');
  const body = raw.subarray(lastHeadersEnd + lastSepLen);

  const lines = headerBlock.split(/\r?\n/);
  const statusLine = lines.shift() ?? '';
  const statusMatch = statusLine.match(/^HTTP\/[\d.]+\s+(\d+)/);
  const status = statusMatch ? Number(statusMatch[1]) : 0;

  const headers = new Headers();
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name) headers.append(name, value);
  }

  return {
    status,
    headers,
    async text() {
      return body.toString('utf8');
    },
  };
}
