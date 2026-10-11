// LinkedIn CLI Session Bridge — service worker (MV3).
//
// Reads the decrypted LinkedIn cookies via chrome.cookies (works even for
// app-bound v11/v20 values, because the extension runs inside Chrome) and POSTs
// them to the local `linkedin` CLI listener. Nothing leaves the machine.
//
// Send triggers: extension install, browser startup, a repeating auto-send
// alarm (default every 60s, tunable in the popup) and the popup button — so
// `linkedin extension listen` receives a fresh session without any clicking,
// and `linkedin login --extension` completes on its own within a minute.
//
// ALSO acts as an API proxy: the CLI runs a local HTTP server (default 8788)
// and the extension polls it for requests, executes them via fetch() in the
// browser context, and posts responses back. This provides real TLS/HTTP/2
// fingerprints and automatic cookie handling.

const BRIDGE_URL = 'http://127.0.0.1:8787/session';
const PROXY_URL = 'http://127.0.0.1:8788';

// --- Auto-send schedule (Extension -> CLI, unattended) ---
//
// The CLI's long-lived listener (`linkedin extension listen`) accepts a session
// at any moment; this worker pushes its live cookies + queryId on a repeating
// alarm so the CLI's config never goes stale and a rotated people-search
// queryId is picked up without any clicking. The interval is user-tunable from
// the popup (chrome.storage.local.autoSendSeconds).
const AUTOSEND_ALARM = 'linkedin-cli-autosend';
const HEARTBEAT_ALARM = 'linkedin-cli-heartbeat';
const KEEPALIVE_ALARM = 'linkedin-cli-proxy-keepalive';
const DEFAULT_AUTO_SEND_SECONDS = 60;
// chrome.alarms clamps periods to 30s on Chrome 120+ (1 min on older builds).
const MIN_AUTO_SEND_SECONDS = 30;

async function getAutoSendSeconds() {
  try {
    const { autoSendSeconds } = await chrome.storage.local.get('autoSendSeconds');
    const n = Number(autoSendSeconds);
    if (Number.isFinite(n) && n >= MIN_AUTO_SEND_SECONDS) return Math.floor(n);
  } catch {
    /* fall through to the default */
  }
  return DEFAULT_AUTO_SEND_SECONDS;
}

/** (Re)create the auto-send alarm from the stored interval; returns it in seconds. */
async function scheduleAutoSend() {
  const seconds = await getAutoSendSeconds();
  const periodInMinutes = Math.max(MIN_AUTO_SEND_SECONDS, seconds) / 60;
  // `chrome.alarms.create` REPLACES an alarm of the same name, which would
  // reset its timer. The worker restarts often (idle suspend + keepalive wakes
  // re-run top-level code), so only (re)create when the period actually
  // differs — otherwise a 60s alarm could be pushed back forever.
  try {
    const existing = await chrome.alarms.get(AUTOSEND_ALARM);
    if (existing && Math.abs((existing.periodInMinutes || 0) - periodInMinutes) < 1e-6) {
      return seconds;
    }
  } catch {
    /* alarms.get unavailable — fall through and create */
  }
  try {
    await chrome.alarms.create(AUTOSEND_ALARM, { periodInMinutes });
  } catch {
    // Older Chrome returns void instead of a promise.
    chrome.alarms.create(AUTOSEND_ALARM, { periodInMinutes });
  }
  return seconds;
}

// --- Session Capture (Extension -> CLI) ---

async function captureAndSend() {
  let cookies;
  try {
    cookies = await chrome.cookies.getAll({ domain: 'linkedin.com' });
  } catch (e) {
    return { ok: false, error: 'cookie read failed: ' + e };
  }
  const jar = {};
  for (const c of cookies) jar[c.name] = c.value;
  if (!jar.li_at || !jar.JSESSIONID) {
    return { ok: false, error: 'No LinkedIn session in this browser profile (sign in to linkedin.com first).' };
  }
  const cookie_header = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  let query_id;
  let voyager_ops;
  try {
    ({ srpQueryId: query_id, voyagerOps: voyager_ops } = await chrome.storage.local.get([
      'srpQueryId',
      'voyagerOps',
    ]));
  } catch {
    query_id = undefined;
    voyager_ops = undefined;
  }
  try {
    const res = await fetch(BRIDGE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        li_at: jar.li_at,
        jsessionid: jar.JSESSIONID,
        cookie_header,
        cookies: jar,
        query_id: query_id || undefined,
        voyager_ops: voyager_ops || undefined,
      }),
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return {
      ok: false,
      error: 'CLI not listening on 127.0.0.1:8787 — run: linkedin extension listen (or linkedin login --extension)',
    };
  }
}

