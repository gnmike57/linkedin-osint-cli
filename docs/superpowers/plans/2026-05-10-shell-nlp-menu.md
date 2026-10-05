# Shell-Style NLP Terminal Menu — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the palette-only interactive console with a shell REPL (`linkedin ▸`) that accepts exact commands and plain English (local deterministic NLP), confirm-first, zero new dependencies.

**Architecture:** Five new pure modules (`nlp-synonyms`, `nlp`, `completer`, `history`, plus the shell loop in `shell.ts`) feed off the existing `catalog.ts` / Zod schemas / `renderCommandLine`. `launcher.ts` is kept intact as the classic UI and reused for browse + guided prompts by exporting three functions. `src/index.ts` routes `menu`/`shell`/bare-TTY to the shell unless `LINKEDIN_UI=classic`.

**Tech Stack:** TypeScript (ESM, zod v4, commander at CLI edge), `node:readline`, vitest. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-05-10-shell-nlp-menu-design.md`

## Global Constraints

- Zero new runtime dependencies; tests must run offline (no cookies, no network).
- Env contracts verbatim: `LINKEDIN_UI` (`classic` = old launcher), `LINKEDIN_SHELL` (`plain` = force non-TTY behavior inside the shell), `LINKEDIN_PROMPTS` (unchanged).
- Prompt string: `linkedin ▸ ` (cyan `linkedin`, dim `▸`). Header is 3 lines rendered by `shell.ts`; `banner.ts` untouched.
- Write commands always confirm with default `n` and a red `⚠` marker: posts create/edit/delete, messaging send/send-new, connections send/accept/reject/withdraw, profile disconnect, engage react/comment/share.
- NLP never invents an invalid input: unfillable slots stay empty and fall through to guided prompts; `parseNlp` is pure and deterministic.
- No `commander` inside the REPL; flags are parsed by a small tokenizer in `shell.ts` and validated by the command's Zod schema.
- History file: `<getConfigDir()>/history`, all I/O fail-safe (never throws to the user).
- TDD: every task starts with a failing test; commands: `npx vitest run <file>`, full gate `npm test` (plus `npm run typecheck`).

## Review Focus

- **Piped multi-line sessions must never hang** (the v0.2.0 class of bug) — Tasks 6, 7.
- **Ambiguous NLP must list candidates, never auto-run** — Tasks 1, 6.
- **NLP must not guess URN/geo fields** — Task 1 tests prove `--geo`-type fields stay unfilled.
- **Windows/legacy conhost:** no cursor/alternate-screen ANSI; history failures silent — Tasks 3, 6.
- **Classic-UI regression:** `LINKEDIN_UI=classic` + existing `smoke:menu` keep passing — Tasks 5, 7.

## File Structure

```
src/interactive/nlp-synonyms.ts   (new) curated data: SYNONYMS, BOOL_WORDS, ENUM_WORDS
src/interactive/nlp.ts            (new) pure parser: tokenize/score/extract → NlpOutcome
src/interactive/completer.ts      (new) pure Tab-completion source
src/interactive/history.ts        (new) fail-safe load/append of config-dir history
src/interactive/shell.ts          (new) REPL loop + parseExactLine/tokenizeLine/applyFlagTokens/resolveShellPreference
src/interactive/launcher.ts       (edit) export browse/execute/prompt helpers (no behavior change)
src/index.ts                      (edit) menu→shell default, new `shell` alias, classic guard
tests/nlp.test.ts                 (new)
tests/shell.test.ts               (new) history, exact-line, env ladder, REPL behavior
tests/interactive.test.ts         (edit) completer describe-block
scripts/smoke-shell.mjs           (new) piped end-to-end over dist/
package.json                      (edit) add "smoke:shell"
README.md / CHANGELOG.md / CLAUDE.md (edit) document shell, NLP, env vars
```

Each new module is import-safe (no side effects on import; the REPL only starts from `runShell()`), which is what makes `shell.ts` testable.

## Task 1 — NLP parser core (`nlp-synonyms.ts`, `nlp.ts`, `tests/nlp.test.ts`)

**Files:** `src/interactive/nlp-synonyms.ts` (new), `src/interactive/nlp.ts` (new), `tests/nlp.test.ts` (new).

**Interfaces (exact, nothing else exported):**

```ts
// nlp-synonyms.ts
export const SYNONYMS: Record<string, string[]>;        // key: `${group} ${subcommand}`
export const BOOL_WORDS: Record<string, string[]>;      // field name → trigger words
export const ENUM_WORDS: Record<string, Record<string, string[]>>; // field → value → words

