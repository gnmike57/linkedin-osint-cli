import { createServer } from 'node:http';
import { createConnection } from 'node:net';

/**
 * Extension bridge: a localhost listener that receives the LinkedIn session
 * from a tiny Chrome extension.
 *
 * Why: modern Chrome encrypts `li_at`/`JSESSIONID` app-bound (v11/v20) so no
 * external process can decrypt them, and since Chrome 136 the default profile
 * can no longer be debugged. An extension, however, runs *inside* Chrome and
 * receives the decrypted cookies via `chrome.cookies` — the only way to capture
 * an existing sign-in automatically without a fresh login. The extension POSTs
 * them to this listener, which persists them exactly like any other login.
 *
 * Two modes:
 *  - `captureSessionFromExtension` — one-shot: resolve on the first valid POST
 *    (what `linkedin login --extension` uses).
 *  - `serveSessionFromExtension` — long-lived: stay listening and hand every
 *    session to `onCapture` (what `linkedin extension listen` uses, so the
 *    extension can push a session at any time without the user re-running a
 *    command first).
 *
 * Local-only: binds to 127.0.0.1 and never sends anything off the machine.
 */

export interface ExtensionCaptureResult {
  liAt: string;
  jsessionid: string;
  cookieHeader: string;
  /** Current people-search queryId, if the extension observed one. */
  queryId?: string;
  /**
   * Voyager operation NAMES the extension has seen from a real tab, newest
   * last, as `name@timestamp` (e.g. `voyagerSearchDashClusters@1696…`).
   * Diagnostic: reveals the operation LinkedIn currently uses for a search.
   */
  voyagerOps?: string[];
}

interface CapturePayload {
  li_at?: string;
  jsessionid?: string;
  cookie_header?: string;
  query_id?: string;
  voyager_ops?: string[];
  /** Legacy key name for `voyager_ops` — an older loaded worker still sends it. */
  voyager_ids?: string[];
  cookies?: Array<{ name?: string; value?: string }> | Record<string, string>;
}

/** Normalize a payload POSTed by the browser extension into a session, or null. */
export function normalizeExtensionPayload(payload: unknown): ExtensionCaptureResult | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as CapturePayload;

  const jar: Record<string, string> = {};
  if (Array.isArray(p.cookies)) {
    for (const c of p.cookies) if (c && c.name) jar[c.name] = String(c.value ?? '');
  } else if (p.cookies && typeof p.cookies === 'object') {
    for (const [k, v] of Object.entries(p.cookies)) jar[k] = String(v);
  }
  if (p.cookie_header) {
    for (const part of p.cookie_header.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) jar[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
  }

  const liAt = p.li_at ?? jar['li_at'];
  const jsessionid = p.jsessionid ?? jar['JSESSIONID'];
  if (!liAt || !jsessionid) return null;

  const cookieHeader = Object.keys(jar).length
    ? Object.entries(jar)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ')
    : `JSESSIONID="${jsessionid.replace(/"/g, '')}"; li_at=${liAt}`;

  const queryId = typeof p.query_id === 'string' && p.query_id ? p.query_id : undefined;
  // Accept both key names: the worker currently loaded in the browser may have
  // been built before this field was renamed.
  const ops = p.voyager_ops ?? p.voyager_ids;
  const voyagerOps = Array.isArray(ops)
    ? ops.filter((op): op is string => typeof op === 'string' && op.length > 0)
    : undefined;

  return { liAt, jsessionid, cookieHeader, queryId, voyagerOps };
}

async function validateSession(result: ExtensionCaptureResult): Promise<boolean> {
  try {
    const { createClient } = await import('./client.js');
    const client = createClient({
      liAt: result.liAt,
      jsessionid: result.jsessionid,
      cookieHeader: result.cookieHeader,
    });
    await client.get('/me');
    return true;
  } catch {
    return false;
  }
}

export interface BridgeOptions {
  port?: number;
  timeoutMs?: number;
  onStatus?: (message: string) => void;
  /** When true, verify the session against /me before resolving. */
  validate?: boolean;
}

export interface BridgeServeOptions {
  port?: number;
  onStatus?: (message: string) => void;
  /** When true, verify each session against /me before accepting it. */
  validate?: boolean;
  /**
   * Invoked for every valid session the extension POSTs. Awaited before the
   * listener considers the capture handled; a throw is reported via `onStatus`
   * and never kills the listener.
   */
  onCapture: (result: ExtensionCaptureResult) => void | Promise<void>;
}

export interface BridgeServerHandle {
  port: number;
  url: string;
  /** How many sessions have been received so far. */
  readonly received: number;
  /** Stop listening and release the port. */
  close: () => Promise<void>;
}

interface StartBridgeServerOptions {
  port: number;
  validate?: boolean;
  onStatus: (message: string) => void;
  onCapture: (result: ExtensionCaptureResult) => void | Promise<void>;
}

/**
 * Shared listener core. Binds to 127.0.0.1, parses the extension's POST,
 * validates (optionally), replies, then hands the session to `onCapture`.
 * The returned handle keeps the process alive until `close()`.
 */