/** captureAndSend() + persist the outcome so the popup can show last-send state. */
async function sendAndTrack() {
  const res = await captureAndSend();
  try {
    await chrome.storage.local.set({
      lastSend: {
        at: Date.now(),
        ok: !!res.ok,
        status: res.status || null,
        error: res.error || null,
      },
    });
  } catch {
    /* storage is best-effort */
  }
  return res;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return false;
  if (msg.type === 'capture') {
    sendAndTrack().then(sendResponse);
    return true; // async response
  }
  if (msg.type === 'setAutoSend') {
    (async () => {
      const seconds = Math.max(
        MIN_AUTO_SEND_SECONDS,
        Math.floor(Number(msg.seconds) || DEFAULT_AUTO_SEND_SECONDS),
      );
      await chrome.storage.local.set({ autoSendSeconds: seconds });
      await scheduleAutoSend();
      sendResponse({ ok: true, seconds });
    })();
    return true;
  }
  if (msg.type === 'captureQueryId') {
    captureQueryIdViaTab().then(sendResponse);
    return true;
  }
  if (msg.type === 'getStatus') {
    (async () => {
      const seconds = await getAutoSendSeconds();
      const { lastSend } = await chrome.storage.local.get('lastSend');
      const { srpQueryId } = await chrome.storage.local.get('srpQueryId');
      sendResponse({ ok: true, seconds, lastSend: lastSend || null, queryId: srpQueryId || null });
    })();
    return true;
  }
  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  scheduleAutoSend();
  // Capture a fresh queryId right away (the reload/install is the natural
  // moment), then push the session.
  autoSendCycle();
});
chrome.runtime.onStartup.addListener(() => {
  scheduleAutoSend();
  autoSendCycle();
});

// Re-apply the configured interval the moment the popup changes it.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.autoSendSeconds) scheduleAutoSend();
});

// Slow fallback in case the auto-send alarm is ever dropped (browser sleep,
// profile switch, alarm eviction).
chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEARTBEAT_ALARM) sendAndTrack();
  if (alarm.name === AUTOSEND_ALARM) autoSendCycle();
});

// Apply the persisted interval on every worker start (idempotent — see
// scheduleAutoSend).
scheduleAutoSend();

// Wake the worker at least every 30s so the API proxy reconnects quickly.
// MV3 suspends an idle worker ~30s after the CLI stops listening on 8788;
// without a frequent wake a suspended worker only returns at the next
// heartbeat (up to 5 minutes), and one-shot CLI commands stall waiting for
// its ping. Any wake re-runs the top-level startProxyPolling() below, and
// while something IS listening the long-poll loop keeps the worker alive
// continuously. (Chrome 120+ allows 30s alarm periods; older builds clamp
// to 1 min, which still works — just slower to reconnect.)
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });

// Learn the CURRENT people-search queryId by observing LinkedIn's own GraphQL
// calls (LinkedIn rotates `voyagerSearchDashClusters.<hash>` on every deploy).
// Whenever you run a People search in LinkedIn, the extension records the hash
// and includes it with the next auto-send, so the CLI stops 400-ing.
// Match both call styles LinkedIn uses — `?queryId=<id>` and the older
// `.../graphql/<id>` path form — we only need the current hash either way.
const PEOPLE_SEARCH_RE = /voyagerSearchDashClusters\.[a-f0-9]{8,}/;
// Any Voyager operation id: `voyager<Something>Dash<Something>.<hash>`. Capturing
// the whole family (not just the people-search name) means a renamed or moved
// search operation is still recorded — and the popup can show what was seen.
const VOYAGER_ID_RE = /voyager[A-Za-z]*Dash[A-Za-z]*\.[a-f0-9]{16,}/g;

/** Every Voyager operation id in a request URL or its POST body. */
function voyagerIdsFrom(details) {
  const sources = [details.url ?? ''];
  const raw = details.requestBody && details.requestBody.raw && details.requestBody.raw[0];
  if (raw && raw.bytes) {
    try {
      sources.push(new TextDecoder().decode(raw.bytes));
    } catch {
      /* undecodable body — ignore */
    }
  }

  const ids = new Set();
  for (const source of sources) {
    for (const id of source.match(VOYAGER_ID_RE) ?? []) ids.add(id);
  }
  return [...ids];
}