// nlp.ts
export interface ParseResult {
  command: CommandDefinition;
  input: Record<string, unknown>;
  matched: { via: 'nlp' | 'session-memory'; score: number };
  candidates?: CommandDefinition[];
  unclaimed: string[];
}
export type NlpOutcome =
  | { kind: 'match'; result: ParseResult }
  | { kind: 'ambiguous'; candidates: Array<{ entry: CatalogEntry; score: number }>; input: Record<string, unknown>; unclaimed: string[] }
  | { kind: 'none'; nearest: CatalogEntry[] };
export function tokenizeLine(text: string): string[];                     // lowercase, split spaces, keep quoted spans as single tokens
export function parseNlp(text: string, catalog: CatalogGroup[], memory?: Map<string, string>): NlpOutcome;
```

**Extraction rules the tests pin (implement exactly these):**
- Score: `3 × multi-word-synonym phrase hits + 2 × single-word synonym hits + 1 × searchText token overlap`. Multi-word = phrase is a substring of the lowercased line.
- Top score < 2 → `none` with the 5 nearest entries by searchText overlap.
- Two commands tie within 1 point → `ambiguous` (top ≥ 2), unless a `memory` entry (normalized text → `${group} ${subcommand}`) resolves it → `match` with `via: 'session-memory'`.
- Quoted string → first arg field (cliMappings.args order), then next arg field; bare non-verb token → first arg field; digits-only token → first arg field as number unless preceded by a count word (`limit/last/first/results/count`) → `limit`/`count` option field if declared.
- `--flag value` / bare `--flag` (boolean via `flagTakesValue`) map by `longFlag(opt.flags)` → `opt.field`.
- `BOOL_WORDS`/`ENUM_WORDS` fill their field only when the command declares it.
- Location words ("in <place>") never fill a field unless that field is a free-string option (e.g. `search_jobs --location`); URN fields (`--geo`, `--following_state_urn`) are never filled by NLP.

**Steps:**
- [ ] Write `tests/nlp.test.ts` failing: describe-blocks `synonym coverage` (every command in `allCommands` has ≥1 SYNONYMS phrase keyed `${group} ${subcommand}`), `intent scoring` (synonyms win; catalog-overlap alone stays under threshold 2), `ambiguity` (tie within 1 → ambiguous; memory resolves → session-memory match), `refusal` ("hello world" → none + nearest non-empty), `slot filling` (each rule above, incl. unclaimed tokens reported), `determinism` (same args → deep-equal outcome).
- [ ] Run `npx vitest run tests/nlp.test.ts` — expect fail (module missing).
- [ ] Implement `nlp-synonyms.ts` and `nlp.ts` to the interfaces above.
- [ ] Run `npx vitest run tests/nlp.test.ts` — all green; run `npm test` — 219+ still green.
- [ ] Commit: `feat(interactive): local NLP parser with synonyms and slot filling`.

## Task 2 — Tab completer (`completer.ts`, `tests/interactive.test.ts`)

**Files:** `src/interactive/completer.ts` (new); extend `tests/interactive.test.ts`.

**Interfaces:**

```ts
export const BUILTIN_WORDS: string[];  // ['help','browse','history','clear','status','exit','quit','menu','shell','login']
export function completeLine(line: string, catalog: CatalogGroup[]): [string[], string]; // [candidates, lastToken]
export function createCompleter(catalog: CatalogGroup[]): (line: string) => [string[], string];
```

Completion levels (first match wins): (a) one token (partial) → builtin words + group names; a token starting with `--` matches nothing here; (b) two tokens where token[0] is a group name → that group's subcommands; (c) token[0] resolves to a command and the last token starts with `--` → long flags of that command's options via `longFlag()`; (d) else `[[], lastToken]`.

**Steps:**
- [ ] Add failing `describe('shell completer')` to `tests/interactive.test.ts` (catalog built once from `allCommands`): empty line → all groups + builtins; `sea` → `search`; `search ` → its subcommands; `search people --` → `--keywords` present; `search people --net` → `--network`; unknown pair → empty; builtin partial completes.
- [ ] Run `npx vitest run tests/interactive.test.ts` — expect fail.
- [ ] Implement `completer.ts`.
- [ ] Run `npx vitest run tests/interactive.test.ts` — green.
- [ ] Commit: `feat(interactive): tab completion source for the shell`.

## Task 3 — History store (`history.ts`, `tests/shell.test.ts`)

**Files:** `src/interactive/history.ts` (new); create `tests/shell.test.ts`.

**Interfaces:**

```ts
export function historyPath(dir: string): string;               // join(dir, 'history')
export function loadHistory(dir: string): string[];             // missing/unreadable → []; last 200 lines, dedupe keeping last-occurrence order
export function appendHistory(dir: string, line: string): void; // mkdir -p; skip empty/whitespace; any error swallowed, never throws
```

**Steps:**
- [ ] Write failing `describe('history')` in `tests/shell.test.ts` using `mkdtempSync(join(tmpdir(), 'li-hist-'))`: round-trip load/append; missing dir → `[]`; 200-line cap; dedupe; a directory in place of the history file → `[]` (works on all platforms); append failure does not throw.
- [ ] Run `npx vitest run tests/shell.test.ts` — expect fail.
- [ ] Implement `history.ts` (sync `node:fs`, try/catch at every boundary).
- [ ] Run `npx vitest run tests/shell.test.ts` — green.
- [ ] Commit: `feat(interactive): fail-safe persistent history store`.

## Task 4 — Exact-line parsing + flag applier (exports from `shell.ts`, `tests/shell.test.ts`)

**Files:** `src/interactive/shell.ts` (new — import-safe helpers only this task), extend `tests/shell.test.ts`.

**Interfaces:**

```ts
export function resolveShellPreference(env?: NodeJS.ProcessEnv): 'shell' | 'classic'; // LINKEDIN_UI=classic → 'classic', else 'shell'
export type ExactLine =
  | { kind: 'exact'; entry: CatalogEntry; tokens: string[] }  // tokens = remainder after group+subcommand
  | { kind: 'group'; group: CatalogGroup }                    // bare group name typed
  | { kind: 'other'; text: string };                          // → NLP path