function startBridgeServer(opts: StartBridgeServerOptions): Promise<BridgeServerHandle> {
  const { port, validate, onStatus, onCapture } = opts;
  let received = 0;

  return new Promise<BridgeServerHandle>((resolve, reject) => {
    const server = createServer((req, res) => {
      // The extension's service worker fetches from a chrome-extension:// origin.
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'content-type');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method !== 'POST' || !(req.url ?? '').startsWith('/session')) {
        res.writeHead(404);
        res.end('not found');
        return;
      }

      // Require a JSON content-type. A cross-origin page can only issue a
      // "simple" request without a preflight (text/plain, urlencoded or
      // multipart), so this stops a random site in the operator's browser from
      // blind-POSTing a forged session to 127.0.0.1:8787. The extension always
      // sends application/json.
      if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        res.writeHead(415);
        res.end('content-type must be application/json');
        return;
      }

      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1_000_000) req.destroy();
      });
      req.on('end', () => {
        void (async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            res.writeHead(400);
            res.end('bad json');
            return;
          }
          const result = normalizeExtensionPayload(parsed);
          if (!result) {
            res.writeHead(422);
            res.end('no li_at/JSESSIONID');
            return;
          }
          if (validate) {
            const ok = await validateSession(result);
            if (!ok) {
              res.writeHead(401);
              res.end('session invalid');
              onStatus('Extension sent cookies, but they failed /me validation.');
              return;
            }
          }
          received += 1;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, query_id: result.queryId ?? null }));
          // Hand off after responding so the extension's POST never waits on
          // disk I/O. A handler failure must not take down the listener.
          try {
            await onCapture(result);
          } catch (err) {
            onStatus(`Capture handler failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        })();
      });
    });

    server.on('error', (err) => {
      // The common case by far: a bridge is already running (or the port is
      // taken). A raw `EADDRINUSE` stack is not actionable, so say what to do.
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        reject(
          new Error(
            `Port ${port} is already in use — a bridge may already be listening ` +
              `(run \`linkedin extension status\`, or pass --port <n>).`,
          ),
        );
        return;
      }
      reject(err as Error);
    });
    server.listen(port, '127.0.0.1', () => {
      onStatus(
        `Listening on http://127.0.0.1:${port} — load the extension ` +
          '(assets/browser-extension) in chrome://extensions and click it.',
      );
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        get received() {
          return received;
        },
        close: () =>
          new Promise<void>((done) => {
            try {
              server.closeAllConnections?.();
              server.close(() => done());
            } catch {
              done();
            }
          }),
      });
    });
  });
}

/**
 * Start a long-lived listener and invoke `onCapture` for every session the
 * extension POSTs. Resolves as soon as the port is bound; the caller keeps the
 * handle and calls `close()` to stop. Used by `linkedin extension listen`, so
 * the browser extension can push a session at any moment (its auto-send loop)
 * without the operator re-running `linkedin login --extension` first.
 */
export async function serveSessionFromExtension(
  options: BridgeServeOptions,
): Promise<BridgeServerHandle> {
  const port = options.port ?? (Number(process.env.LINKEDIN_BRIDGE_PORT) || 8787);
  const onStatus = options.onStatus ?? ((m: string) => process.stderr.write(`${m}\n`));
  return startBridgeServer({
    port,
    validate: options.validate,
    onStatus,
    onCapture: options.onCapture,
  });
}

/**
 * Best-effort check that something is listening on the bridge port.
 *
 * `linkedin logout` deletes the stored session, but a long-running
 * `extension listen` will save it straight back from the browser on the next
 * auto-send (~60s). Logout uses this to warn instead of silently re-logging the
 * operator in. Never throws.
 */
export function isBridgeListening(port?: number, timeoutMs = 300): Promise<boolean> {
  const resolved = port ?? (Number(process.env.LINKEDIN_BRIDGE_PORT) || 8787);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const socket = createConnection({ host: '127.0.0.1', port: resolved });

    const done = (result: boolean): void => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * One-shot listener: resolve with the first valid session the extension POSTs,
 * then stop listening. Rejects on timeout. The caller persists the result.
 * Used by `linkedin login --extension`.
 */
export async function captureSessionFromExtension(
  options: BridgeOptions = {},
): Promise<ExtensionCaptureResult> {
  const port = options.port ?? (Number(process.env.LINKEDIN_BRIDGE_PORT) || 8787);
  const timeoutMs =
    options.timeoutMs ?? (Number(process.env.LINKEDIN_BRIDGE_TIMEOUT_MS) || 300_000);
  const onStatus = options.onStatus ?? ((m: string) => process.stderr.write(`${m}\n`));

  return new Promise<ExtensionCaptureResult>((resolve, reject) => {
    let settled = false;
    let handle: BridgeServerHandle | null = null;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      fn();
      void handle?.close();
    };

    const timeoutHandle = setTimeout(
      () =>
        finish(() =>
          reject(
            new Error(
              `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the browser extension.`,
            ),
          ),
        ),
      timeoutMs,
    );
    // Never let the idle timer hold the process open after a successful capture.
    timeoutHandle.unref?.();

    startBridgeServer({
      port,
      validate: options.validate,
      onStatus,
      onCapture: (result) => finish(() => resolve(result)),
    })
      .then((h) => {
        handle = h;
        // Capture landed before listen() resolved (rare) — don't leak the port.
        if (settled) void h.close();
      })
      .catch((err) => finish(() => reject(err as Error)));
  });
}
