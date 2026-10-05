/*
 * Interactive shell REPL — bare `linkedin` on a TTY, `linkedin menu`,
 * `linkedin shell` (spec: docs/superpowers/specs/2026-05-10-shell-nlp-menu-design.md).
 *
 * One hybrid prompt accepts exact commands, plain English (local NLP), and
 * palette browsing — confirm-first execution with inline field overrides.
 * Everything is node:readline + ANSI via colors.ts; zero new dependencies.
 * The classic palette UI stays available via LINKEDIN_UI=classic or `browse`.
 */

import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { allCommands, createLazyClient } from '../commands';
import { loadConfig } from '../core/config.js';
import { output, outputError } from '../core/output.js';
import type { CommandDefinition } from '../core/types.js';
import { c, CHECK, CROSS, DOT } from './colors.js';
import { buildCatalog, flagTakesValue, longFlag, renderCommandLine } from './catalog.js';
import type { CatalogEntry, CatalogGroup } from './catalog.js';
import { parse, tokenize, extractSlots, synonymHits, fieldInfos, coerceValue } from './nlp.js';
import type { Token } from './nlp.js';
import type { FieldInfo } from './nlp.js';
import { isWriteCommand } from './nlp-synonyms.js';
import { loadHistory, appendHistory } from './history.js';
import { buildCompletionSource, completeLine } from './completer.js';
import { browseByCategory, executeEntry, isBrowseSentinel, execSessionAction } from './launcher.js';
import { exitPromptError, parseSelection } from './readline-prompts.js';

const PROMPT = `${c.cyan('linkedin')} ${c.dim('▸')} `;
const BUILTINS = ['help', 'browse', 'menu', 'history', 'clear', 'status', 'login', 'logout', 'exit', 'quit'];

export type ShellMode = 'classic' | 'shell' | 'plain';

/**
 * Fallback ladder (spec §7): LINKEDIN_UI=classic keeps the old palette UI;
 * LINKEDIN_SHELL=plain forces the non-TTY grammar (the path smoke tests
 * drive); otherwise the shell degrades by itself on non-TTY stdin.
 */
export function resolveShellMode(env: NodeJS.ProcessEnv = process.env): ShellMode {
  const ui = (env.LINKEDIN_UI ?? '').trim().toLowerCase();
  if (ui === 'classic' || ui === 'palette' || ui === 'menu') return 'classic';
  const shell = (env.LINKEDIN_SHELL ?? '').trim().toLowerCase();
  if (shell === 'plain' || shell === 'dumb' || shell === 'basic') return 'plain';
  return 'shell';
}

interface Choice<T> {
  name: string;
  value: T;
  description?: string;
}

export interface ShellPrompts {
  input(opts: { message: string; default?: string }): Promise<string>;
  confirm(opts: { message: string; default?: boolean }): Promise<boolean>;
  select<T>(opts: { message: string; choices: Array<Choice<T>>; pageSize?: number }): Promise<T>;
  search<T>(opts: {
    message: string;
    source: (term: string | undefined) => Promise<Array<Choice<T>>>;
    pageSize?: number;
  }): Promise<T>;
}

/**
 * Prompts implementation on top of the shell's own readline line queue —
 * the same interaction pattern as readline-prompts.ts, but sharing the one
 * interface the REPL owns, so piped sessions never interleave two readers.
 */