export function classifyLine(line: string, catalog: CatalogGroup[]): ExactLine;
export function applyFlagTokens(cmd: CommandDefinition, tokens: string[]): { input: Record<string, unknown>; unknownFlags: string[] };
```

`applyFlagTokens` walks tokens left-to-right: `--flag [value]` per `flagTakesValue(longFlag)`; value tokens pair with the preceding flag; a value token following a boolean flag starts a new pair; bare tokens are ignored here (NLP/args stage owns them); a flag not in `cliMappings.options` → `unknownFlags`.

**Steps:**
- [ ] Write failing `describe('exact line')` in `tests/shell.test.ts`: `profile view johndoe` → exact + tokens `['johndoe']`; `search people --keywords "engineer" --network F` → exact + flags applied (keywords/network in input, F string, `--keywords` consumed); bare `osint` → group; `help` and `scrape sales at acme` → other; `--bogus` flag → unknownFlags; boolean flag `--geoblast` takes no value.
- [ ] Run `npx vitest run tests/shell.test.ts` — expect fail.
- [ ] Implement the three functions in `shell.ts` (module import-safe: no readline, no side effects).
- [ ] Run `npx vitest run tests/shell.test.ts` — green.
- [ ] Commit: `feat(interactive): exact-command tokenizer and flag applier`.

## Task 5 — Launcher exports for reuse (`launcher.ts`, no behavior change)

**Files:** `src/interactive/launcher.ts` (edit), `tests/shell.test.ts` (extend).

**Change (the only edit):** add `export` to the existing `interface Prompts`, and to the existing functions `collectInput`, `executeEntry`, `browseByCategory`, `runSessionAction`; export `SESSION_ITEMS`. Zero logic changes — classic UI stays byte-for-byte behavior-identical.

**Steps:**
- [ ] Write failing test in `tests/shell.test.ts`: import those exports from `launcher.js` and assert they are defined (`typeof collectInput === 'function'`, etc.). Also assert `runInteractiveMenu` still exported.
- [ ] Run `npx vitest run tests/shell.test.ts` — expect fail.
- [ ] Add the exports.
- [ ] Run `npx vitest run tests/shell.test.ts` and `npx vitest run tests/interactive.test.ts` — green (classic behavior untouched).
- [ ] Commit: `refactor(interactive): export launcher helpers for the shell`.

## Task 6 — Shell REPL loop (`runShell`, staging loop, builtins)

**Files:** `src/interactive/shell.ts` (extend), `tests/shell.test.ts` (extend).

**Interfaces:**

```ts
export async function runShell(options: { version: string }): Promise<void>;
// internals (also exported for tests, no other internals exported):
export function renderHeader(version: string, sessionSaved: boolean, totalCommands: number): string[];  // pure: the 3-line frame + hint
export function isWriteCommand(cmd: CommandDefinition): boolean;   // the Global Constraints write-command list, by group+subcommand
export function builtinFor(line: string): 'help' | 'browse' | 'history' | 'clear' | 'status' | 'login' | 'exit' | null;
```

**Loop contract (each point is a test):**
- Prompt `linkedin ▸ `; input via one `createInterface({ input, output, completer, terminal: isTTY })`; history seeded from `loadHistory(getConfigDir())`, each non-builtin, non-empty line appended on commit.
- Line routing (first match wins): builtin → handler; `classifyLine` exact → staged flow; bare group → `browseByCategory` for that group; otherwise `parseNlp` (match → staged flow; ambiguous → numbered list, pick via `parseSelection`, store in memory map; none → print nearest + hint).
- Staged flow: print `≡ interpreted as: <renderCommandLine(cmd, input)>`, red `⚠` + explicit confirm when `isWriteCommand`; staging loop reads lines: `''` → run; `q` → cancel; `edit` → `collectInput` (seed current values as prompt defaults); `field value` / `--flag value` → override via `applyFlagTokens` against the collected input, re-render; `raw` → print command line only, no execution. After overrides: `inputSchema.safeParse` — fail prints Zod issues and stays in staging; pass runs `createLazyClient({})` + `cmd.handler`, `output(result, { pretty: false })`, `✓ done in Xs`; `outputError` on throw.
- Header session line: `loadConfig()` non-null → `session: saved`, else `session: none — type "login"` (no network). `login`/`status` builtins → `runSessionAction` with matching `SESSION_ITEMS` args (`login`, `login --from-chrome`, `status --verify`).
- Ctrl+C (SIGINT) clears line; second SIGINT on empty line exits with `goodbye`; `close` (Ctrl+D/EOF) exits with `goodbye` — no unsettled top-level await.
- Fallback ladder: `resolveShellPreference() === 'classic'` → `runInteractiveMenu` immediately; `LINKEDIN_SHELL=plain` or non-TTY stdin → completer/terminal disabled, loop otherwise identical.

**Steps:**
- [ ] Write failing `describe('shell repl')`: renderHeader content (version, `session: saved`/`none`, command count); isWriteCommand truth table; builtinFor routing; ambiguous → candidates listed, numbered pick stores memory, second identical phrase resolves without re-ask (piped PassThrough lines); staged `count 25` override lands in executed input (offline `osint classify` command, assert JSON + echo); `q` cancels with no execution; write command piping `''` at the ⚠ confirm runs nothing; EOF exits with `goodbye`; classic env routes to `runInteractiveMenu` (`vi.mock` spy).
- [ ] Run `npx vitest run tests/shell.test.ts` — expect fail.
- [ ] Implement `runShell` + internals to the contract (reuse `c`/`CHECK`/`CROSS`/`ARROW`/`DOT`; no new ANSI sequences).
- [ ] Run `npx vitest run tests/shell.test.ts`, then `npm test` — green.
- [ ] Commit: `feat(interactive): shell REPL with NLP routing and confirm-first staging`.

## Task 7 — CLI wiring, smoke test, docs

**Files:** `src/index.ts` (edit), `scripts/smoke-shell.mjs` (new), `scripts/smoke-menu.mjs` (edit), `package.json` (edit), `README.md`, `CHANGELOG.md`, `CLAUDE.md`.

**Wiring decisions:**
- `menu` action: `resolveShellPreference() === 'classic'` → `runInteractiveMenu`, else `runShell`. New `shell` command, same action. Bare-TTY branch gets the same guard (non-TTY bare stays help text).
- `package.json`: add `"smoke:shell": "node scripts/smoke-shell.mjs"` next to `smoke:menu`.

**smoke-shell.mjs** (copy the spawn/timeout/PASS-FAIL pattern from `scripts/smoke-menu.mjs`; target `dist/index.js shell`, env `LINKEDIN_PROMPTS=fallback` + `LINKEDIN_SHELL=plain`, 20s timeout):
1. Exact: `osint classify --title "Senior Cyber Security Manager"` → assert `"division":"Cyber Security"` + echoed `linkedin osint classify --title ...`.
2. NLP: `classify the title senior cyber security manager` → same JSON + `interpreted as:` line.
3. Ambiguous: a phrase that ties → candidates printed, numbered pick, JSON out.
4. Staged override: NLP phrase, then `count 25`, then Enter → `--count 25` in the scriptable echo.
5. Builtins: `help` lists groups; `history` echoes prior lines; `exit` → `goodbye`, exit 0, no `/unsettled top-level await/i` in stderr.

Also pin `LINKEDIN_UI: 'classic'` in `scripts/smoke-menu.mjs` env (its assertions unchanged — classic stays the palette).

**Docs:**
- README "Interactive console": rewrite for the shell (prompt, exact/NLP input, Tab, history, `browse`, env table `LINKEDIN_UI`/`LINKEDIN_SHELL`/`LINKEDIN_PROMPTS`, macOS/Win11/Linux note).
- CHANGELOG: new `## [Unreleased]` section (shell REPL, NLP, env vars).
- CLAUDE.md interactive-prompts line: mention the shell REPL + env fallbacks.

**Steps:**
- [ ] Edit `src/index.ts` and `package.json`.
- [ ] Write `scripts/smoke-shell.mjs`; add the classic pin to `scripts/smoke-menu.mjs`.
- [ ] Update README / CHANGELOG / CLAUDE.md.
- [ ] `npm run build`, then `npm run smoke:shell`, then `npm run smoke:menu` — all PASS.
- [ ] `npm test` and `npm run typecheck` — green.
- [ ] Commit: `feat(cli): shell REPL as default interactive console (NLP, completion, history)`.
