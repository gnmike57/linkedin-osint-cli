# linkedin-cli

CLI and MCP server for LinkedIn — full platform management via cookie session auth (Voyager API).

## Architecture

**Single source of truth**: Every LinkedIn API endpoint is one `CommandDefinition` object that powers both the CLI (Commander.js) and MCP server simultaneously.

```
src/
├── index.ts              # CLI entry (Commander.js)
├── mcp.ts                # MCP server entry (stdio)
├── core/
│   ├── types.ts          # CommandDefinition, LinkedInClient interfaces
│   ├── client.ts         # HTTP client (Voyager API, cookie auth, retry)
│   ├── transport.ts      # Pluggable transport (fetch / curl-impersonate)
│   ├── redirects.ts      # 3xx classification (auth/challenge walls)
│   ├── auth.ts           # resolveAuth() — chrome > flags > env > config file
│   ├── chrome-cookies.ts # Chrome cookie-store decryption (local only)
│   ├── config.ts         # ~/.linkedin-cli/config.json manager
│   ├── errors.ts         # Typed error classes
│   ├── handler.ts        # executeCommand() — builds requests from definitions
│   └── output.ts         # JSON formatting, --fields, --quiet
├── commands/
│   ├── index.ts          # allCommands registry + registerAllCommands() + lazy client
│   ├── auth/login.ts     # login, logout, status (special commands)
│   ├── mcp/index.ts      # MCP start command
│   ├── profile/view.ts   # 9 profile commands
│   ├── posts/create.ts   # 3 post commands (create, edit, delete)
│   ├── feed/feed.ts      # 3 feed commands (view, user, company)
│   ├── engage/engage.ts  # 5 engagement commands (react, comment, share)
│   ├── connections/      # 7 connection commands
│   ├── messaging/        # 6 messaging commands
│   ├── search/search.ts  # 4 search commands (people, companies, jobs, posts)
│   ├── companies/        # 3 company commands
│   ├── jobs/jobs.ts      # 2 job commands
│   ├── analytics/        # 1 analytics command
│   └── osint/            # 13 OSINT commands (see below)
│       ├── index.ts      # osintCommands registry
│       ├── util.ts       # file output helpers + company-ID resolution
│       ├── discover.ts  employees.ts  names.ts  classify.ts  ai.ts
│       ├── orgchart.ts  matrix.ts  stats.ts  scan.ts
│       ├── email-lookup.ts  deep-dive.ts  funnel.ts
│       └── (handlers orchestrate the src/osint logic modules)
├── osint/                # Pure-logic OSINT layer (unit-testable)
│   ├── names.ts          # NameMutator port (username permutations)
│   ├── classify.ts       # Rules engine port (data-driven)
│   ├── data/classification_rules.json  # ~30K-profile rules (shipped)
│   ├── prompts.ts        # Inlined Groq prompts (source: prompts/*.md)
│   ├── prompts/*.md      # Canonical prompt markdown
│   ├── ai-client.ts      # Groq chat + score/classify/deep-classify
│   ├── employees-query.ts # Voyager GraphQL people-search builder/parser
│   ├── geo-codes.ts  industries.ts  csv.ts
│   ├── orgchart.ts       # People loaders + hierarchical builder
│   ├── matrix.ts         # HTML matrix generator
│   ├── delve.ts          # Outlook/Delve email lookup
│   └── stats.ts          # Classification stats + override suggestions
└── mcp/
    └── server.ts         # MCP server registration loop
```

Plus `assets/org_chart_viewer.html` (interactive viewer) and
`legacy/python/` (the three original projects, archived intact).

## Authentication

Cookie-based auth via LinkedIn's Voyager API. Two cookies required:
- `li_at` — main session token
- `JSESSIONID` — session ID (used for CSRF token)

**Resolution order**: `--li-at`/`--jsessionid` flags → `LINKEDIN_LI_AT`/`LINKEDIN_JSESSIONID` env vars → `~/.linkedin-cli/config.json`

## Tech Stack

- TypeScript (ESM, strict), Commander.js, Zod v4, MCP SDK
- tsup for bundling (two entry points: CLI + MCP)
- Node.js 18+

## Adding a New Command

1. Add a `CommandDefinition` to the appropriate `src/commands/{group}/` file
2. Export it from the group's command array
3. The command is auto-registered in both CLI and MCP — no other changes needed

## OSINT Modules

The `osint` command group (13 commands) orchestrates pure-logic modules in
`src/osint/`:

- **names.ts** — NameMutator (username/email permutations), ported 1:1 from
  linkedin2username and verified against its pytest suite.
- **classify.ts** — data-driven role classifier; ALL patterns/keywords/overrides
  live in `src/osint/data/classification_rules.json` (learned from ~30K real
  profiles). Edit the JSON to tune classification; run `osint scan` to get
  suggested overrides.
- **ai-client.ts** — optional Groq enhancement (llama-3.3-70b): company scoring,
  title classification, and full-profile deep classification with
  confidence-gated promotion (0.8 title-only, 0.7 deep). Never required.
- **employees-query.ts** — Voyager GraphQL people search
  (`voyagerSearchDashClusters.66adc6056cf4138949ca5dcb31bb1749`, 50/page);
  `--query-id` overrides it if LinkedIn rotates it.
- **delve.ts** — Outlook/Delve email→profile deanonymization
  (`LINKEDIN_MS_TOKEN` or `--token-file`); circuit-breaker batch semantics.
- **orgchart.ts / matrix.ts / stats.ts** — org chart builder, standalone HTML
  generator, and classification analytics.

Offline commands (no cookies needed): `classify --title`, `names --name`,
`matrix`, `stats`, `scan`. The CLI uses a lazy client, so auth errors surface
on the first real HTTP request instead of at startup.

## API Base URL

All Voyager API calls go to `https://www.linkedin.com/voyager/api`. The client handles:
- Cookie/CSRF headers automatically
- Retry with exponential backoff (429, 5xx)
- Challenge detection (CAPTCHA/verification pages)
- Minimum 1s gap between requests

## Important Conventions

- All output is JSON to stdout (compact by default, `--pretty` for indented)
- Errors go to stderr as JSON `{error, code}`
- No interactive prompts in API commands — only `login` uses @inquirer/prompts
- Path parameters use `{field}` template syntax in endpoint paths
- CLI flags are kebab-case, input fields are snake_case
