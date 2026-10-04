/*
 * Interactive launcher — `linkedin menu` (or bare `linkedin` on a TTY).
 *
 * Drives every CommandDefinition through prompts derived from its
 * `cliMappings`, runs it against the lazy client, prints the equivalent
 * scriptable command line, and loops. Session actions (login/status/logout)
 * re-exec the CLI so they keep their full interactive behavior.
 *
 * `@inquirer/prompts` is imported dynamically so importing this module in
 * tests stays prompt-free.
 */

import { spawnSync } from 'node:child_process';
import { allCommands, createLazyClient } from '../commands/index.js';
import { loadConfig, getConfigDir } from '../core/config.js';
import { output, outputError } from '../core/output.js';
import type { CommandDefinition } from '../core/types.js';
import { renderBanner } from './banner.js';
import { c, CHECK, CROSS, ARROW, DOT } from './colors.js';
import {
  buildCatalog,
  flagTakesValue,
  longFlag,
  renderCommandLine,
} from './catalog.js';
import type { CatalogEntry, CatalogGroup } from './catalog.js';

interface Choice<T> {
  name: string;
  value: T;
  description?: string;
}

interface Prompts {
  input(opts: { message: string; default?: string }): Promise<string>;
  confirm(opts: { message: string; default?: boolean }): Promise<boolean>;
  select<T>(opts: { message: string; choices: Array<Choice<T>>; pageSize?: number }): Promise<T>;
  search?<T>(opts: {
    message: string;
    source: (term: string | undefined) => Promise<Array<Choice<T>>>;
    pageSize?: number;
  }): Promise<T>;
}

const EXIT = Symbol('exit');
const BACK = Symbol('back');

type SessionAction = { kind: 'session'; label: string; args: string[] };
type Pick = CatalogEntry | SessionAction | typeof EXIT;

const SESSION_ITEMS: SessionAction[] = [
  { kind: 'session', label: '🔐  Session › login (save cookies)', args: ['login'] },
  { kind: 'session', label: '🔐  Session › login via Chrome import', args: ['login', '--from-chrome'] },
  { kind: 'session', label: '✅  Session › status --verify', args: ['status', '--verify'] },
  { kind: 'session', label: '👋  Session › logout (delete stored cookies)', args: ['logout'] },
];

function isExitSymbol(v: unknown): v is typeof EXIT {
  return v === EXIT;
}

function goodbye(): void {
  console.log(`\n${c.cyan('👋')} ${c.dim('goodbye.')}\n`);
}

function isExitPrompt(err: unknown): boolean {
  return (err as { name?: string })?.name === 'ExitPromptError';
}

/** Field description straight off the zod schema, when present. */
function fieldDescription(cmd: CommandDefinition, field: string): string {
  const schema = cmd.inputSchema.shape[field] as { description?: string } | undefined;
  return schema?.description ?? field.replace(/_/g, ' ');
}

/** Zod field resolves (through ZodDefault/ZodOptional) to a boolean? */
function isBooleanField(cmd: CommandDefinition, field: string): boolean {
  let node: any = cmd.inputSchema.shape[field];
  while (node) {
    const tn: string | undefined = node?._def?.typeName;
    if (tn === 'ZodBoolean') return true;
    if (tn === 'ZodDefault' || tn === 'ZodOptional') {
      node = node._def.innerType;
      continue;
    }
    return false;
  }
  return false;
}

/**
 * Prefer @inquirer/prompts; fall back to the built-in readline console when
 * the package is missing or incomplete (restricted registries, broken
 * installs). The console must always be launchable.
 */
async function loadPrompts(): Promise<Prompts> {
  try {
    const mod = (await import('@inquirer/prompts')) as unknown as Partial<Prompts>;
    if (typeof mod.input === 'function' && typeof mod.confirm === 'function' && typeof mod.select === 'function') {
      return mod as Prompts;
    }
  } catch {
    /* fall through to built-in */
  }
  console.log(
    c.dim('  note: @inquirer/prompts unavailable — using the built-in console fallback\n'),
  );
  const { createFallbackPrompts } = await import('./readline-prompts.js');
  return (await createFallbackPrompts()) as unknown as Prompts;
}