chrome.webRequest.onBeforeRequest.addListener(
  async (details) => {
    // Ignore requests that are not tied to a real tab. This matters: the API
    // proxy makes Voyager calls from *this service worker* (tabId -1) on the
    // CLI's behalf — observing those would feed the CLI's own (possibly stale)
    // queryId straight back into the cache. Only genuine page loads count,
    // i.e. the user's browsing or our own captureQueryIdViaTab() tab.
    if (details.tabId < 0) return;
    const ids = voyagerIdsFrom(details);
    if (ids.length === 0) return;

    const now = Date.now();
    const peopleSearch = ids.find((id) => PEOPLE_SEARCH_RE.test(id));

    // Accumulate "operation name @ last seen" instead of replacing the list:
    // the feed polls constantly and would otherwise overwrite a one-off search
    // call before the next auto-send reads it.
    let seen = [];
    try {
      ({ voyagerOps: seen = [] } = await chrome.storage.local.get('voyagerOps'));
    } catch {
      seen = [];
    }
    const byName = new Map(seen.map((entry) => [String(entry).split('@')[0], String(entry)]));
    for (const id of ids) {
      const name = id.split('.')[0];
      byName.set(name, `${name}@${now}`);
    }

    const patch = { voyagerOps: [...byName.values()].slice(-40) };
    // ONLY a genuine people-search observation may mark the hash as fresh —
    // refreshing this on every Voyager call (a feed poll, say) makes
    // autoSendCycle() believe a valid hash is cached and skip re-capturing.
    if (peopleSearch) {
      patch.srpQueryId = peopleSearch;
      patch.srpQueryIdAt = now;
    }
    // A single set() so the map and the people-search id never disagree.
    try {
      await chrome.storage.local.set(patch);
    } catch {
      /* storage is best-effort */
    }
  },
  // `voyager/api/*` rather than just `/graphql`: the SRP call has moved paths
  // across builds, and the id regex above is what actually discriminates. The
  // requestBody is needed because LinkedIn may carry the id in the POST body.
  { urls: ['*://*.linkedin.com/voyager/api/*'] },
  ['requestBody'],
);

// --- Live queryId capture (self-healing) ---
//
// The people-search GraphQL `queryId` rotates per deploy and is NOT present in
// the SRP HTML (it lives in LinkedIn's JS bundles), so the only reliable
// source is the browser's own GraphQL call. Loading the people-search page in
// a background tab makes the SPA issue exactly that call, which the webRequest
// listener above records. The tab is closed as soon as the hash lands — the
// user never has to search manually.
//
// chrome.tabs.create/remove need no extra permission (we never read the
// sensitive Tab.url/title props; host permission for *.linkedin.com covers us).
const QUERY_ID_MAX_AGE_MS = 6 * 60 * 60 * 1000; // re-learn twice a day
const QUERY_ID_RETRY_MS = 10 * 60 * 1000; // never re-open a tab more often than this

async function captureQueryIdViaTab(timeoutMs = 20000) {
  // Stash the cached value before clearing it. If the capture fails we must put
  // it back — collapsing to "no queryId" would make the CLI fall back to the
  // bundled (stale) hash and 400 every page.
  let previous = null;
  try {
    previous = await chrome.storage.local.get(['srpQueryId', 'srpQueryIdAt']);
    await chrome.storage.local.remove(['srpQueryId', 'srpQueryIdAt']);
  } catch {
    previous = null;
  }
  const restorePrevious = () => {
    if (previous && previous.srpQueryId) {
      chrome.storage.local
        .set({
          srpQueryId: previous.srpQueryId,
          srpQueryIdAt: previous.srpQueryIdAt || Date.now(),
        })
        .catch(() => {});
    }
  };

  let tab;
  try {
    tab = await chrome.tabs.create({
      url: 'https://www.linkedin.com/search/results/people/',
      active: false,
    });
  } catch (e) {
    restorePrevious();
    return { ok: false, error: 'could not open a background tab: ' + e };
  }

  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { srpQueryId } = await chrome.storage.local.get('srpQueryId');
      if (srpQueryId) {
        await chrome.storage.local.set({ srpQueryIdAt: Date.now() });
        return { ok: true, query_id: srpQueryId };
      }
      await sleep(500);
    }
    restorePrevious();
    return {
      ok: false,
      error:
        'no people-search GraphQL call observed within ' +
        Math.round(timeoutMs / 1000) +
        's (are you signed in to linkedin.com in this browser?)',
    };
  } finally {
    if (tab && tab.id !== undefined) {
      try {
        await chrome.tabs.remove(tab.id);
      } catch {
        /* tab already gone */
      }
    }
  }
}

