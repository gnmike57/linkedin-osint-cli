# Multi-Account Read Pipeline — Design Spec

**Date:** 2026-10-12
**Status:** Approved (2026-10-12)
**Feature:** Make multi-account LinkedIn **reads** bulletproof end-to-end — sessions that cannot be silently destroyed, an account health/failover pool, a restart-surviving rate budget, fingerprint-routed extension transport, a supervised bridge, and self-healing `queryId`. **Reads only; no write actions.**

---

## 1. Purpose

Multiple LinkedIn accounts are used as a **failover and scale pool for scraping
(reads)**. Today that pool is unreliable in five distinct ways, all confirmed by
reading the code (see §4). The goal is a pipeline where an operator can point a
read job at a set of accounts and have it:

1. **never destroy a session** it is trying to use;
2. **never execute a request as the wrong account**;
3. **keep working when individual accounts get blocked** (automatic failover);
4. **respect a per-account pace that survives process restarts**;
5. **survive the bridge process dying**;
6. **recover from a rotated `queryId` without human intervention**.

### Success criteria

1. A browser-captured session can **never** be replayed over the plain Node
   `fetch` transport without an explicit opt-out — the failure mode the project's
   own README documents (using a browser-created session from a non-browser TLS
   fingerprint gets `li_at` invalidated).
2. A read targeted at account *X* is either executed **by X's browser** or
   **refused with an explicit error** — never silently executed by account *Y*.
3. A 401/403/429 on account *A* transparently retries the read on account *B*
   from the same pool, and *A* enters a cooldown.
4. Per-account read budgets are enforced **across processes** and **survive
   restarts** (today's in-memory `MIN_REQUEST_GAP_MS` does neither).
5. `extension status` reports bridge **capture age** and a *stale* verdict; a
   watchdog restarts a dead bridge.
6. A stale `queryId` produces a loud, actionable failure — never a silent exit-0
   with zero results — and the extension can be asked to re-learn it on demand.
7. All existing tests stay green (356 at time of writing); typecheck, lint and
   build stay clean.

## 2. Goals and non-goals

**Goals**

- A **session-integrity guard** that blocks jar-over-fetch usage by default.
- **HTML-first reads**: prefer LinkedIn's server-rendered pages (no `queryId`,
  human-looking traffic) over Voyager API bursts.
- **Opportunistic health** — no dedicated `/me` probe traffic; health is derived
  from real requests.
- A **health/cooldown model** per session and an **account grouping** so many
  session fingerprints belonging to one person collapse into one account.
- A **persisted, cross-process rate budget** per account.
- **Fingerprint-routed** extension proxy so a request reaches the intended
  browser instance, degrading safely to today's behaviour when unset.
- A **supervised, observable bridge** (heartbeat file + watchdog + capture age).
- **On-demand `queryId` re-learn** and loud failure on a stale hash.
- Zero new runtime dependencies.

**Non-goals**

- **No write actions of any kind** — no follows, connection requests, reactions,
  comments, messages, post create/edit. Their rate-limit machinery is explicitly
  not built.
- No account-creation automation (see §11, risk R1).
- No change to the `queryId`-less HTML parsers already in use.
- No new external services, no cloud NLP, no proxy rotation vendors.
- No change to MCP tool signatures beyond additive optional fields.

## 3. Shared understanding (agreed with the user)

Recorded verbatim in intent, to be preserved by any later edit:

1. **Purpose of multiple accounts** — *"Reads only — multiple accounts are
   failover/scale for scraping; no writes ever."* The write-campaign subsystem is
   dropped from this design entirely.
2. **Browser topology** — *"Not sure / the accounts are throwaways I make as I
   go — just make whatever works robustly."* The design therefore assumes
   **nothing** about how many profiles exist or how accounts are provisioned,
   and must be correct with one profile or ten.
3. **Consequence drawn from (1) and (2):** accounts are a **consumable pool**,
   not durable assets. Robustness comes from needing accounts *less* (HTML routes,
   no probe traffic, persisted pacing) plus instant failover — not from assuming
   any given account survives.

