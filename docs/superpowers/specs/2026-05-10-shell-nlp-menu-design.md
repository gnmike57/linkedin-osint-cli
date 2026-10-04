# Shell-Style Terminal Menu with NLP — Design Spec

**Date:** 2026-05-10
**Status:** Draft for review
**Feature:** Replace the palette-style interactive console with a real shell REPL that accepts exact commands and plain English (NLP), hand-rolled on `node:readline`, zero new dependencies.

---

## 1. Purpose

The interactive console today is a pick-from-palette menu. The user wants a
terminal that *feels like a real shell* (bash / PowerShell style) and also
understands plain English, so the human operator can:

- type exact commands the way they already script them:
  `search people --keywords "software engineer" --network F`
- type natural language and get the same result:
  `scrape all the sales guys at acme, limit 50`
- discover commands without leaving the prompt (Tab completion, `help`,
  `browse`), with arrow keys walking persistent history.

Success criteria:

1. Every one of the 56 tools plus session actions is reachable from the shell
   by exact command, by NLP phrase, and via the browse palette.
2. NLP is local, deterministic, offline — no API key, no network.
3. Nothing executes without an explicit confirmation showing the assembled
   command line.
4. Identical behavior on macOS, Windows 11 (PowerShell / Windows Terminal /
   legacy conhost), and Linux, with safe degradation for non-TTY / piped /
   CI usage. 219+ existing tests stay green; the smoke scripts keep passing.

## 2. Goals and non-goals

**Goals**

- Shell REPL UX: prompt line, history (↑/↓), Tab completion, Ctrl+C / Ctrl+D
  semantics, `help` / `clear` / `history` / `exit` builtins.
- Hybrid input: exact commands, NLP phrases, and palette browsing in one input.
- Local NLP intent + entity extraction over the command catalog.
- Confirm-first execution with inline param editing before the run.
- Zero new runtime dependencies (uses `node:readline`, existing `colors.ts`,
  existing catalog + Zod schemas + `renderCommandLine`).

**Non-goals**

- No full-screen TUI framework (no ink / blessed); no bordered panels.
- No LLM/Cloud NLP (no Groq calls from the shell — the NLP layer is rules).
- No changes to CLI flags, MCP tools, handlers, or the Voyager client.
- No scraping-rate behavior changes; the shell reuses the same lazy client.

## 3. Shared understanding (agreed with the user)

1. **Interaction model — hybrid.** One universal prompt accepts plain English
   *or* exact commands; the menu (palette) remains for discovery.
2. **Visuals — shell-native.** Prompt like `linkedin ▸`, native terminal
   behavior; explicitly *not* a dashboard TUI. User's words: "terminal /
   pwshell / bash terminal style menu".
3. **NLP — local rules only.** Offline, deterministic, no key.
4. **Execution — always confirm first.** Show parsed command + filled params;
   edit/adjust before running.

## 4. UX specification

### 4.1 Entry points

| Entry | Behavior |
|-------|----------|
| bare `linkedin` on a TTY | opens the shell (unchanged rule from `src/index.ts`) |
| `linkedin menu` | opens the shell (kept as the documented alias) |
| `linkedin shell` | new, explicit alias for the same shell |
| bare `linkedin` without TTY | prints help (unchanged) |

### 4.2 Prompt and chrome

```
  ╔══════════════════════════════════════════╗
    linkedin-cli v0.2.0 · interactive shell
    session: saved · 56 tools · type "help" or plain English
  ╚══════════════════════════════════════════╝

linkedin ▸ _
```