export function createShellPrompts(deps: {
  write: (text: string) => void;
  nextLine: () => Promise<string | null>;
  tty: boolean;
}): ShellPrompts {
  const { write, nextLine, tty } = deps;

  const read = async (label: string): Promise<string> => {
    write(label);
    const line = await nextLine();
    if (line === null) throw exitPromptError();
    if (!tty) write(`${line}\n`);
    return line;
  };

  const askNumbered = async <T>(message: string, choices: Array<Choice<T>>): Promise<T> => {
    if (choices.length === 0) throw exitPromptError();
    write(`\n${c.bold(message)}`);
    choices.forEach((choice, i) => {
      write(`  ${c.cyan(String(i + 1).padStart(2))}) ${choice.name}`);
      if (choice.description) write(`      ${c.dim(choice.description)}`);
    });
    for (let attempt = 0; attempt < 5; attempt++) {
      const answer = (await read(`\n${c.cyan(`select 1-${choices.length}`)} ${DOT} `)).trim();
      const idx = parseSelection(answer, choices.length);
      if (idx !== null) return choices[idx]!.value;
      write(`  ${c.red(`invalid selection: ${answer || '(empty)'}`)}`);
    }
    throw exitPromptError();
  };

  return {
    async input({ message, default: def }) {
      const suffix = def ? c.dim(` [${def}]`) : '';
      const answer = (await read(`${message}${suffix} `)).trim();
      return answer === '' && def !== undefined ? def : answer;
    },
    async confirm({ message, default: def }) {
      const hint = def ? 'Y/n' : 'y/N';
      const answer = (await read(`${message} ${c.dim(`(${hint})`)} `)).trim().toLowerCase();
      if (answer === '') return def ?? false;
      return answer === 'y' || answer === 'yes';
    },
    select: (opts) => askNumbered(opts.message, opts.choices),
    async search({ message, source }) {
      const term = (await read(`${message} ${c.dim('(filter, blank = all)')} `)).trim();
      const choices = await source(term === '' ? undefined : term);
      return askNumbered('matches:', choices);
    },
  };
}

/** Shell state shared by the prompt loop and every handler. */
export interface ShellSession {
  version: string;
  catalog: CatalogGroup[];
  commands: CommandDefinition[];
  byGroup: Map<string, CommandDefinition[]>;
  /** Ambiguity memory: phrase → chosen command name (session-scoped). */
  memory: Map<string, string>;
  /** True when running on a TTY without LINKEDIN_SHELL=plain. */
  tty: boolean;
  write: (text: string) => void;
  history: string[];
  prompts: ShellPrompts;
  nextLine: () => Promise<string | null>;
  execSession: (args: string[]) => void;
}

/** Compact header frame (spec §4.2) — built without network calls. */
export function renderShellHeader(version: string, commandCount: number, sessionSaved: boolean): string {
  const title = `linkedin-cli v${version} · interactive shell`;
  const session = sessionSaved
    ? `session: saved · ${commandCount} tools · type "help" or plain English`
    : `session: none — type "login" · ${commandCount} tools · "help" lists commands`;
  const width = Math.max(title.length, session.length) + 2;
  const bar = '═'.repeat(width);
  return [
    c.dim(`  ╔${bar}╗`),
    `  ${c.bold(title)}`,
    `  ${c.dim(session)}`,
    c.dim(`  ╚${bar}╝`),
  ].join('\n');
}

export type Verdict = 'exit' | 'continue';

/**
 * Classify one prompt line and dispatch it (spec §4.3): builtins first,
 * then exact `group subcommand` commands, then the NLP parser.
 */
export async function handleInput(session: ShellSession, line: string): Promise<Verdict> {
  const tokens = tokenize(line);
  const first = tokens[0]?.lower;

  if (first && BUILTINS.includes(first)) {
    return handleBuiltin(session, first, tokens.slice(1));
  }
  if (first && session.byGroup.has(first)) {
    return handleExactCommand(session, tokens);
  }
  return handleNlp(session, line, tokens);
}