export async function runInteractiveMenu(options: { version: string }): Promise<void> {
  const prompts = await loadPrompts();

  const catalog = buildCatalog(allCommands);
  const totalCommands = catalog.reduce((n, g) => n + g.commands.length, 0);

  console.log(c.blue(renderBanner(options.version)));
  const config = await loadConfig();
  const sessionLine = config
    ? `${c.green('●')} signed in as ${c.bold(config.profile_name ?? 'configured account')} ${c.dim(`(${getConfigDir()})`)}`
    : `${c.yellow('●')} no stored cookies ${DOT} ${c.dim('choose Session › login, or use --li-at/--jsessionid/--from-chrome')}`;
  console.log(`  ${sessionLine}`);
  console.log(`  ${c.dim(`${totalCommands} commands · type to search, or browse by category`)}\n`);

  try {
    while (true) {
      const pick = await pickPalette(prompts, catalog);
      if (isExitSymbol(pick)) {
        goodbye();
        return;
      }
      if (typeof pick === 'object' && pick !== null && 'kind' in pick) {
        runSessionAction(pick as SessionAction);
        continue;
      }
      await executeEntry(prompts, pick as CatalogEntry);
    }
  } catch (err) {
    if (isExitPrompt(err)) {
      goodbye();
      return;
    }
    throw err;
  }
}

const BROWSE = Symbol('browse');
type CategoryPick = CatalogGroup | typeof EXIT;
type GroupPick = CatalogEntry | typeof BACK | typeof EXIT;

async function pickPalette(prompts: Prompts, catalog: CatalogGroup[]): Promise<Pick> {
  const entries = catalog.flatMap((g) => g.commands);

  const source = (term: string | undefined): Choice<Pick | typeof BROWSE>[] => {
    const t = (term ?? '').toLowerCase().trim();
    const head: Choice<Pick | typeof BROWSE>[] = [];
    if (!t) {
      head.push({
        name: c.magenta('📦  Browse by category…'),
        value: BROWSE,
      });
      head.push(
        ...SESSION_ITEMS.map((s) => ({
          name: s.label,
          value: s as Pick | typeof BROWSE,
          description: `linkedin ${s.args.join(' ')}`,
        })),
      );
    }
    const matches = (t ? entries.filter((e) => e.searchText.includes(t)) : entries).map(
      (entry) => ({
        name: `${entry.label}  ${c.dim(DOT)} ${entry.command.description}`,
        value: entry as Pick | typeof BROWSE,
        description: entry.command.examples?.[0] ?? entry.command.description,
      }),
    );
    head.push(...matches.slice(0, 25));
    head.push({ name: c.red('✖  Exit'), value: EXIT });
    return head;
  };

  let choose: () => Promise<Pick | typeof BROWSE>;
  if (typeof prompts.search === 'function') {
    choose = () =>
      prompts.search!<Pick | typeof BROWSE>({
        message: 'What do you want to do? (type to filter)',
        source: async (term) => source(term),
        pageSize: 18,
      });
  } else {
    choose = () =>
      prompts.select<Pick | typeof BROWSE>({
        message: 'What do you want to do?',
        choices: source(undefined),
        pageSize: 18,
      });
  }

  while (true) {
    const picked = await choose();
    if (picked !== BROWSE) return picked as Pick;
    const fromBrowse = await browseByCategory(prompts, catalog);
    if (fromBrowse === BACK) continue;
    return fromBrowse;
  }
}

