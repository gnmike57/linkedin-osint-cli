# Changelog

All notable changes to this project are documented here. Releases are tagged on
`master`; each entry mirrors the corresponding GitHub release.

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