async function handleBuiltin(session: ShellSession, name: string, rest: Token[]): Promise<Verdict> {
  switch (name) {
    case 'exit':
    case 'quit':
      return 'exit';
    case 'clear':
      if (session.tty) session.write('\x1b[2J\x1b[H');
      else session.write(`\n${c.dim('─'.repeat(60))}`);
      return 'continue';
    case 'history':
      if (session.history.length === 0) {
        session.write(c.dim('  (no history this session)'));
      } else {
        session.history.forEach((entry, i) => {
          session.write(`  ${c.cyan(String(i + 1).padStart(3))}  ${entry}`);
        });
      }
      return 'continue';
    case 'status':
      session.execSession(['status', '--verify']);
      return 'continue';
    case 'login':
      session.execSession(['login']);
      return 'continue';
    case 'logout':
      session.execSession(['logout']);
      return 'continue';
    case 'menu':
      return doBrowse(session, []);
    case 'browse':
      return doBrowse(session, rest);
    default:
      return handleHelp(session, rest);
  }
}

function handleHelp(session: ShellSession, rest: Token[]): Verdict {
  if (rest.length === 0) {
    session.write(`\n${c.bold('builtins:')}`);
    session.write('  help [command]             this help, or detail for one command/group');
    session.write('  browse [group]             palette discovery (the old menu), back to prompt after');
    session.write('  menu                       same as browse');
    session.write('  history                    this session\'s prompt history');
    session.write('  clear                      clear the screen');
    session.write('  status | login | logout    re-exec the CLI session commands');
    session.write('  exit | quit                leave the shell');
    session.write(`\n${c.bold('groups:')} ${session.catalog.map((g) => g.info.group).join(', ')}`);
    session.write(c.dim('  exact form:  <group> <subcommand> [--flag value ...]'));
    session.write(c.dim('  plain form:  e.g. "find people software engineer" or "scrape employees at acme"\n'));
    return 'continue';
  }

  const key = rest.map((token) => token.lower).join(' ');
  const exact = session.commands.find((cmd) => `${cmd.group} ${cmd.subcommand}` === key);
  if (exact) {
    printCommandHelp(session, exact);
    return 'continue';
  }
  const groupMatch = session.byGroup.get(key);
  if (groupMatch) {
    session.write(`\n${c.bold(key)} — ${groupMatch.length} commands:`);
    for (const cmd of groupMatch) {
      session.write(`  ${c.cyan(cmd.subcommand.padEnd(16))} ${cmd.description}`);
    }
    session.write('');
    return 'continue';
  }
  const subs = session.commands.filter((cmd) => cmd.subcommand === key);
  if (subs.length === 1) {
    printCommandHelp(session, subs[0]!);
    return 'continue';
  }
  if (subs.length > 1) {
    session.write(`\n'${key}' exists in several groups:`);
    for (const cmd of subs) {
      session.write(`  ${c.cyan(`${cmd.group} ${cmd.subcommand}`)}  ${c.dim(cmd.description)}`);
    }
    session.write('');
    return 'continue';
  }
  session.write(`  ${c.red(`no help for '${key}'`)} — try 'help' or 'browse'`);
  return 'continue';
}

function printCommandHelp(session: ShellSession, cmd: CommandDefinition): void {
  session.write(`\n${c.bold(`${cmd.group} ${cmd.subcommand}`)}  ${c.dim(cmd.description)}`);
  for (const example of cmd.examples ?? []) session.write(`  $ ${example}`);
  const args = cmd.cliMappings.args ?? [];
  if (args.length > 0) {
    session.write(c.bold('  arguments:'));
    for (const arg of args) {
      session.write(`    ${arg.name.padEnd(16)} ${arg.field}${arg.required ? ' (required)' : ' (optional)'}`);
    }
  }
  const options = cmd.cliMappings.options ?? [];
  if (options.length > 0) {
    session.write(c.bold('  options:'));
    for (const option of options) {
      session.write(`    ${option.flags.padEnd(28)} ${option.description ?? ''}`);
    }
  }
  session.write('');
}