/**
 * Unattended cycle: refresh a missing/stale queryId, then push the session.
 * Used by the repeating auto-send alarm, so the CLI's config self-heals after
 * a LinkedIn deploy rotates the hash.
 */
async function autoSendCycle() {
  const store = await chrome.storage.local.get(['srpQueryId', 'srpQueryIdAt', 'srpQueryIdAttemptAt']);
  const age = Date.now() - Number(store.srpQueryIdAt || 0);
  const stale = !store.srpQueryId || !store.srpQueryIdAt || age > QUERY_ID_MAX_AGE_MS;
  const lastAttempt = Number(store.srpQueryIdAttemptAt || 0);

  if (stale && Date.now() - lastAttempt > QUERY_ID_RETRY_MS) {
    await chrome.storage.local.set({ srpQueryIdAttemptAt: Date.now() });
    const cap = await captureQueryIdViaTab();
    if (!cap.ok) console.warn('[LinkedIn CLI] queryId capture:', cap.error);
  }

  return sendAndTrack();
}

// --- API Proxy Polling (Extension -> CLI -> LinkedIn) ---

let proxyPolling = false;

function startProxyPolling() {
  if (proxyPolling) return;
  proxyPolling = true;
  pollForProxyRequests();
}

// Start polling on EVERY service-worker wake — top-level code re-runs on each
// wake and MV3 suspends idle workers constantly (module state resets with it),
// so starting only from onInstalled/onStartup would let the proxy die with
// the first idle suspend. The in-flight long-poll fetch keeps the worker
// alive while a scrape is running.
startProxyPolling();

async function pollForProxyRequests() {
  while (proxyPolling) {
    try {
      // Ping to let CLI know we're alive
      await fetch(`${PROXY_URL}/ping`, { method: 'POST' }).catch(() => {});
      
      // Long-poll for next request
      const response = await fetch(`${PROXY_URL}/next-request`, {
        method: 'GET',
        // Long poll timeout handled by server (25s)
      });

      if (response.status === 204) {
        // No request available, continue polling
        continue;
      }

      if (!response.ok) {
        console.error('[LinkedIn CLI] Proxy poll failed:', response.status);
        await sleep(1000);
        continue;
      }

      const request = await response.json();
      if (!request || !request.requestId) continue;

      // Execute the request in browser context
      await executeProxyRequest(request);
    } catch (err) {
      // Network error or CLI not running - wait and retry
      await sleep(2000);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeProxyRequest(request) {
  const { requestId, url, method, headers, body } = request;

  try {
    // The browser attaches the live cookie jar itself (`cookie` is a forbidden
    // fetch header, so any stale cookie header from the CLI is silently
    // ignored). The CSRF token IS settable, though — refresh it from the
    // browser's current JSESSIONID so a saved-but-rotated CLI session cannot
    // 401 the call.
    const outHeaders = Object.assign({}, headers || {});
    try {
      const all = await chrome.cookies.getAll({ domain: 'linkedin.com' });
      const js = all.find((c) => c.name === 'JSESSIONID');
      if (js && js.value) outHeaders['csrf-token'] = js.value.replace(/"/g, '');
    } catch {
      /* keep the CLI-provided token */
    }

    // Execute the request in the browser context — real TLS/HTTP2 fingerprint,
    // live cookies, same origin privileges as the user's own browsing.
    const fetchOpts = {
      method: method || 'GET',
      headers: outHeaders,
      credentials: 'include', // critical: sends the live LinkedIn cookies
    };

    // Add body for non-GET requests
    if (body && method !== 'GET' && method !== 'HEAD') {
      fetchOpts.body = body;
    }

    // Execute the request in the browser context
    const response = await fetch(url, fetchOpts);

    // Read response
    const responseText = await response.text();
    const responseHeaders = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    // Post response back to CLI
    await fetch(`${PROXY_URL}/response/${requestId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId,
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        body: responseText,
      }),
    });
  } catch (err) {
    // Post error back to CLI
    await fetch(`${PROXY_URL}/response/${requestId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId,
        error: err instanceof Error ? err.message : String(err),
      }),
    }).catch(() => {});
  }
}

