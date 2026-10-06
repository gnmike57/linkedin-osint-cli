# linkedin-osint-cli

[![CI](https://github.com/gnmike57/linkedin-osint-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/gnmike57/linkedin-osint-cli/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Full LinkedIn platform management from your terminal. 43 platform commands (profiles, posts, messaging, connections, search, feed, engagement) **plus an OSINT suite**: company discovery, employee scraping, username generation, role classification, org charts, and email deanonymization — powered by cookie session auth.

Works as a **CLI** and an **MCP server** (for Claude Code, Cursor, Windsurf, and other AI agents). All 56 tools (43 platform + 13 OSINT) are exposed over MCP automatically, plus an interactive console for humans.

## OSINT Suite

The `osint` command group ports the best of three legacy Python toolkits
(`legacy/python/`) into the TypeScript engine — API-native, no browser needed:

| Command | What it does | Ported from |
|---------|--------------|-------------|
| `osint discover` | Discover companies by region (`--geo`), keyword, industry | osint_discover.py |
| `osint employees` | Scrape a company's employees (50/page; `--keywords` / `--geoblast` outer loops bypass the 1,000-result cap; detects the commercial-search UPSELL_LIMIT) | linkedin2username |
| `osint names` | Username/email permutations (`flast`, `f.last`, `firstl`, `first.last`, `first`, `lastf`) from a name or employees file | linkedin2username NameMutator |
| `osint classify` | Classify titles into 12 hierarchy levels x 20 divisions (rules engine learned from ~30K profiles) | osint_classify_rules.py |
| `osint ai-score` / `osint ai-classify` | Groq LLM relevance scoring / batch classification (graceful no-op without `GROQ_API_KEY`) | osint_classify_ai.py |
| `osint orgchart` | Build hierarchical org chart JSON (divisions x levels) | osint_build_orgchart.py |
| `osint matrix` | Standalone HTML matrix org chart (search, expand/collapse, avatars) | osint_generate_html.py |
| `osint stats` / `osint scan` | Classification health + suggested `title_overrides` for the rules JSON | osint_stats.py / osint_scan.py |
| `osint deep-dive` | One profile's about/experience/education/skills via the profileView endpoint, optional AI deep classification | osint_scrape_profiles.py |
| `osint email-lookup` | Email → LinkedIn profile via Outlook/Delve (needs a Microsoft token) | outlook_http_client.py |
| `osint funnel` | The full pipeline: discover → employees → orgchart → matrix, with resume | osint_funnel.py |

Offline-safe (no cookies needed): `classify --title`, `names --name`, `matrix`, `stats`, `scan`.
Everything else uses the same cookie session as the platform commands.

```bash
# Discover cybersecurity companies in the USA
linkedin osint discover --geo USA --keyword cybersecurity --limit 10

# Scrape their employees (and generate username lists for a domain)
linkedin osint employees acme-corp --keywords "sales,engineering" --domain acme.com

# Classify one title offline
linkedin osint classify --title "Senior Cyber Security Manager"

# Full funnel: discover -> employees -> org chart -> HTML matrix
linkedin osint funnel --geo USA --keyword fintech --limit 5

# Explore the result interactively
# (open assets/org_chart_viewer.html and load output/org_chart_*.json)
```

The interactive org chart viewer ships at `assets/org_chart_viewer.html` (tree + matrix modes, demo data in `assets/demo_org_chart.json`).


## Install

From source (this repo is not published to npm):

```bash
git clone https://github.com/gnmike57/linkedin-osint-cli.git
cd linkedin-osint-cli
npm ci
npm run build
npm link          # puts the `linkedin` command on your PATH

linkedin --help
```

`@inquirer/prompts` is an **optional** dependency: the interactive console uses
it when present and otherwise falls back to a built-in `node:readline`
implementation, so a restricted registry or a partial install never blocks you.
Force either path with `LINKEDIN_PROMPTS=inquirer` (require it, fail loudly) or
`LINKEDIN_PROMPTS=fallback` (always use the built-in console).

> **Note:** The npm package is `@bcharleson/linkedincli` but the CLI command is just **`linkedin`**.

## Local harness only

A **live LinkedIn session** (cookies, Chrome cookie import, Voyager API calls) must run on a **local harness only** — your own computer, such as a laptop or Mac mini.

Do **not** run a live session from Grok Bot, a cloud VM, or any remote runner. Safe use from those environments is limited to:

- installing the `linkedin` CLI binary, or
- calling an MCP server that is already running on the local harness

Cookies and Voyager calls never leave the local machine. Do not put `li_at` / `JSESSIONID` in a cloud or Grok Bot environment.

The opt-in `--from-chrome` and `LINKEDIN_HTTP=curl-impersonate` paths are **local-only**: they read a Chrome profile and/or `curl_chrome123` on that same machine.

## Sessions keep getting killed?

Default Node `fetch` has a TLS/JA3 fingerprint that is not Chrome. LinkedIn often detects that and **invalidates `li_at` on the first Voyager call** (issue [#1](https://github.com/bcharleson/linkedincli/issues/1)). Manual `li_at` + `JSESSIONID` paste still works for some accounts, but is the fragile path.

Two **opt-in, local-only** workarounds (default transport remains Node `fetch`):

1. **`LINKEDIN_HTTP=curl-impersonate`** — on the local harness, shell out to `curl_chrome123` so the TLS ClientHello matches Chrome.
2. **`--from-chrome` / `LINKEDIN_FROM_CHROME=1`** — on the local harness, read the full `linkedin.com` cookie jar from a local Chrome profile (not just the two auth tokens).

Use them together on the local machine when possible.

### Diagnostics

Set `LINKEDIN_DEBUG=1` to trace the HTTP transport on stderr (method, URL, status
and `Location` for each request, including redirects). It never logs cookies or
request bodies.

```bash
LINKEDIN_DEBUG=1 linkedin status --verify
```

### Install curl-impersonate (local harness)

Install `curl_chrome123` on the same local machine that holds the LinkedIn session. The transport looks for it on `PATH` (override with `LINKEDIN_CURL_IMPERSONATE_BIN`).

```bash
# Nix
nix profile install nixpkgs#curl-impersonate-chrome

# Homebrew
brew install curl-impersonate

# Confirm the binary exists
curl_chrome123 --version
export LINKEDIN_HTTP=curl-impersonate
```

If the binary is named differently on your platform, point at it:

```bash
export LINKEDIN_CURL_IMPERSONATE_BIN=/usr/local/bin/curl_chrome123
export LINKEDIN_HTTP=curl-impersonate
```

## Quick Start

### Interactive console

Run `linkedin` with no arguments (or `linkedin menu` from anywhere) to open the
interactive console: a searchable command palette over every CLI command, a
category browser, guided prompts for each argument/option, and the equivalent
scriptable command line printed before each run so you can graduate to
scripts. Session actions (`login`, `status --verify`, `logout`) are built in.
On a pipe or CI (no TTY), bare `linkedin` prints plain help instead.

The palette uses `@inquirer/prompts` when it is installed. That package is an
**optional dependency**: if your registry blocks it (or the install is broken),
the console silently falls back to a built-in zero-dependency
`node:readline` implementation with the same behaviour — so the console always
launches. Both paths are exercised by `npm run smoke:menu` (build first), which
drives a full session through the palette and asserts the selected command
actually runs.

### Option A — Login via browser (recommended)

LinkedIn has no consumer OAuth2 for personal sessions, so the CLI captures your
browser session instead. `--browser` opens `linkedin.com/login` in your default
browser, then polls the local Chromium cookie store until the session appears
(up to 3 minutes) and saves it:

```bash
linkedin login --browser
```

If you use Chrome/Edge on Windows, macOS, or Linux with the Default profile,
that's the whole flow — sign in in the browser window and the CLI picks it up
automatically. If your browser encrypts its cookies so other programs cannot
read them (`v11`/`v20` app-bound encryption, the default on current
Chrome/Edge on Windows), the CLI opens a dedicated login window instead and
captures the session live over the DevTools Protocol — sign in there and the
cookies are captured automatically; the temporary browser profile is deleted
afterwards. If no readable Chromium binary exists (Firefox/Safari users,
custom setups), the command falls back to the manual paste prompt in Option C.

The interactive shell (`linkedin` with no args) routes `login` here, and the
Session menu lists it first as **login via browser (recommended)**.

### Option B — Read cookies from Chrome/Edge (local only)

If you are already logged into LinkedIn in Chrome or Edge **on this machine**,
the CLI can decrypt cookies from the local profile. This sends the full cookie
jar (not just `li_at` + `JSESSIONID`), which matches a real browser more
closely. Local-only — do not point this at a remote Chrome profile or run it
from a cloud agent.

```bash
# macOS will prompt to unlock Keychain ("Chrome Safe Storage") the first time.
# macOS/Linux use the `sqlite3` CLI; Windows uses Node's built-in SQLite.
linkedin --from-chrome profile me --pretty

# Or persist the two auth tokens into ~/.linkedin-cli/config.json
linkedin login --from-chrome

# Non-default Chrome profile
linkedin --from-chrome --chrome-profile "Profile 1" status --verify
```

Environment equivalents: `LINKEDIN_FROM_CHROME=1`, `LINKEDIN_CHROME_PROFILE=Default`. Optional: `LINKEDIN_CHROME_USER_DATA_DIR` to point at a custom user-data directory (Chrome/Chromium).

On Windows the master key is unlocked with DPAPI (via PowerShell) from the
browser's `Local State`; `v10` cookies decrypt with AES-256-GCM. `v11`/`v20`
app-bound encrypted cookies (Chrome 127+ app-bound rollout) cannot be decrypted
from another process and are skipped — `linkedin login --browser` detects this
and captures the session over the DevTools Protocol instead (see Option A).

Cookie values are never printed to stdout/stderr.

### Option C — Paste cookies manually

Open LinkedIn in your browser → DevTools (`F12`) → Application → Cookies → `linkedin.com`

Copy these two values:
- **`li_at`** — your session token (long string starting with `AQED...`)
- **`JSESSIONID`** — your session ID (starts with `ajax:`)

```bash
linkedin login
# Paste your li_at and JSESSIONID when prompted
```

Or non-interactively:

```bash
linkedin login --li-at "AQEDxxxxxxx" --jsessionid "ajax:1234567890"
```

Manual paste + default Node fetch may still get the session killed. Prefer Option A plus `LINKEDIN_HTTP=curl-impersonate` on the local harness.

### Use it

```bash
# View your profile
linkedin profile me --pretty

# Create a post
linkedin posts create --text "Hello LinkedIn! Posted from my terminal."

# Search for people
linkedin search people --keywords "software engineer" --network F --pretty

# Check your messages
linkedin messaging conversations --pretty

# React to a post
linkedin engage react 7123456789 --type LIKE
```

## All Commands

### Profile (9 commands)

```bash
linkedin profile me                           # Your own profile
linkedin profile view <public-id>             # View any profile
linkedin profile contact-info <public-id>     # Email, phone, websites
linkedin profile skills <public-id>           # List skills
linkedin profile network <public-id>          # Connections, followers, distance
linkedin profile badges <public-id>           # Premium, influencer, etc.
linkedin profile privacy <public-id>          # Privacy settings
linkedin profile posts <urn-id>               # Recent posts by a user
linkedin profile disconnect <public-id>       # Remove a connection
```

### Posts (3 commands)

```bash
linkedin posts create --text "My post"                     # Text post
linkedin posts create --text "With image" --image ./pic.jpg  # Image post
linkedin posts create --text "Inner circle" --visibility connections
linkedin posts edit <share-urn> --text "Updated text"      # Edit a post
linkedin posts delete <share-urn>                          # Delete a post
```

### Feed (3 commands)

```bash
linkedin feed view                            # Your feed (chronological)
linkedin feed view --count 50                 # More items
linkedin feed user <profile-id>               # Someone's activity
linkedin feed company <company-name>          # Company updates
```

### Engagement (5 commands)

```bash
linkedin engage react <post-urn> --type LIKE          # Like
linkedin engage react <post-urn> --type PRAISE        # Celebrate
linkedin engage react <post-urn> --type EMPATHY       # Love
linkedin engage react <post-urn> --type INTEREST      # Insightful
linkedin engage react <post-urn> --type ENTERTAINMENT # Funny
linkedin engage react <post-urn> --type APPRECIATION  # Support

linkedin engage comment <post-urn> --text "Great post!"
linkedin engage comments-list <post-urn>
linkedin engage reactions <post-urn>
linkedin engage share <share-urn> --text "Worth reading"
```

### Connections (7 commands)

```bash
linkedin connections send <profile-urn>                     # Send request
linkedin connections send <profile-urn> -m "Let's connect!" # With message
linkedin connections received                               # Pending received
linkedin connections sent                                   # Pending sent
linkedin connections accept <id> --secret <secret>          # Accept
linkedin connections reject <id> --secret <secret>          # Reject
linkedin connections withdraw <id>                          # Withdraw sent
linkedin connections remove <public-id>                     # Unfriend
```

### Messaging (6 commands)

```bash
linkedin messaging conversations                        # All conversations
linkedin messaging conversation-with <profile-urn>      # With specific person
linkedin messaging messages <conversation-id>           # Read messages
linkedin messaging send <conversation-id> -t "Hello!"   # Reply
linkedin messaging send-new -r <urn1>,<urn2> -t "Hi!"   # New conversation
linkedin messaging mark-read <conversation-id>          # Mark as read
```

### Search (4 commands)

```bash
linkedin search people --keywords "CTO" --network F         # 1st connections
linkedin search people --keywords "engineer" --company 1035 # At a company
linkedin search people --title "VP Sales" --geo 103644278   # By region
linkedin search companies --keywords "AI startups"
linkedin search jobs --keywords "engineer" --remote --experience 4
# search posts is unavailable (LinkedIn CONTENT SRP). Use profile posts for a known author:
linkedin profile posts ACoAABxxxxxxx --limit 20
```

### Companies (3 commands)

```bash
linkedin companies view <company-name>                  # Company info
linkedin companies follow <following-state-urn>         # Follow
linkedin companies unfollow <entity-urn>                # Unfollow
```

### Jobs (2 commands)

```bash
linkedin jobs view <job-id>                  # Job details
linkedin jobs skills <job-id>                # Skill match insights
```

### Analytics (1 command)

```bash
linkedin analytics profile-views             # Who viewed your profile
```

## Global Options

Every command supports these flags:

| Flag | Description |
|------|-------------|
| `--li-at <cookie>` | Override li_at cookie |
| `--jsessionid <cookie>` | Override JSESSIONID cookie |
| `--from-chrome` | Read cookies from a Chrome/Edge profile on this local machine |
| `--chrome-profile <name>` | Chrome profile directory (default: `Default`) |
| `--output pretty` | Pretty-printed JSON |
| `--pretty` | Shorthand for `--output pretty` |
| `--quiet` | No output, exit codes only |
| `--fields <list>` | Comma-separated fields to include |

## Environment Variables

```bash
export LINKEDIN_LI_AT="your_li_at_cookie"
export LINKEDIN_JSESSIONID="your_jsessionid_cookie"

# Opt-in: avoid Node fetch TLS fingerprint (requires curl_chrome123)
export LINKEDIN_HTTP=curl-impersonate
# export LINKEDIN_CURL_IMPERSONATE_BIN=/path/to/curl_chrome123

# Opt-in: read the full LinkedIn cookie jar from Chrome
export LINKEDIN_FROM_CHROME=1
# export LINKEDIN_CHROME_PROFILE="Profile 1"
```

Auth resolution order: `--from-chrome` / `LINKEDIN_FROM_CHROME` → `--li-at`/`--jsessionid` flags → env vars → `~/.linkedin-cli/config.json`

`linkedin status --verify` now classifies LinkedIn 3xx login/challenge redirects as `session_valid: false` with an auth message instead of a generic network error.

## MCP Server (AI Agents)

All 56 tools (43 platform + 13 OSINT) are available as MCP tools. The MCP process that talks to LinkedIn must run on the **local harness**. Cloud agents and Grok Bot may install the CLI binary or call this local MCP — they must not hold cookies or originate Voyager calls.

### Local Claude Code / Cursor / Windsurf

Add to the MCP config **on the local machine**:

```json
{
  "mcpServers": {
    "linkedin": {
      "command": "linkedin",
      "args": ["mcp"],
      "env": {
        "LINKEDIN_LI_AT": "your_li_at_cookie",
        "LINKEDIN_JSESSIONID": "your_jsessionid_cookie",
        "LINKEDIN_HTTP": "curl-impersonate"
      }
    }
  }
}
```

Or point straight at the standalone MCP entry (`dist/mcp.js`, no CLI wrapper):

```json
{
  "mcpServers": {
    "linkedin": {
      "command": "node",
      "args": ["/absolute/path/to/linkedin-osint-cli/dist/mcp.js"]
    }
  }
}
```

Then a **local** AI agent can manage LinkedIn through that MCP process. Remote/cloud agents should call this local server rather than starting their own session.

## Cookie Expiration

LinkedIn `li_at` cookies expire periodically (usually every few weeks). They can also be invalidated immediately when the client TLS fingerprint does not look like Chrome. When your session expires:

```bash
linkedin status --verify    # Check if session is valid
linkedin login --from-chrome
# or: linkedin login
```

## Search posts limitation

`linkedin search posts` is **not available**. LinkedIn's CONTENT resultType on `voyagerSearchDashClusters.b0928897b71bd00a5a7291755dcd64f0` still returns HTTP 200 but `included[]` is only a `FeedbackCard` (issue [#2](https://github.com/bcharleson/linkedincli/issues/2)). People and company search on the same queryId still work. A replacement content-search `queryId` has not been verified from public/in-repo sources, so this CLI does not invent one.

For posts **by a specific member**, use `profile posts` (`identity/profileUpdatesV2`):

```bash
linkedin profile posts <urn-id> --limit 20
```

## Development

```bash
npm run typecheck      # tsc --noEmit
npm test               # vitest
npm run build          # tsup -> dist/ (index.js + mcp.js)
npm run smoke:menu     # end-to-end interactive console (run build first)
npm run smoke:mcp      # MCP handshake + tools/list (run build first)
```

The smoke scripts drive the real `dist/` artifacts, not mocks: `smoke:menu`
runs two scripted console sessions (search path and category-browse path) and
asserts the selected command actually executes, that no prompt hangs on piped
input, and that the process exits cleanly; `smoke:mcp` boots the server,
performs the initialize handshake and verifies every tool is exposed with a
schema. Both force `LINKEDIN_PROMPTS=fallback` so scripted input behaves the
same on every machine. CI runs typecheck + tests + build + both smoke suites
on Node 18, 20 and 22 (plus Windows on Node 20).


## Disclaimer

This tool uses LinkedIn's internal Voyager API via cookie session authentication. It is not affiliated with or endorsed by LinkedIn. Use responsibly and in compliance with LinkedIn's terms of service. The authors are not responsible for any account restrictions that may result from automated usage.

## License

MIT