/** Exact-command interpretation (§4.3 rule 2): no commander inside the REPL. */
async function handleExactCommand(session: ShellSession, tokens: Token[]): Promise<Verdict> {
  const group = tokens[0]!.lower;
  const list = session.byGroup.get(group)!;
  const sub = tokens[1]?.lower;

  if (!sub) {
    // Bare group name opens that group's list (§4.3 rule 2).
    return doBrowse(session, [tokens[0]!]);
  }
  const cmd = list.find((entry) => entry.subcommand === sub);
  if (!cmd) {
    session.write(`  ${CROSS} ${c.red(`unknown subcommand '${sub}' for '${group}'`)}`);
    session.write(c.dim(`  available: ${list.map((entry) => entry.subcommand).join(', ')}`));
    return 'continue';
  }

  const parsed = parseExactFlags(cmd, tokens.slice(2));
  if (parsed.error || !parsed.input) {
    session.write(`  ${CROSS} ${c.red(parsed.error ?? 'invalid input')}`);
    printCommandHelp(session, cmd);
    return 'continue';
  }

  const input = parsed.input;
  await fillMissingRequired(session, cmd, input);
  return stagingLoop(session, { command: cmd, input, source: 'exact', unclaimed: [] });
}

function parseExactFlags(
  cmd: CommandDefinition,
  tokens: Token[],
): { input?: Record<string, unknown>; error?: string } {
  const input: Record<string, unknown> = {};
  const options = cmd.cliMappings.options ?? [];
  const args = cmd.cliMappings.args ?? [];
  const positional: string[] = [];

  const setValue = (field: string, raw: string): void => {
    input[field] = coerceValue(cmd, field, raw);
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const looksFlag = !token.quoted && token.lower.startsWith('-') && token.lower !== '-' && !/^-\d/.test(token.lower);
    if (looksFlag) {
      const isLong = token.lower.startsWith('--');
      const name = isLong ? token.lower.slice(2) : token.lower.slice(1, 2);
      const display = isLong ? `--${name}` : `-${name}`;
      const option = options.find((o) =>
        isLong ? longFlag(o.flags) === display : (o.flags.split(',')[0] ?? '').trim() === display,
      );
      if (!option) return { error: `unknown option '${display}'` };
      if (flagTakesValue(option.flags)) {
        const next = tokens[i + 1];
        if (!next || (!next.quoted && next.lower.startsWith('--'))) {
          return { error: `option '${display}' requires a value` };
        }
        setValue(option.field, next.raw);
        i++;
      } else {
        const next = tokens[i + 1];
        if (next && !next.quoted && (next.lower === 'true' || next.lower === 'false')) {
          input[option.field] = next.lower === 'true';
          i++;
        } else {
          input[option.field] = true;
        }
      }
      continue;
    }
    positional.push(token.raw);
  }

  let argIndex = 0;
  for (const value of positional) {
    while (argIndex < args.length && input[args[argIndex]!.field] !== undefined) argIndex++;
    if (argIndex >= args.length) return { error: `unexpected argument '${value}'` };
    setValue(args[argIndex]!.field, value);
    argIndex++;
  }
  return { input };
}

/** Missing required params are filled by the guided prompts (§4.3 rule 2). */
async function fillMissingRequired(
  session: ShellSession,
  cmd: CommandDefinition,
  input: Record<string, unknown>,
): Promise<void> {
  const missing = fieldInfos(cmd).filter((f) => f.required && input[f.field] === undefined);
  for (const info of missing) {
    if (info.kind === 'boolean') {
      input[info.field] = await session.prompts.confirm({
        message: `${info.field} (required)?`,
        default: false,
      });
    } else if (info.kind === 'enum' && info.values) {
      input[info.field] = await session.prompts.select({
        message: `${info.field} (required):`,
        choices: info.values.map((value) => ({ name: value, value })),
      });
    } else {
      const answer = await session.prompts.input({ message: `${info.field} (required):` });
      if (answer !== '') input[info.field] = coerceValue(cmd, info.field, answer);
    }
  }
}