---

## 4. Evidence — verified root causes

Every defect below was confirmed by reading the current source, with the exact
location recorded. No issue in this spec is speculative.

| # | Defect | Location | Consequence |
|---|---|---|---|
| D1 | Proxy hands **any** queued request to **whichever** instance polls next; no identity is carried anywhere in the request. | `src/core/transport.ts:163` `handleNextRequest` (and the 25 s long-poll loop at `:179`) | With more than one extension instance connected, a request intended for account *X* can be executed by account *Y*. |
| D2 | The service worker reports **no identity** on `/ping` or `GET /next-request`, and executes with `credentials:'include'`. | `assets/browser-extension/service-worker.js:407–413`, `:442–474` | The cookies are the **polling** browser's. Wrong-account execution follows directly. |
| D3 | Transport defaults to plain Node `fetch`; **nothing** prevents a browser-captured full cookie jar from being replayed over it. | `src/core/transport.ts:36–57` `getTransportType()`; `src/core/auth.ts:63–75` (jar preference); `src/core/client.ts:85–92` `cookieHeaderFor` | Replaying a browser session from a non-browser TLS fingerprint is the documented way to get `li_at` killed (README). Probable cause of the observed token deaths. |
| D4 | Rate limiting is **per process and in-memory only**: a min gap plus a 2–5 s random delay inside one client closure, behind a serialised chain. | `src/core/client.ts:20` `MIN_REQUEST_GAP_MS`, `:26–29` `randomDelay()`, `:142–146` gap check | Any CLI restart resets the meter; N processes on one account share no budget. `MAX_RETRIES=3` (`:18`) is the only 429/5xx defence. |
| D5 | The bridge is a **foreground long-runner with no supervision or heartbeat**. | `src/commands/extension/listen.ts:87–135`; `src/core/extension-bridge.ts` | If it dies, the service worker's POSTs fail silently and captures stop; only a stale `last_seen` in the registry reveals it (observed: 900-minute gaps). |
| D6 | A rotated `queryId` makes **every** search page return HTTP 400; re-learning is passive (background tab on the extension's own schedule). | `CHANGELOG.md:24–35`; `.tmp/wait-query-id.mjs` (scratch poller) | Stale hash → 400 on all pages; historically exited 0 with *0 employees*. |

**Corollary discovered during this investigation — fingerprints are sessions,
not accounts.** `sessionFingerprint()` hashes `li_at`
(`src/core/sessions.ts:32–34`), and LinkedIn mints a **new `li_at` per login**.
The registry's current count ("12 registered sessions") therefore over-counts
accounts: repeated logins by one person produce many fingerprints, and each login
invalidates that account's previous session. **D7: the registry has no account
identity.** This is addressed by §6.3 and is a prerequisite for meaningful
failover.

---

## 5. Architecture overview

```
   read job
      │
      ▼
┌──────────────────────────┐
│ SessionPool  (failover)  │  picks a healthy account, skipping cooldowns
└────────────┬─────────────┘
             ▼
┌──────────────────────────┐   deny
│ Budget (persisted,       │──────────▶ cooldown account / try next
│ cross-process)           │
└────────────┬─────────────┘  allow
             ▼
┌──────────────────────────┐   jar over fetch
│ Session-integrity guard  │──────────▶ REFUSE (unless opted out)
└────────────┬─────────────┘  ok
             ▼
┌──────────────────────────┐
│ Route selector           │  HTML route (default) │ Voyager (fallback)
└────────────┬─────────────┘
             ▼
   extensionRequest(url, init, { targetFp })
             │
             ▼
┌──────────────────────────┐
│ proxy :8788 routes by fp │  only the matching instance may take it
└────────────┬─────────────┘
             ▼
   Browser instance for that account ──▶ LinkedIn
             │
             ▼
   outcome ──▶ recordSessionHealth(fp, {ok|401|403|429})
             └──▶ budget counters + cooldowns
```

Two invariants hold across the whole pipeline:

- **I1 — One account per request.** A request is bound to exactly one account
  fingerprint, decided *before* it is queued, and the proxy will only release it
  to that account's browser.
- **I2 — Reads are idempotent, writes do not exist.** Because only GET/HTML reads
  are performed, retrying on another account is always safe. The
  `client.ts:285–288` "only idempotent GETs are safe to retry" rule is still
  honoured for any non-GET path that may exist.

---

## 6. Component specifications

### 6.1 Session-integrity guard (fixes D3)

**Rule:** a request may not be sent when the session it carries came from a
**browser** (full cookie jar, i.e. `cookie_header` containing `li_at=`) **and**
the selected transport is not a browser transport (`extension`).

- Checked in one place, immediately before dispatch, so every caller inherits it.
- On violation: throw `AuthError` with an actionable message naming the transport,
  the account fingerprint (never the token) and the remedy —
  *"Session `a1b2…` was captured from a browser. Sending it over the `fetch`
  transport is what invalidates `li_at`. Use `LINKEDIN_HTTP=extension`, or set
  `LINKEDIN_ALLOW_FETCH_SESSION=1` if you accept the risk."*
- Opt-out is **explicit, per-process, and logged** to stderr when used.
- `curl-impersonate` is treated as a browser transport (its whole purpose is a
  Chrome TLS ClientHello) and is allowed, but a one-time stderr note is emitted
  that `extension` is preferred.

**Validation is opportunistic — no probe requests.** There is no `/me` health
call anywhere in this design. Health is written by the outcome of requests the
operator already wanted to make (§6.3).

### 6.2 HTML-first reads (capitalises on the proven route)

The SynovaTech roster was collected from LinkedIn's **server-rendered** search
pages, and the parser already exists. That route:

- needs **no `queryId`** (D6 becomes irrelevant to it),
- consists of ordinary page loads, which look like a human browsing,
- is already proven end-to-end.

**Policy:** reads resolve to a *route* before dispatch, in this order:

| Route | Used for | `queryId` needed |
|---|---|---|
| `html` (**default**) | people search by facet/keyword, company pages, public profiles | no |
| `voyager` (fallback) | only data the HTML genuinely cannot supply | yes |

A read declares its preference (`route: 'html' | 'voyager' | 'auto'`, default
`auto` → `html` first). Selecting `voyager` without a known-good `queryId`
raises an actionable error rather than performing a call destined to 400.

### 6.3 Session health model and account grouping (fixes D7, enables failover)

The registry record (`~/.linkedin-cli/sessions/<fingerprint>.json`) gains:

| Field | Type | Meaning |
|---|---|---|
| `account_key` | `string \| null` | Stable **person** identity (see below); `null` until learned |
| `status` | `'unknown' \| 'ok' \| 'blocked'` | Last known usability |
| `last_ok` | ISO string \| null | Last successful read |
| `last_error_code` | `number \| null` | HTTP code of the most recent failure |
| `cooldown_until` | ISO string \| null | Account is not selectable before this instant |
| `consecutive_failures` | `number` | Drives the cooldown step (`0` on success) |
| `reads_total` | `number` | Lifetime reads attributed to this session |
| `reads_today` / `day_key` | `number` / `YYYY-MM-DD` (UTC) | Daily counter with automatic reset |

All new fields are optional on read, so existing files stay valid
(`saveRegisteredSession` merges rather than replaces, as it already does).

**Account identity.** `account_key` is a stable hash of the person the session
belongs to, learned **once per fingerprint** from the cheapest identity signal
available (`/me`-equivalent already cached in config, or the first successful
authenticated HTML page's own profile link). Consequences:

- many fingerprints (one per login) for one person collapse into **one account**;
- failover picks *accounts*, so it never "switches" between two sessions of the
  same person and calls it redundancy;
- `LINKEDIN_SESSION=<account_key>` becomes valid selector syntax alongside an
  exact fingerprint or a unique fingerprint prefix.

**Cooldown escalation** on 401/403/429 (and on `ChallengeError`):

| Consecutive failures | Cooldown |
|---|---|
| 1 | 5 min |
| 2 | 30 min |
| 3 | 2 h |
| ≥4 | 12 h |

Base step is overridable with `LINKEDIN_COOLDOWN_BASE_MS`. A success resets
`consecutive_failures` to 0 and sets `status: 'ok'`.

**Selection (`selectHealthySession`)** returns, in order of preference: an
`ok` account whose `cooldown_until` has passed → an `unknown` account → `null`.
`SessionPool` (new, `src/core/read-pool.ts`) wraps this with the failover loop:

1. budget admits the account? (§6.4) — else mark and try the next;
2. dispatch on the chosen route;
3. on 401/403/429 → `recordSessionHealth(...)`, cooldown it, **retry the same
   read once** on the next healthy account (safe: reads are idempotent — I2);
4. on success → `recordSessionHealth(ok)`, return.

Failover is capped (`LINKEDIN_FAILOVER_MAX_ATTEMPTS`, default 3) so a fully
blocked pool fails fast and loudly instead of looping.

### 6.4 Persisted, cross-process rate budget (fixes D4)

New file `~/.linkedin-cli/budget.json`, mode `0600`:

```jsonc
{
  "version": 1,
  "accounts": {
    "<account_key>": {
      "day_key": "2026-10-12",
      "reads": 37,              // reads consumed today
      "last_request_at": 1760000000000,   // epoch ms of the last read
      "recent": [1760000000000, ...]      // rolling window for burst control (last 5 min)
    }
  }
}
```

- **Enforcement point:** `SessionPool` calls `budget.admit(accountKey)` before
  dispatch; it returns `allow | deny(reason)`.
- **Cross-process safety:** read-modify-write with an exclusive lock file
  (`budget.lock`, created with `wx`, retried briefly, stolen after a stale
  timeout) and **atomic replace** (write temp + `rename`). This machine is
  single-operator, so this is deliberately simple; correctness beats throughput.
- **Restart-proof:** because the counters live on disk, killing and re-running the
  CLI does **not** reset the meter — the exact hole left by today's in-memory
  `MIN_REQUEST_GAP_MS`.
- **Day rollover:** keyed on UTC `YYYY-MM-DD`; a mismatch resets `reads` and
  `recent` for that account.
- **Burst control:** `recent` is pruned to the last 5 minutes on every admit.

### 6.5 Fingerprint-routed extension proxy (fixes D1, D2)

**Extension side** (`assets/browser-extension/service-worker.js`):

- Compute the session fingerprint with the **same algorithm** as
  `src/core/sessions.ts:32–34` — `SHA-1` of `li_at`, hex, first 16 chars —
  using `crypto.subtle.digest` (available in an MV3 service worker). Computed on
  every capture, cached in `chrome.storage.local.sessionFp`.
- Send it as a query parameter on both poll calls:
  `POST ${PROXY_URL}/ping?fp=<fp>` and `GET ${PROXY_URL}/next-request?fp=<fp>`.
- If no session is present (`fp` unknown) the parameter is omitted, and the
  instance is treated as *unnamed* (eligible only for untargeted requests).

**Proxy side** (`src/core/transport.ts`):

- `handlePing` / `handleNextRequest` record `fp` → `lastSeen` in a new
  `connectedInstances: Map<string, number>` (and a single `unnamedLastSeen`).
- `PendingRequest` gains `targetFp?: string`, taken from the new optional third
  argument of `extensionRequest(url, init, { targetFp })`.
- **Routing rule (I1):** a poll with `fp = F` may only take a pending request
  whose `targetFp` is `F`, **or** whose `targetFp` is unset (legacy/untargeted).
  A poll without `fp` may only take requests with no `targetFp`.
- **Timeout with a reason:** if a targeted request is not picked up within
  `LINKEDIN_EXTENSION_TARGET_WAIT_MS` (default 8 s), it is rejected with
  *"No connected browser is signed in as account `<account_key>` (`<fp>`);
  start that profile's browser or omit LINKEDIN_SESSION."* — never a silent
  wrong-account call.
- **Back-compat:** with no `LINKEDIN_SESSION` / no target, behaviour is exactly
  today's, which keeps all existing tests and single-account usage untouched.

### 6.6 Supervised bridge (fixes D5)

- `extension listen` writes a heartbeat file `~/.linkedin-cli/bridge.json`
  (`0600`): `{ pid, port, started_at, last_capture_at, captures, version }`,
  updated on every capture and on a 30 s timer. Removed on clean shutdown.
- `extension status` reads it and reports **capture age** plus a verdict —
  `live` (< 3 min), `idle` (< 15 min), `stale` (≥ 15 min or pid dead) — and
  exits non-zero on `stale` so scripts can act on it.
- **Watchdog:** `extension listen --supervise` (and/or a documented
  `linkedin-bridge-watchdog` entry point) spawns the listener as a child and
  restarts it when the heartbeat goes stale or the child exits, with a capped
  backoff. Dependency-free (`node:child_process` + the heartbeat file).
- Detection is also surfaced where it matters: a read that fails because no
  extension is connected now says whether the bridge is *down* or merely
  *disconnected*, by consulting the heartbeat.

### 6.7 `queryId` self-heal and loud failure (fixes D6)

- **On-demand re-learn.** `ProxyRequest` gains an optional
  `command: 'relearn-queryid'` variant. The service worker, on receiving it,
  performs the existing background-tab learn immediately and posts the result
  back through the normal `/response/<id>` channel. The CLI exposes it as
  `linkedin extension refresh-query-id [--fp <fp>]` and calls it automatically
  when the `voyager` route reports a stale hash.
- **Loud failure.** A 400 on the search route classifies as
  `StaleQueryIdError` (distinct from a generic API error) whose message names the
  remedy. The command exits **non-zero**; it must never exit 0 having collected
  zero results. This extends the fix noted in `CHANGELOG.md:31–35` to all routes.
- **HTML route is immune,** so the default read path keeps working while a
  `queryId` is stale — the self-heal is a convenience for the fallback route, not
  a single point of failure.

---

## 7. Interfaces and configuration surface

### 7.1 New / changed public surface

| Surface | Change |
|---|---|
| `linkedin extension status` | adds `bridge: { capture_age_s, verdict, pid, port }`; exit non-zero on `stale` |
| `linkedin extension listen` | new `--supervise`; writes `bridge.json` |
| `linkedin extension refresh-query-id` | **new** subcommand (`--fp <fp>` optional) |
| `linkedin sessions` (if present) / registry listing | groups by `account_key`, showing health, cooldown and today's reads |
| `extension_listen` / `extension_status` MCP tools | new optional fields only (additive, no breaking change) |
| `LINKEDIN_SESSION` | now also accepts an `account_key` (exact fingerprint and unique prefix keep working) |

### 7.2 New environment variables

| Variable | Default | Purpose |
|---|---|---|
| `LINKEDIN_ALLOW_FETCH_SESSION` | unset (`0`) | Explicit opt-out of the §6.1 guard |
| `LINKEDIN_READ_DAILY_CAP` | `300` | Max reads per account per UTC day |
| `LINKEDIN_READ_MIN_GAP_MS` | `3000` | Minimum spacing between reads for one account |
| `LINKEDIN_READ_BURST_CAP` | `20` | Max reads per account per 5-minute window |
| `LINKEDIN_COOLDOWN_BASE_MS` | `300000` | Base cooldown step (5 min) for §6.3 escalation |
| `LINKEDIN_FAILOVER_MAX_ATTEMPTS` | `3` | Account switches per read before failing |
| `LINKEDIN_EXTENSION_TARGET_WAIT_MS` | `8000` | How long a targeted request waits for its instance |
| `LINKEDIN_ROUTE` | `auto` | Force `html`, `voyager` or `auto` |

All are read through the existing env pattern and are covered by tests via
`process.env` mutation, matching `tests/extension-proxy.test.ts:18–20`.

## 8. Rate-limit policy (defaults, all overridable)

The policy is deliberately conservative because the accounts are throwaways.

| Class | Route | Daily cap | Min gap | Burst (5 min) | Notes |
|---|---|---|---|---|---|
| People search page | `html` | 300 | 3 s | 20 | The workhorse; page loads look human |
| Company page | `html` | shares the 300/day pool above | 3 s | 20 | Same account budget, separate class for reporting |
| Voyager read | `voyager` | 150 | 5 s | 10 | Halved, since it is the abusable route |

Cross-account behaviour: caps are **per account**, so N healthy accounts give N
independent budgets — but see risk **R3**: spreading the *same* targets across
accounts is bounded deliberately (each account advances a distinct slice of the
work, and the pool never issues the same URL from two accounts inside the burst
window).

## 9. Failure modes and handling

| Condition | Detected by | Behaviour |
|---|---|---|
| 401 / 403 on a read | HTTP status | `status: 'blocked'`, cooldown per §6.3, **failover** to next account, retry once |
| 429 | HTTP status (+ `retry-after` honoured, extending `client.ts:242`) | Long cooldown, failover |
| CAPTCHA / challenge page | existing `ChallengeError` path | Account cooldown, failover, **no retry loop** on that account |
| Stale `queryId` (400 on search) | `StaleQueryIdError` classification | Auto-invoke `refresh-query-id`, retry once; else fail loudly (non-zero) |
| No extension connected | `isExtensionConnected()` false | Error distinguishes *bridge down* (heartbeat stale) from *bridge up but no instance* |
| Targeted instance absent | §6.5 wait timeout | Named error; no request is executed by another account |
| Jar over non-browser transport | §6.1 guard | Refuse with remedy, before any network call |
| Budget exhausted | §6.4 `admit` | Deny this account, try the next; if all denied, report the earliest reset |
| Bridge process died | `bridge.json` stale | `status` exits non-zero; watchdog restarts it |
| All accounts blocked | pool exhausted | Fail fast with the cooldown table (when each returns) — never loop |

---

## 10. Out of scope

Explicitly **not** built, by agreement:

- **Any write action** — follows/unfollows, connection requests (send/accept/
  reject/withdraw/remove), reactions, comments, shares/reposts, messages, post
  creation or editing, profile edits. No rate policy, no dry-run planner, no
  per-account write caps for these.
- Account-creation or onboarding automation (R1).
- Proxy/VPN rotation, device-fingerprint spoofing, or any anti-detection evasion.
- Cloud/LLM-assisted enrichment of the collected data.

## 11. Risks and mitigations

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| **R1** | Throwaway accounts are restricted by LinkedIn rapidly; the pool may be empty most of the time. | Reads stall | Failover + loud "all accounts blocked" reporting; HTML-first design needs accounts *less*; the operator is told plainly that account durability is the limiting factor, not the code. |
| **R2** | The two candidate causes of the observed token deaths (D3 jar-over-fetch vs. LinkedIn-side invalidation) are not yet separated. | We may fix the wrong thing | §13 Phase 0 is a **controlled A/B experiment** that settles it before any behaviour change ships. |
| **R3** | Distributing the same targets across accounts creates a correlated signal across the whole pool. | Whole-pool block | Each account advances a distinct work slice; no URL is issued by two accounts within the burst window; per-account caps stay conservative. |
| **R4** | Cross-process file locking on Windows (`budget.lock`) can misbehave on abrupt termination. | A stuck lock could deny reads | Stale-lock steal after a timeout, atomic replace writes, and a `budget.json` corruption fallback that resets to a safe state rather than throwing. |
| **R5** | Adding fields to registry/bridge files could break older readers. | Regression | All new fields optional; merge-not-replace preserved (`sessions.ts:59–73`); `version` fields added for future migrations. |
| **R6** | Scaling collection of EU/UK personal data raises GDPR exposure. | Legal, not technical | Collection stays local; output stays gitignored; the design deliberately does **not** add enrichment or export features. |

## 12. Test plan

Extending the existing vitest suite (356 tests currently green). New/updated
coverage, mapped to the defects:

| Test file | Covers | Key assertions |
|---|---|---|
| `tests/extension-proxy.test.ts` (extend) | D1, D2 | a poll with `fp=X` takes a request targeted at `X`; a poll with `fp=Y` does **not**; an untargeted request is still taken by anyone (back-compat); a targeted request whose instance never polls rejects with the named error |
| `tests/session-integrity.test.ts` (new) | D3 | jar + `fetch` ⇒ `AuthError`; jar + `extension` ⇒ allowed; `LINKEDIN_ALLOW_FETCH_SESSION=1` ⇒ allowed and warns once |
| `tests/session-health.test.ts` (new) | D7, failover | health fields merge without clobbering; cooldowns escalate 5 m → 30 m → 2 h → 12 h and reset on success; `account_key` groups several fingerprints into one account; `selectHealthySession` skips cooldowns and prefers `ok` over `unknown` |
| `tests/budget.test.ts` (new) | D4 | counters persist across "process" re-reads; day rollover resets; burst window prunes; deny returns the earliest reset; corrupt file degrades safely |
| `tests/read-pool.test.ts` (new) | failover | 401 ⇒ cooldown + retry on the next account; retry cap respected; all-blocked fails fast with the cooldown table |
| `tests/bridge-heartbeat.test.ts` (new) | D5 | heartbeat written/updated; verdict thresholds (`live`/`idle`/`stale`); `status` exits non-zero when stale |
| `tests/query-id.test.ts` (new/extend) | D6 | 400 on the search route ⇒ `StaleQueryIdError` + non-zero exit; `refresh-query-id` round-trips a `command` request through the proxy |

Conventions followed: isolated proxy port (`9788`) and env mutation for
`PROXY_PORT`, direct calls to exported functions where `process.env` sharing
between vitest threads could reroute a transport (`tests/extension-proxy.test.ts:8–21`).

**Definition of done:** all of the above green, the pre-existing 356 still green,
`typecheck`, `lint` and `build` clean.

## 13. Phased delivery

| Phase | Content | Fixes | Why this order |
|---|---|---|---|
| **0. Experiment** | Controlled A/B: one browser-captured session used only via `extension` vs. the same session plus a single `fetch` call. Record whether `li_at` survives. | R2 | Settles whether D3 is real before we invest in guarding it. **Blocks Phase 1's framing, not its implementation.** |
| **1. Stop the bleeding** | §6.1 session-integrity guard + §6.3 health fields & account grouping + §6.6 bridge heartbeat/supervision. | D3, D5, D7 | Highest harm reduction per unit of risk; no routing change yet. |
| **2. Correct accounting** | §6.4 persisted budget + §6.2 HTML-first route selection. | D4 | Makes pacing real and cuts API-surface exposure. |
| **3. Correct routing** | §6.5 fingerprint-routed proxy + SW `fp` tagging. | D1, D2 | Delivers true multi-account, but only meaningful once phases 1–2 are in place. |
| **4. Self-heal** | §6.7 on-demand `queryId` re-learn + `StaleQueryIdError`. | D6 | Convenience for the fallback route; least urgent because HTML-first is immune. |

Phase 1 is independently shippable and is the recommended first merge.

## 14. Decisions taken (no open questions)

Recorded so later edits cannot silently re-open them:

1. **Reads only.** No write machinery exists in this design. *(User decision.)*
2. **Assume nothing about browser topology.** Works with one profile or many;
   degrades to today's behaviour. *(User decision: "just make whatever works robustly".)*
3. **HTML-first**, Voyager as fallback — because the HTML route is `queryId`-free
   and human-looking. *(Design decision.)*
4. **No health probes.** Health comes from real traffic, never a dedicated `/me`.
   *(Design decision — directly addresses the observed token burn.)*
5. **Fingerprint routing ships even if the operator never runs two profiles**,
   because it is opt-in via `LINKEDIN_SESSION` and back-compatible. *(Design
   decision.)*
6. **Guard is default-deny with an explicit opt-out**, not a warning.
   *(Design decision — a warning would have been ignored, as it was today.)*




