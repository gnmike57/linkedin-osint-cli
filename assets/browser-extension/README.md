# LinkedIn CLI — Session Bridge extension

This tiny Chrome extension lets the `linkedin` CLI capture your **existing**
LinkedIn session with **no re-login** and **no cookie decryption**, by reading
the cookies *from inside Chrome* (`chrome.cookies` returns already-decrypted
values, so Chrome's app-bound `v11`/`v20` encryption is irrelevant) and POSTing
them to a localhost listener started by the CLI. Nothing leaves your machine.

## Why this exists
- Chrome 127+ encrypts `li_at`/`JSESSIONID` **app-bound** — no external process
  can decrypt the on-disk cookie DB.
- Chrome 136+ refuses to be debugged on the **default** profile.
So the CLI can't read your live Chrome session by itself. An extension can.

## Install (one time)
1. In Chrome, open `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this `assets/browser-extension` folder.
4. (Optional) Pin the extension to the toolbar.

## Use — the always-on bridge (recommended)
```bash
linkedin extension listen       # CLI listens on http://127.0.0.1:8787 until Ctrl+C
```
Leave it running. The extension pushes its session by itself (see **Auto-send**),
so you never have to click anything and never see *"CLI not listening on
127.0.0.1:8787"* again. Every capture is written to
`~/.linkedin-cli/config.json`.

Run it detached on Windows:
```powershell
Start-Process node -ArgumentList 'dist\index.js','extension','listen' -WindowStyle Hidden
```

### One-shot alternative
```bash
linkedin login --extension      # waits for a single session, then exits
```
Then click the extension's icon → **Send session to CLI**. This only works while
that exact command is running, so prefer `extension listen`.

## Auto-send
The service worker pushes its live cookies + queryId on a repeating alarm:

- **Default: every 60 seconds.** The popup lets you change it; Chrome clamps
  alarm periods to a 30-second floor.
- Also on browser start, on install, and on a 5-minute fallback heartbeat.

The popup shows the current interval and the last send result, and has a
**Send session to CLI** button for an immediate push.

## Automatic queryId capture (self-healing)
LinkedIn rotates the people-search GraphQL `queryId`
(`voyagerSearchDashClusters.<hash>`) on every deploy, which makes
`osint employees` / `search people` return **HTTP 400**. The hash is **not**
present in the search page HTML (it lives in LinkedIn's JS bundles), so the
extension learns it the only reliable way — from LinkedIn's own call:

1. It opens `https://www.linkedin.com/search/results/people/` in a **background
   tab** (inactive — you won't lose your place).
2. `chrome.webRequest` sees the GraphQL call that page makes — reading the id
   from the request URL *or* its POST body — and records the hash.
3. The tab is closed and the hash is forwarded to the CLI with the next auto-send.

Only requests from a **real tab** are observed: the API proxy's own calls (made
by the service worker, `tabId -1`) are ignored, so the CLI can never feed its own
stale hash back into the cache.

This runs automatically whenever the cached hash is missing or older than 6
hours (and never more than once every 10 minutes). The popup also has a
**Refresh people-search queryId** button to force it — and any People search you
run yourself is observed too.

> Make sure the extension is loaded **once**. Two copies
> (`assets/browser-extension` *and* `~/.linkedin-cli/browser-extension`) run two
> service workers with separate caches; the older one will keep re-sending a
> stale `queryId` and overwrite the good one every few minutes.

## Notes
- Scope: `cookies`, `alarms`, `webRequest`, `storage` + host permissions for
  `*.linkedin.com` and `http://127.0.0.1/*`. No remote endpoints.
- **After updating the extension files, click _Reload_ in `chrome://extensions`**
  (the `webRequest`/`storage` permissions need re-approval).
- `chrome.tabs.create`/`remove` are used only for the queryId capture and need no
  extra permission (no tab URL/title is ever read).
- To change the port: `linkedin extension listen --port 9999` (and set the same
  port in `service-worker.js`).