/** NLP phrase interpretation (§4.3 rule 3) with ambiguity + memory (§5.3). */
async function handleNlp(session: ShellSession, line: string, tokens: Token[]): Promise<Verdict> {
  const outcome = parse(line, session.commands, session.memory);

  if (outcome.kind === 'refusal') {
    session.write(`  ${c.yellow('?')} ${c.dim('not sure what you mean.')}`);
    session.write(c.dim('  nearest commands:'));
    for (const cmd of outcome.nearest) {
      session.write(`    ${c.cyan(`${cmd.group} ${cmd.subcommand}`)}  ${c.dim(cmd.description)}`);
    }
    session.write(c.dim('  (Tab completes commands; browse lists everything)'));
    return 'continue';
  }

  if (outcome.kind === 'ambiguity') {
    session.write(`  ${c.yellow('?')} ${c.dim('could mean several things:')}`);
    const picked = await session.prompts.select({
      message: 'Which command did you mean?',
      choices: outcome.candidates.map((cmd) => ({
        name: `${cmd.group} ${cmd.subcommand}`,
        value: cmd,
        description: cmd.description,
      })),
    });
    // Remembered for the rest of the session (§5.3) so the same phrase
    // resolves without re-asking.
    session.memory.set(outcome.phrase, picked.name);
    const { input, unclaimed } = extractSlots(picked, tokens, synonymHits(picked, tokens));
    return stagingLoop(session, { command: picked, input, source: 'nlp', unclaimed });
  }

  const parsed = outcome.parsed;
  return stagingLoop(session, {
    command: parsed.command,
    input: parsed.input,
    source: parsed.matched.via,
    unclaimed: parsed.unclaimed,
  });
}

/** Confirm-first staging loop (§6): edit slots, run, cancel, or print raw. */
interface Interpretation {
  command: CommandDefinition;
  input: Record<string, unknown>;
  source: 'exact' | 'nlp' | 'session-memory';
  unclaimed: string[];
}

async function stagingLoop(session: ShellSession, interp: Interpretation): Promise<Verdict> {
  const cmd = interp.command;
  const kebab = (field: string): string => field.replace(/_/g, '-');

  let input = interp.input;
  while (true) {
    const missing = fieldInfos(cmd).filter((f) => f.required && input[f.field] === undefined);
    session.write(`\n  ${c.dim('≡ interpreted as:')} ${c.cyan(renderCommandLine(cmd, input))}`);
    if (interp.unclaimed.length > 0) {
      session.write(`    ${c.dim(`unparsed words: ${interp.unclaimed.join(' ')}`)}`);
    }
    if (missing.length > 0) {
      session.write(`    ${c.dim(`unfilled required: ${missing.map((f) => `--${kebab(f.field)}`).join(', ')}`)}`);
    }
    session.write(`    ${c.dim('⏎ run · <field> <value> · edit · raw · q cancel')}`);

    const line = await session.nextLine();
    if (line === null) return 'exit'; // EOF mid-staging ends the session gracefully
    const answer = line.trim();

    if (answer === '') break; // Enter → run (§6.2)
    if (answer === 'q') return 'continue';
    if (answer === 'raw') {
      session.write(`\n${renderCommandLine(cmd, input)}\n`);
      return 'continue';
    }
    if (answer === 'edit') {
      input = await editInputs(session, cmd, input);
      continue;
    }

    const override = applyStagingOverride(session, cmd, input, answer);
    if (override === 'retry') continue;
    if (override === 'invalid') {
      return stagingLoop(session, { ...interp, input });
    }
  }

  // Validate with the same Zod schema as CLI/MCP (§6.3); failures return
  // to staging with the printed issues.
  const parsed = cmd.inputSchema.safeParse(input);
  if (!parsed.success) {
    const issues = (
      parsed as { error: { issues: Array<{ path: (string | number)[]; message: string }> } }
    ).error.issues.map((issue) => `${issue.path.join('.') || '(input)'}: ${issue.message}`);
    session.write(`  ${CROSS} ${c.red('invalid input:')} ${issues.map((issue) => c.red(issue)).join('; ')}`);
    return stagingLoop(session, { ...interp, input });
  }
  return executeCommand(session, cmd, parsed.data as Record<string, unknown>);
}