- Prompt string: `linkedin ▸ ` (cyan `linkedin`, dim arrow).
- Session line is built **without network calls**: it checks whether stored
  cookies exist via the existing config (`loadConfig`) and shows
  `session: saved` / `session: none — type "login"`. Actual network verification
  happens only when the user types `status` (which re-execs the CLI, exactly
  like today's session actions).
- The 3-line header frame above is rendered by `shell.ts` (a new compact
  header; `banner.ts` stays untouched for the classic UI).

### 4.3 Input grammar at the prompt

Everything typed is classified in this order (first match wins):

1. **Builtin** — `help`, `help <cmd>`, `browse [group]`, `history`, `clear`,
   `status`, `exit` / `quit`. Also `menu` inside the shell opens browse mode.
2. **Exact command** — first token(s) match a known `group subcommand` pair
   (or the bare group, opening that group's list). The remainder is tokenized
   by a small in-shell flag parser (handles `--flag value`, `-f value`, bare
   positional args; no `commander` inside the REPL) and validated by the same
   Zod schema. Unknown flags error with the command's `help` text. If required
   params are missing, the existing guided prompts fill them in (same as today).
3. **NLP phrase** — anything else goes to the NLP parser (§5). When the parser
   cannot resolve a command, it replies with its best candidates and falls
   back to suggestions (Tab or `browse`).

### 4.4 Tab completion

- First token: builtin names + group names (`profile`, `search`, `osint`, …).
- Second token: subcommands of that group (`view`, `me`, `posts`, …).
- On `--`: option names of the current command, derived from `cliMappings`
  (e.g. `--keywords`, `--network`, `--limit`).
- Values are *not* completed (no offline value lists for e.g. geo URNs).

### 4.5 History

- `node:readline` history for the live session (↑/↓).
- Persistent across sessions: appended to `~/.linkedin-cli/history` (dir from
  `getConfigDir()`), loaded at startup (last 200 lines, deduped), on every
  platform including Windows. `history` builtin prints the session's entries.
- Failures to read/write history are non-fatal (warn once, continue).

### 4.6 Browse mode (discovery)

`browse` (or a bare group name) reuses the existing palette machinery from
`launcher.ts` (category list → command list → guided input) unchanged, then
returns to the prompt. This keeps 100% of today's discoverability while the
prompt stays a shell.

### 4.7 Keyboard semantics

- `Ctrl+C` clears the current input line; twice in a row with an empty line
  exits (prints `goodbye`).
- `Ctrl+D` on an empty line exits (readline's native close → graceful exit,
  matching today's EOF behavior that the smoke tests rely on).
- No raw-mode beyond what `node:readline` already manages, which is what keeps
  PowerShell/cmd compatible.

## 5. NLP design (local, deterministic)

New pure module `src/interactive/nlp.ts` (plus a data module
`src/interactive/nlp-synonyms.ts`). No I/O, no client, no env access —
unit-testable like `catalog.ts`.

### 5.1 Pipeline

```
text → tokenize → intent scoring over catalog → pick command(s)
     → entity extraction into Zod-field slots → ParseResult
```

### 5.2 Intent scoring

Each `CommandDefinition` gets a score from the tokenized input:

- **Synonym hits** — curated per-command synonym table (data module), e.g.
  `profile_view`: ["view profile", "who is", "look up", "profile of"];
  `osint_employees`: ["scrape employees", "employee list", "people at",
  "staff at", "who works at"]; `messaging_send-new`: ["dm", "message",
  "send a message", "text"]; `engage_react`: ["like", "react", "clap",
  "celebrate", "heart", "insightful", "funny"]; `connections_send`:
  ["connect", "add", "invite"]; `search_people`: ["find people", "search
  people", "people search"]; `search_jobs`: ["find jobs", "job search"];
  `osint_discover`: ["find companies", "discover companies",
  "companies in"]. Multi-word synonyms score higher than single tokens.
- **Catalog text overlap** — tokens matched against
  `group + subcommand + name + description` (lowercased `searchText` already
  exists in `catalog.ts`; reuse it).
- **Exact command prefix** — if the text starts with `group subcommand`, skip
  NLP entirely (§4.3 rule 2 handles it).

Score = 3 × multi-word-synonym hits + 2 × single-synonym hits + 1 × catalog
token overlap. Highest score wins.

### 5.3 Ambiguity and refusal rules (explicit, never guessed)

- Top score < 2 → no command; reply with "not sure what you mean" + the
  nearest 5 catalog entries (so the shell teaches the catalog).
- Two or more commands tie within 1 point → numbered candidate list; the user
  picks by number (reusing the selection logic in `readline-prompts.ts`), and
  that pick is remembered for the rest of the session so the same phrase
  resolves without re-asking.
- Phrases that map to *write* commands (posts create/edit/delete, messaging
  send/send-new, connections send/accept/reject/withdraw, profile disconnect,
  engage react/comment/share) always show a red ⚠ in the confirmation and
  require an explicit `y` (default `n`).

### 5.4 Entity extraction into Zod slots

Slot filling uses each command's `cliMappings` + Zod shape (the single source
of truth — no parallel schema):

- **Quoted strings** (`"..."`) → first quoted string goes to the most specific
  required string field (`public_id`, `keywords`, `text`, `company`…); second
  quoted string to the next string field in mapping order.
- **Bare single tokens without a verb role** → positional arg field (same
  precedence as quoted strings), e.g. `profile view johndoe`.
- **Integers** → numeric fields by name affinity: `count`, `limit`, `start`
  (e.g. "limit 50", "last 10 posts", "50 results" → `--limit`/`--count`).
  Job/activity URN digits route to `post_urn`/`job_id` only for commands that
  declare them.
- **Boolean trigger words** → mapped per option: "remote" → `--remote`,
  "geoblast" → `--geoblast`, "with ai" / "use ai" → `--use-ai`, "connections
  only" → `--visibility connections` (enum mapped).
- **Reaction words** → `--type` enum on `engage_react`
  (like→LIKE, celebrate/clap→PRAISE, support→APPRECIATION, love/heart→EMPATHY,
  insightful→INTEREST, funny→ENTERTAINMENT).
- **Location phrases** ("in the usa", "in london", "remote") → filled **only**
  into free-string fields (e.g. `search_jobs --location`). URN-typed fields
  (e.g. `search_people --geo`) are *never* guessed offline; they fall through
  to the guided prompt.
- **Sort enums** (`--sort REVERSE_CHRONOLOGICAL`): "newest"/"latest" →
  `REVERSE_CHRONOLOGICAL`.

Anything the extractor cannot place with confidence is left unfilled; unfilled
fields go to the guided prompts (§6), so NLP can never invent an invalid input.

### 5.5 Output type

```ts
interface ParseResult {
  command: CommandDefinition;      // matched command
  input: Record<string, unknown>;  // extracted slots (pre-Zod)
  matched: { via: 'nlp' | 'session-memory'; score: number };
  candidates?: CommandDefinition[]; // present only on ambiguity
  unclaimed: string[];              // tokens not consumed (shown to user)
}

```

Determinism requirement: `parse(text, catalog)` is a pure function — same
input, same output, no clock, no randomness. The session-memory for ambiguity
resolutions lives *outside* the parser (a small map owned by the shell).

## 6. Execution flow (confirm-first)

1. `ParseResult` → `renderCommandLine(cmd, input)` (existing) shows the
   assembled command line in cyan, e.g.
   `≡ interpreted as: linkedin osint employees acme-corp --keywords sales --limit 50`
   plus a dim line listing unfilled required fields.
2. **Staging loop** (shell-native editing):
   - `Enter` → run
   - `field value` (e.g. `count 25`) or `--flag value` → overrides the slot
     and re-renders the command line (an invalid field name prints the field
     list for that command)
   - `edit` → walks the guided prompts (prefilled with current values)
   - `raw` → print the exact command line and return to the prompt (no
     execution — for copy-pasting into a script)
   - `q` → cancel back to the prompt
3. Before running: `cmd.inputSchema.safeParse(input)` — identical validation to
   CLI/MCP/console today. Failures print the Zod issues and return to staging.
4. Run via `createLazyClient({})` + `cmd.handler` exactly like `launcher.ts`
   does; JSON output to stdout (`output()`), errors via `outputError()`.
   The scriptable line is always printed with the result, preserving the
   "teach the scriptable form" behavior.
5. Return to the prompt. Timing line (`✓ done in 1.2s`) as today.

## 7. Cross-platform compatibility (mac / Windows 11 / Linux)

- Everything is `node:readline` + ANSI via the existing `colors.ts`. No cursor
  manipulation, no alternate screen buffer — this is what keeps legacy conhost
  on Windows 11 and every POSIX shell behaving identically.
- ANSI is already conditionally applied for non-TTY by `colors.ts`; the shell
  additionally disables completion/history when `stdin.isTTY` is false.
- History file path uses the existing `getConfigDir()` (works on all three
  platforms); write failures are non-fatal.
- **Fallback ladder** (mirrors the existing `LINKEDIN_PROMPTS` convention):
  - TTY present → full shell REPL (Tab completion + history live).
  - Non-TTY / piped → shell runs with completion/history disabled but identical
    grammar and confirm-first staging; this is the path the smoke tests drive
    (`LINKEDIN_SHELL=plain` forces it).
  - `LINKEDIN_UI=classic` → old palette-only launcher, kept intact as
    `launcher.ts` today, so nothing is lost for users who prefer it.
- The prompt-loop state machine is synchronous between questions, so piped
  multi-line sessions cannot hang (the class of bug fixed in v0.2.0 must not
  reappear; the line-queue pattern in `readline-prompts.ts` is reused).

## 8. File layout

```
src/interactive/
  shell.ts            # REPL loop, prompt, builtins, staging loop (new)
  nlp.ts              # pure parser: tokenize, score, extract (new)
  nlp-synonyms.ts     # curated synonym + boolean/enum trigger tables (new)
  completer.ts        # Tab-completion source function (pure, new)
  history.ts          # load/append ~/.linkedin-cli/history (new, fail-safe)
  launcher.ts         # unchanged — becomes the "classic" UI + reused browse
  catalog.ts          # unchanged (reused: searchText, renderCommandLine)
  readline-prompts.ts # reused for guided prompts inside staging `edit`
src/index.ts          # `menu` action → shell; add `shell` alias
tests/
  nlp.test.ts         # parser: intent, slots, ambiguity, determinism (new)
  shell.test.ts       # builtins routing, staging overrides, fallback ladder (new)
  interactive.test.ts # extended: completer cases
scripts/
  smoke-shell.mjs     # piped sessions: exact cmd, NL cmd, browse, staged edit
```

`package.json`: add `smoke:shell` script. No dependency changes.

## 9. Testing plan

- **Unit (offline, deterministic):**
  - `nlp.test.ts`: 30+ fixtures — exact command passthrough, each synonym
    class, quoted-string slots, numbers→count/limit, booleans, reaction enum,
    ambiguity → candidates, low-confidence refusal, unclaimed tokens report,
    determinism (same input twice → deep-equal), every one of the 56 commands
    reachable by at least one phrase.
  - `shell.test.ts`: builtin routing (`help/browse/exit/clear/history/status`),
    staging override + cancel paths with fake prompt streams (PassThrough, as
    `interactive.test.ts` already does), fallback selection via
    `LINKEDIN_UI`/`LINKEDIN_SHELL` env resolution.
  - Completer: group/subcommand/flag levels; empty input returns all groups.
- **Smoke:** `smoke-shell.mjs` drives the built `dist/` artifacts over piped
  stdin asserting: exact command executes; NL phrase executes the same command;
  ambiguous phrase lists candidates and a numbered pick works; a staged
  `count 25` override lands in the executed input; EOF exits cleanly with
  `goodbye`.
- **Existing suites stay green:** catalog/launcher fallback behavior unchanged;
  `smoke:menu` keeps passing — the script pins `LINKEDIN_UI=classic` itself
  (the same way it already pins `LINKEDIN_PROMPTS=fallback`), so its palette
  assertions remain valid; CI needs no default change.

## 10. Risks and limitations

- **NLP recall is bounded by the synonym table.** Mitigation: every miss
  surfaces the nearest catalog entries and `browse`; the table is data, so
  misses are cheap to fix incrementally.
- **Windows legacy conhost quirks** (arrow-key history via readline is fine;
  some Ctrl-combos differ). Mitigation: no dependence on non-universal keys;
  Ctrl+C/D handled defensively; documented in README.
- **Shell replaces the palette as the default entry.** Mitigation:
  `LINKEDIN_UI=classic` keeps the old UI one env var away; `browse` keeps the
  palette one command away.
- **Ambiguous entity slots** (e.g. a bare number meant as a count vs an ID).
  Mitigation: numbers fill count-like fields only when the command declares
  them and context words match; otherwise the guided prompt asks.

## 11. Out of scope (future)

- Fuzzy value completion (geo names → URNs) — needs network or a cached table.
- Persistent ambiguity memory across sessions.
- Streaming/incremental parse-as-you-type suggestions.
- MCP-side NLP (agents already speak tool schema directly).
