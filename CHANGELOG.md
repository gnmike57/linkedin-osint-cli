# Changelog

All notable changes to this project are documented here. Releases are tagged on
`master`; each entry mirrors the corresponding GitHub release.

## [Unreleased] — interactive shell with local NLP

- **Always-on extension bridge (`linkedin extension listen`)** — a long-running
  localhost listener (default `127.0.0.1:8787`) that accepts a session at *any*
  moment and persists each capture to `~/.linkedin-cli/config.json`. This fixes
  the recurring *"CLI not listening on 127.0.0.1:8787"* failure: the extension's
  button used to only work while `linkedin login --extension` happened to be
  running. Stops on Ctrl+C, `--seconds`, or `--once`; `--dry-run` observes
  without writing config. Each capture is **merged** into the stored config (a
  bare overwrite on a ~60 s cadence would erase `profile_name`/`profile_urn` and
  a previously learned `query_id`), and the listener accepts only
  `application/json`, so a random web page cannot blind-POST a forged session to
  `127.0.0.1:8787`.
- **Extension auto-send loop** — the MV3 service worker now pushes its live
  session + captured `queryId` on a repeating alarm (default **every 60 s**,
  user-tunable in the popup, clamped to Chrome's 30 s alarm floor) instead of the
  old 5-minute heartbeat, so the CLI's config stays fresh unattended.
- **Self-healing people-search `queryId`** — LinkedIn rotates
  `voyagerSearchDashClusters.<hash>` on every deploy, which made
  `osint employees` fail with *HTTP 400*. The id is **not** recoverable
  client-side: the search page HTML carries no `queryId` (verified — 802 KB app
  shell, zero occurrences), the JS bundles only reference
  `voyagerSearchDashSearchHome`, and the legacy `search/hits`, `search/blended`
  and `typeahead/hitsV2` endpoints are gone (400/404). So the extension learns it
  from the only reliable source — LinkedIn's own GraphQL call: it briefly opens
  the people-search page in a **background tab**, records the hash that page
  uses, closes the tab, and forwards it with the session. `osint employees` now
  reports the `query_id` it used, and a rotated hash produces an actionable error
  instead of a silent *0 employees* (every page 400s and the command previously
  exited 0 anyway).
- **Session/config integrity fixes** — a family of "partial object written over
  the stored session" bugs, plus the loose ends around it:
  - `linkedin login` (all three capture paths), the mid-run 401 auto-refresh and
    the extension bridge now persist through one canonical `saveSession()`, which
    replaces the session-coupled fields (`li_at`, `jsessionid`, `cookie_header`)
    together and preserves sticky metadata (`profile_name`, `profile_urn`,
    `query_id`). Each of those paths used to silently drop whatever it did not
    mention.
  - **A stored cookie jar can no longer override a fresh login.** A full jar wins
    over `li_at`/`JSESSIONID` at request time, so a jar from an earlier session
    kept the CLI on the OLD credentials while reporting success.
    `client.jarBelongsToSession()` now verifies the jar's identity cookies match
    the configured pair and otherwise sends the fresh credentials (warning once).
  - `saveSession` **drops** a stored jar when the new session has none — keeping
    it would resurrect the previous session.
  - Config writes are **atomic** (temp file + rename): the bridge saves every
    ~60s while other processes read, so a reader could previously observe a
    truncated file and report "not logged in"; a crash could destroy the session.
  - `loadConfig` no longer throws on a partial or hand-edited config (it used to
    swallow the error and report "no session" even when `li_at` was valid), and
    `config.json` is forced to 0600 even when it already existed.
  - `linkedin logout` **warns when a bridge is still listening** — the always-on
    auto-send would otherwise save the browser session straight back within ~60s,
    silently cancelling the logout.
  - Shell history no longer records credentials (`login --li-at …` is redacted
    before it reaches disk) and is created 0600; the tool-owned browser profile
    directory is created 0700.
  - `tests/config-write-policy.test.ts` fails the suite if any module outside
    `core/config.ts` calls `saveConfig` wholesale again.
- **Browser-assisted login (`linkedin login --browser`)** — captures the session
  from a **tool-owned persistent Chromium profile**
  (`~/.linkedin-cli/browser-profile`) over the Chrome DevTools Protocol. Sign in
  **once**; every later run reuses that profile silently, and when it is already
  signed in the capture runs **headless** with no window (`--headless` forces a
  headless attempt). A tool-owned profile sidesteps both Chrome 136's refusal to
  debug the default data directory and Chrome's app-bound (`v11`/`v20`) cookie
  encryption, because CDP returns already-decrypted values. Falls back to the
  manual cookie-paste prompt when no Chromium binary is available. The shell's
  `login` builtin and Session menu route here first.
- **Windows/Edge cookie import (`--from-chrome`)** — DPAPI-unlocked master key
  from the browser's `Local State` (via PowerShell) + AES-256-GCM decryption of
  `v10` cookies. When the store is app-bound (`v11`/`v20`, the default on current
  Chrome/Edge on Windows) the command now **auto-routes to the live CDP capture**
  above instead of failing with an opaque decryption error. SQLite access uses
  the `sqlite3` CLI when present and Node's built-in `node:sqlite` otherwise.
- **Session auto-refresh** — the HTTP client re-captures the session from the
  persistent browser profile and retries once when a request hits a mid-run 401,
  so long multi-call scrapes (`osint employees`, `osint funnel`, `profile view`)
  survive a token LinkedIn expires partway through.
- **Browser-extension session bridge (`linkedin login --extension`)** — a tiny
  MV3 extension (`assets/browser-extension/`) reads the *decrypted* LinkedIn
  cookies with `chrome.cookies` (immune to app-bound `v11`/`v20` encryption and
  the Chrome 136 default-profile debug ban) and POSTs them to a localhost
  listener on `127.0.0.1:8787`, so an existing sign-in is captured with **no
  re-login and no cookie decryption**. It also observes LinkedIn's own GraphQL
  calls (`chrome.webRequest`) to record the **current people-search `queryId`**,
  which LinkedIn rotates per deploy — so `osint employees` keeps working after a
  rotation without a code change. Load it once via `chrome://extensions` →
  Developer mode → Load unpacked.
- **Extension request transport (`LINKEDIN_HTTP=extension`) + `extension`
  command group** — with the companion extension loaded, every Voyager call can
  be executed **inside the browser itself**: the CLI queues requests on a
  localhost poll-proxy (`127.0.0.1:8788`, override with
  `LINKEDIN_EXTENSION_PROXY_PORT`), the extension picks each one up and runs
  `fetch()` with the real browser TLS/HTTP2 fingerprint and the live cookie jar
  (no decryption, no re-login), then posts the response back. Two new commands
  manage the bridge: `linkedin extension install` (copies the bundled extension
  to a stable folder — default `~/.linkedin-cli/browser-extension` — and prints
  the exact "Load unpacked" steps) and `linkedin extension status` (connectivity
  check + troubleshooting).

- **Shell REPL is now the default console** — bare `linkedin` on a TTY (or
  `linkedin menu` / the new `linkedin shell` alias) opens a bash/PowerShell-style
  prompt that accepts three input styles in one line: exact commands
  (`search people --keywords "software engineer" --network F`), plain English
  (`scrape all the sales guys at acme, limit 50`), and the old palette
  (`browse [group]` / `menu`). The NLP layer is local, deterministic rules over
  the command catalog — offline, no API key, no network. Nothing executes
  without a confirm-first staging step showing the assembled command line;
  write commands (posts/messaging/connections/engage mutations) show a red ⚠
  and require an explicit `y`. Staging supports inline overrides (`count 25`,
  `--limit 50`, enum/boolean validation), a prefilled `edit` walkthrough,
  `raw` (print the scriptable line without executing), and `q` (cancel).
  Tab completion covers builtins/groups/subcommands/long flags; persistent
  history lives at `~/.linkedin-cli/history` (last 200 lines, fail-safe).
  `LINKEDIN_UI=classic` keeps the palette-only UI; `LINKEDIN_SHELL=plain`
  forces the non-TTY grammar that the new `smoke:shell` script drives.
  Zero new dependencies — `node:readline` + the existing catalog/Zod/colors.

## [0.2.0] — interactive console, consolidated OSINT suite, 40-issue bug sweep

Full LinkedIn platform management from the terminal — 43 platform commands
**plus a 13-command OSINT suite**, usable as a **CLI**, an **MCP server**
(56 tools for Claude Code / Cursor / Windsurf and other agents), and an
**interactive console**.

### Highlights

- **Interactive console** — bare `linkedin` on a TTY (or `linkedin menu`
  anywhere) opens a searchable command palette over all 56 tools, a category
  browser, guided prompts derived from each command's Zod schema, and the
  equivalent scriptable command line printed before every run. Session actions
  (`login`, `status --verify`, `logout`) are built in. Uses
  `@inquirer/prompts` when available and falls back to a built-in
  `node:readline` console otherwise (`LINKEDIN_PROMPTS=fallback|inquirer`).
- **OSINT suite** — ports the best of three legacy Python toolkits into the
  TypeScript engine (API-native, no browser): `discover`, `employees`, `names`,
  `classify`, `ai-score`, `ai-classify`, `orgchart`, `matrix`, `stats`, `scan`,
  `email-lookup`, `deep-dive`, `funnel`. The classifier rules engine
  (12 hierarchy levels × 20 divisions, 28 patterns, 287 overrides) was verified
  75/75 against the original Python self-test; NameMutator verified 1:1 against
  Python ground truth. Legacy projects are archived intact under
  `legacy/python/` with a port-mapping README.
- **Offline-safe commands** — `classify --title`, `names`, `matrix`, `stats`,
  `scan` run without cookies; auth is lazy, so it only surfaces on the first
  real request.

### Reliability

- 40-issue bug sweep: double URL-encoding in search/discover, GET-only retries
  (no duplicate writes), `clearTimeout` leaks, Node 18 crypto fallback,
  request-queue rate limiting, lazy MCP auth, XSS `safeHttpUrl` allowlist in the
  matrix HTML, classifier company-suffix and industry word-boundary matching,
  discover pagination slugs, Windows-safe image filenames, masked login prompts,
  `--fields` metadata preservation.
- Console never hangs: the readline fallback queues lines, so piped/file input
  arriving in one burst is no longer dropped (this previously left an unsettled
  top-level await).
- `osint matrix` accepts people CSV/JSON and org-chart JSON, and reports
  `EMPTY_INPUT` / `INVALID_JSON` instead of leaking a raw `JSON.parse` message.
- `formatError` maps `ENOENT`/`EACCES`/`EISDIR`/`SyntaxError` to
  `FILE_NOT_FOUND`/`PERMISSION_DENIED`/`NOT_A_FILE`/`INVALID_JSON` across every
  command and MCP tool.
- `@inquirer/prompts` is an **optional** dependency, so restricted registries or
  partial installs never break `npm ci`.

### Verification

- 219 unit tests passing, `tsc --noEmit` clean, `tsup` build OK.
- `npm run smoke:menu` — end-to-end console smoke over two scripted sessions
  (search + category browse), asserting the selected command executes, no prompt
  hangs on piped input, and the process exits cleanly.
- `npm run smoke:mcp` — MCP initialize handshake + `tools/list`: 56 tools, no
  duplicates, every tool has a schema.
- CI green on Node 18 / 20 / 22 (ubuntu-latest) and Node 20 (windows-latest).
- Clean-clone check: `npm ci` → `typecheck` → `test` → `build` → both smoke
  suites all pass from a fresh clone.

### Safety

Session cookies and Voyager calls stay on your own machine. Do not run the
session-bearing commands from a cloud agent; remote agents should install the
CLI or call an MCP server already running on the local harness. Use responsibly
and within LinkedIn's terms and applicable law.