/** `<field> <value>` / `--flag value` staging override (§6.2). */
function applyStagingOverride(
  session: ShellSession,
  cmd: CommandDefinition,
  input: Record<string, unknown>,
  answer: string,
): 'applied' | 'retry' | 'invalid' {
  const kebab = (field: string): string => field.replace(/_/g, '-');
  const parts = answer.split(/\s+/);
  const nameRaw = parts[0]!;
  const valueParts = parts.slice(1);
  const field = resolveField(cmd, nameRaw);
  if (!field) {
    session.write(`  ${CROSS} ${c.red(`unknown field '${nameRaw}'`)} — fields for ${cmd.group} ${cmd.subcommand}:`);
    for (const info of fieldInfos(cmd)) {
      const flag = info.flag ?? info.boolFlag ?? `--${kebab(info.field)}`;
      session.write(`    ${c.cyan(flag).padEnd(30)} ${c.dim(info.field)}`);
    }
    return 'invalid';
  }
  if (field.kind === 'enum' && field.values) {
    const value = valueParts.join(' ');
    if (!field.values.includes(value)) {
      session.write(`  ${CROSS} ${c.red(`'${value}'`)} — allowed: ${field.values.join(', ')}`);
      return 'retry';
    }
    input[field.field] = value;
    return 'applied';
  }
  if (field.kind === 'boolean') {
    if (valueParts.length === 0) {
      input[field.field] = true;
      return 'applied';
    }
    const value = valueParts.join(' ').toLowerCase();
    if (['true', 'y', 'yes', '1'].includes(value)) {
      input[field.field] = true;
    } else if (['false', 'n', 'no', '0'].includes(value)) {
      input[field.field] = false;
    } else {
      session.write(`  ${CROSS} ${c.red('boolean field — value must be true/false')}`);
      return 'retry';
    }
    return 'applied';
  }
  if (valueParts.length === 0) {
    session.write(`  ${CROSS} ${c.red(`'${nameRaw}' requires a value`)}`);
    return 'retry';
  }
  input[field.field] = coerceValue(cmd, field.field, valueParts.join(' '));
  return 'applied';
}

function resolveField(cmd: CommandDefinition, nameRaw: string): FieldInfo | undefined {
  const bare = nameRaw.replace(/^-+/, '').toLowerCase();
  return fieldInfos(cmd).find(
    (info) =>
      info.field === bare ||
      info.field.replace(/_/g, '-') === bare ||
      info.flag === `--${bare}` ||
      info.boolFlag === `--${bare}`,
  );
}

/** Guided-prompt walkthrough prefilled with the current values (§6.2 edit). */
async function editInputs(
  session: ShellSession,
  cmd: CommandDefinition,
  current: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const fresh: Record<string, unknown> = { ...current };
  const kebab = (field: string): string => field.replace(/_/g, '-');
  for (const info of fieldInfos(cmd)) {
    const label = info.flag ?? info.boolFlag ?? `--${kebab(info.field)}`;
    if (info.kind === 'boolean') {
      fresh[info.field] = await session.prompts.confirm({
        message: `${label} ${info.field}?`,
        default: current[info.field] === true,
      });
      continue;
    }
    if (info.kind === 'enum' && info.values) {
      const picked = await session.prompts.select<string>({
        message: `${label} ${info.field}:`,
        choices: [
          { name: c.dim('(skip — leave unfilled)'), value: '' },
          ...info.values.map((value) => ({ name: value, value })),
        ],
      });
      if (picked === '') delete fresh[info.field];
      else fresh[info.field] = picked;
      continue;
    }
    const currentRaw = current[info.field] === undefined ? '' : String(current[info.field]);
    const answer = await session.prompts.input({
      message: `${label} ${info.field}${info.required ? ' (required)' : ''}:`,
      default: currentRaw,
    });
    if (answer === '') delete fresh[info.field];
    else fresh[info.field] = coerceValue(cmd, info.field, answer);
  }
  return fresh;
}