async function browseByCategory(
  prompts: Prompts,
  catalog: CatalogGroup[],
): Promise<GroupPick> {
  const group = await prompts.select<CategoryPick>({
    message: 'Pick a category:',
    choices: [
      ...catalog.map((g) => ({
        name: `${g.info.icon}  ${g.info.tagline} ${c.dim(`(${g.commands.length})`)} — ${c.gray(
          g.info.hint,
        )}`,
        value: g as CategoryPick,
        description: g.info.hint,
      })),
      { name: c.red('✖  Exit'), value: EXIT as CategoryPick },
    ],
    pageSize: 15,
  });
  if (isExitSymbol(group)) return EXIT;

  return await prompts.select<GroupPick>({
    message: `${group.info.icon}  ${group.info.tagline}`,
    choices: [
      { name: c.dim('← Back'), value: BACK as GroupPick },
      ...group.commands.map((entry) => ({
        name: `${entry.command.subcommand} — ${entry.command.description}`,
        value: entry as GroupPick,
        description: entry.command.examples?.[0] ?? '',
      })),
    ],
    pageSize: 20,
  });
}

function runSessionAction(action: SessionAction): void {
  console.log(`\n${ARROW} ${c.bold(`linkedin ${action.args.join(' ')}`)}\n`);
  const result = spawnSync(process.execPath, [process.argv[1], ...action.args], {
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    console.error(`${CROSS} exited with code ${result.status}`);
  } else {
    console.log(`${CHECK} done`);
  }
}


async function executeEntry(prompts: Prompts, entry: CatalogEntry): Promise<void> {
  const cmd = entry.command;
  console.log(`\n${ARROW} ${c.bold(entry.label)}  ${c.dim(DOT)} ${c.gray(cmd.description)}`);
  if (cmd.examples?.length) {
    console.log(c.dim(`  e.g. ${cmd.examples[0]}`));
  }

  while (true) {
    let input: Record<string, unknown>;
    try {
      input = await collectInput(prompts, cmd);
    } catch (err) {
      if (isExitPrompt(err)) return; // cancelled — back to palette
      throw err;
    }

    const parsed = cmd.inputSchema.safeParse(input);
    if (!parsed.success) {
      const issues = (
        parsed as { error: { issues: Array<{ path: (string | number)[]; message: string }> } }
      ).error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`);
      console.error(`${CROSS} ${c.red('invalid input:')} ${issues.map((i) => c.red(i)).join('; ')}`);
      let retry = true;
      try {
        retry = await prompts.confirm({ message: 'Re-enter the inputs?', default: true });
      } catch (err) {
        if (isExitPrompt(err)) return;
        throw err;
      }
      if (!retry) return;
      continue;
    }

    const cmdLine = renderCommandLine(cmd, parsed.data as Record<string, unknown>);
    console.log(`\n  ${c.dim('≡ scriptable:')} ${c.cyan(cmdLine)}`);

    const startedAt = Date.now();
    try {
      const client = createLazyClient({});
      const result = await cmd.handler(parsed.data, client);
      output(result, { pretty: false });
      const took = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(`\n  ${CHECK} ${c.dim(`done in ${took}s`)}`);
    } catch (err) {
      outputError(err, { pretty: true });
    }
    return;
  }
}

async function collectInput(
  prompts: Prompts,
  cmd: CommandDefinition,
): Promise<Record<string, unknown>> {
  const input: Record<string, unknown> = {};

  for (const arg of cmd.cliMappings.args ?? []) {
    const desc = fieldDescription(cmd, arg.field);
    const message = arg.required ? `${desc} (required):` : `${desc} [optional]:`;
    const value = await prompts.input({ message });
    if (value !== '') input[arg.field] = value;
  }

  for (const opt of cmd.cliMappings.options ?? []) {
    const desc = opt.description ?? fieldDescription(cmd, opt.field);
    const flag = longFlag(opt.flags);
    if (flagTakesValue(opt.flags)) {
      const value = await prompts.input({
        message: `${c.cyan(flag)} ${c.dim(desc)} [blank = skip]:`,
      });
      if (value !== '') input[opt.field] = value;
    } else if (isBooleanField(cmd, opt.field)) {
      input[opt.field] = await prompts.confirm({ message: `${flag} ${desc}?`, default: false });
    } else {
      input[opt.field] = await prompts.confirm({ message: `${flag} ${desc}?`, default: true });
    }
  }

  return input;
}