/** Execute via the lazy client exactly like the launcher does (§6.4). */
async function executeCommand(
  session: ShellSession,
  cmd: CommandDefinition,
  data: Record<string, unknown>,
): Promise<Verdict> {
  const cmdLine = renderCommandLine(cmd, data);
  if (isWriteCommand(cmd.name)) {
    session.write(`\n  ${c.red('⚠ write command')} ${c.dim('— this changes state on LinkedIn')}`);
    const proceed = await session.prompts.confirm({
      message: `Run ${c.bold(`linkedin ${cmd.group} ${cmd.subcommand}`)}?`,
      default: false,
    });
    if (!proceed) {
      session.write(c.dim('  cancelled.'));
      return 'continue';
    }
  }
  session.write(`\n  ${c.dim('≡ scriptable:')} ${c.cyan(cmdLine)}`);
  const startedAt = Date.now();
  try {
    const client = createLazyClient({});
    const result = await cmd.handler(data, client);
    output(result, { pretty: false });
    const took = ((Date.now() - startedAt) / 1000).toFixed(1);
    session.write(`\n  ${CHECK} ${c.dim(`done in ${took}s`)}`);
  } catch (err) {
    outputError(err, { pretty: true });
  }
  return 'continue';
}

/** Browse mode (§4.6): reuses the launcher's palette machinery, then returns. */
async function doBrowse(session: ShellSession, rest: Token[]): Promise<Verdict> {
  const wanted = rest[0]?.lower;
  if (wanted && session.byGroup.has(wanted)) {
    const group = session.catalog.find((g) => g.info.group === wanted)!;
    return browseGroup(session, group);
  }
  if (wanted) {
    session.write(
      `  ${CROSS} ${c.red(`unknown group '${wanted}'`)} — groups: ${session.catalog.map((g) => g.info.group).join(', ')}`,
    );
    return 'continue';
  }
  const pick = await browseByCategory(
    session.prompts as unknown as Parameters<typeof browseByCategory>[0],
    session.catalog,
  );
  if (isBrowseSentinel(pick)) return 'continue';
  return runEntry(session, pick as CatalogEntry);
}

async function browseGroup(session: ShellSession, group: CatalogGroup): Promise<Verdict> {
  const entry = await session.prompts.select<CatalogEntry | null>({
    message: `${group.info.icon}  ${group.info.tagline}`,
    choices: [
      ...group.commands.map((e) => ({
        name: `${e.command.subcommand} — ${e.command.description}`,
        value: e as CatalogEntry | null,
        description: e.command.examples?.[0] ?? '',
      })),
      { name: c.dim('← back to the prompt'), value: null },
    ],
  });
  if (entry === null) return 'continue';
  return runEntry(session, entry);
}

async function runEntry(session: ShellSession, entry: CatalogEntry): Promise<Verdict> {
  try {
    await executeEntry(
      session.prompts as unknown as Parameters<typeof executeEntry>[0],
      entry,
    );
  } catch (err) {
    if ((err as { name?: string })?.name !== 'ExitPromptError') throw err;
  }
  return 'continue';
}

export interface ShellOptions {
  version: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
}

/** Entry point used by index.ts for `menu`, `shell`, and bare TTY. */
export async function runShell(options: ShellOptions): Promise<void> {
  const mode = resolveShellMode(options.env ?? process.env);
  if (mode === 'classic') {
    const { runInteractiveMenu } = await import('./launcher.js');
    await runInteractiveMenu({ version: options.version });
    return;
  }
  await runShellRepl(options, mode === 'plain');
}

/**
 * The REPL: one readline interface owns stdin (with completer + history on a
 * TTY), a line queue serializes piped input (the v0.2.0 no-hang pattern),
 * and every accepted line is handled before the prompt is redrawn.
 */
async function runShellRepl(options: ShellOptions, forcePlain: boolean): Promise<void> {
  const input = options.input ?? stdin;
  const out = options.output ?? stdout;
  const write = (text: string): void => {
    out.write(`${text}\n`);
  };
  const tty = Boolean((input as { isTTY?: boolean }).isTTY) && !forcePlain;

  const catalog = buildCatalog(allCommands);
  const commands = catalog.flatMap((group) => group.commands.map((entry) => entry.command));
  const config = await loadConfig();
  write(renderShellHeader(options.version, commands.length, Boolean(config)));

  const completionSource = buildCompletionSource(catalog, BUILTINS);
  const rl = createInterface({
    input: input as NodeJS.ReadableStream,
    output: tty ? (out as NodeJS.WriteStream) : undefined,
    terminal: tty,
    completer: tty ? (line: string) => completeLine(line, completionSource) : undefined,
    historySize: 500,
  });
  if (tty) {
    (rl as unknown as { history: string[] }).history = loadHistory();
    rl.setPrompt(PROMPT);
  }

  // Line queue (same pattern as readline-prompts.ts): buffered piped input
  // is handed out in order instead of dropped.
  const pending: string[] = [];
  let ended = false;
  let waiter: ((line: string | null) => void) | null = null;
  rl.on('line', (line: string) => {
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve(line);
    } else {
      pending.push(line);
    }
  });
  rl.on('close', () => {
    ended = true;
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve(null);
    }
  });
  const nextLine = async (): Promise<string | null> => {
    if (pending.length > 0) return pending.shift()!;
    if (ended) return null;
    return new Promise<string | null>((resolve) => {
      waiter = resolve;
    });
  };

  // Ctrl+C clears the line; twice on an empty line exits (§4.7).
  let lastEmptyCtrlC = false;
  rl.on('SIGINT', () => {
    const currentLine = (rl as unknown as { line?: string }).line ?? '';
    if (currentLine.trim() === '') {
      if (lastEmptyCtrlC) {
        rl.close();
        return;
      }
      lastEmptyCtrlC = true;
    } else {
      lastEmptyCtrlC = false;
    }
    rl.write(null, { ctrl: true, name: 'u' });
    rl.prompt();
  });

  const prompts = createShellPrompts({ write, nextLine, tty });
  const session: ShellSession = {
    version: options.version,
    catalog,
    commands,
    byGroup: new Map(),
    memory: new Map(),
    tty,
    write,
    history: [],
    prompts,
    nextLine,
    execSession: (args) => execSessionAction(args),
  };
  for (const command of commands) {
    if (!session.byGroup.has(command.group)) session.byGroup.set(command.group, []);
    session.byGroup.get(command.group)!.push(command);
  }

  let farewell = false;
  const goodbye = (): void => {
    if (!farewell) {
      farewell = true;
      write(`\n${c.cyan('👋')} ${c.dim('goodbye.')}\n`);
    }
  };

  if (tty) rl.prompt();
  try {
    while (true) {
      const line = await nextLine();
      if (line === null) break; // EOF / Ctrl+D exits (§4.7)
      const trimmed = line.trim();
      if (trimmed === '') {
        if (tty) rl.prompt();
        continue;
      }
      session.history.push(trimmed);
      appendHistory(trimmed);
      const verdict = await handleInput(session, trimmed);
      if (verdict === 'exit') break;
      if (tty) rl.prompt();
    }
    goodbye();
  } catch (err) {
    if ((err as { name?: string })?.name === 'ExitPromptError') goodbye();
    else throw err;
  }
  rl.close();
}
