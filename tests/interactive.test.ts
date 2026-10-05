import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { allCommands } from '../src/commands';
import {
  buildCatalog,
  flagTakesValue,
  longFlag,
  renderCommandLine,
  GROUP_META,
} from '../src/interactive/catalog.js';
import { bannerLines } from '../src/interactive/banner.js';
import { createFallbackPrompts, parseSelection, resolvePromptsPreference } from '../src/interactive/readline-prompts.js';
import { buildCompletionSource, completeLine } from '../src/interactive/completer.js';

describe('interactive catalog', () => {
  const catalog = buildCatalog(allCommands);

  it('covers every command group with a non-empty icon and tagline', () => {
    const groups = new Set(allCommands.map((c) => c.group));
    const covered = new Set(catalog.map((g) => g.info.group));
    expect([...groups].sort()).toEqual([...covered].sort());
    for (const g of catalog) {
      expect(g.info.icon.length).toBeGreaterThan(0);
      expect(g.info.tagline.length).toBeGreaterThan(0);
      expect(g.info.group in GROUP_META).toBe(true);
    }
  });

  it('lists every command exactly once with a label and searchable text', () => {
    const entries = catalog.flatMap((g) => g.commands);
    expect(entries).toHaveLength(allCommands.length);
    const seen = new Set<string>();
    for (const entry of entries) {
      const key = `${entry.command.group}/${entry.command.subcommand}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      expect(entry.label).toContain(entry.command.subcommand);
      expect(entry.searchText).toContain(entry.command.group);
      expect(entry.searchText).toContain(entry.command.subcommand);
      expect(entry.searchText).toBe(entry.searchText.toLowerCase());
    }
  });

  it('keeps GROUP_META ordering first, unknown groups appended sorted', () => {
    const names = catalog.map((g) => g.info.group);
    expect(names[0]).toBe('profile');
    expect(names).toContain('osint');
  });
});

describe('flag helpers', () => {
  it('detects value-taking flags', () => {
    expect(flagTakesValue('--count <n>')).toBe(true);
    expect(flagTakesValue('-l, --limit <number>')).toBe(true);
    expect(flagTakesValue('--geo [urn]')).toBe(true);
    expect(flagTakesValue('--geoblast')).toBe(false);
    expect(flagTakesValue('-g, --geoblast')).toBe(false);
  });

  it('extracts the long flag name', () => {
    expect(longFlag('-l, --limit <number>')).toBe('--limit');
    expect(longFlag('--use-ai')).toBe('--use-ai');
  });
});

describe('renderCommandLine', () => {
  const fake = {
    name: 'profile_view',
    group: 'profile',
    subcommand: 'view',
    description: 'View a profile',
    inputSchema: allCommands[0].inputSchema,
    cliMappings: {
      args: [{ field: 'public_id', name: 'public-id', required: true }],
      options: [
        { field: 'verbose', flags: '--verbose' },
        { field: 'count', flags: '--count <n>' },
      ],
    },
    handler: async () => ({}),
  };

  it('renders positional args, boolean flags, and value flags', () => {
    const line = renderCommandLine(fake, { public_id: 'johndoe', verbose: true, count: 20 });
    expect(line).toBe('linkedin profile view johndoe --verbose --count 20');
  });

  it('skips empty/false values and quotes spaces', () => {
    const line = renderCommandLine(fake, { public_id: 'Jane Doe', verbose: false, count: '' });
    expect(line).toBe('linkedin profile view "Jane Doe"');
  });
});

describe('banner', () => {
  it('renders with the provided version', () => {
    const lines = bannerLines('9.9.9');
    expect(lines.length).toBeGreaterThan(5);
    expect(lines.join('\n')).toContain('v9.9.9');
    // genuine block-art content
    expect(lines[1]).toContain('██╗');
  });
});

describe('built-in fallback console (readline)', () => {
  it('parses 1-based numeric selections with bounds checks', () => {
    expect(parseSelection('1', 3)).toBe(0);
    expect(parseSelection(' 3 ', 3)).toBe(2);
    expect(parseSelection('0', 3)).toBeNull();
    expect(parseSelection('4', 3)).toBeNull();
    expect(parseSelection('abc', 3)).toBeNull();
    expect(parseSelection('', 3)).toBeNull();
  });

  it('never drops buffered lines and unwinds cleanly at EOF', async () => {
    // Regression: piped input arrives in one burst; every line must be handed
    // out in order (the old rl.question() implementation dropped them).
    const input = new PassThrough();
    const prompts = await createFallbackPrompts({ input });
    input.write('anything\n1\nhello\ny\n');
    input.end();

    const picked = await prompts.search<string>({
      message: 'filter',
      source: async () => [
        { name: 'A', value: 'A' },
        { name: 'B', value: 'B' },
      ],
    });
    expect(picked).toBe('A'); // choice "1"

    await expect(prompts.input({ message: 'text' })).resolves.toBe('hello');
    await expect(prompts.confirm({ message: 'ok?' })).resolves.toBe(true);
    await expect(prompts.input({ message: 'after EOF' })).rejects.toMatchObject({
      name: 'ExitPromptError',
    });
  });

  it('resolves the LINKEDIN_PROMPTS preference', () => {
    const env = (v?: string) => ({ ...(v === undefined ? {} : { LINKEDIN_PROMPTS: v }) }) as NodeJS.ProcessEnv;
    expect(resolvePromptsPreference(env())).toBe('auto');
    expect(resolvePromptsPreference(env(''))).toBe('auto');
    expect(resolvePromptsPreference(env('nonsense'))).toBe('auto');
    expect(resolvePromptsPreference(env('fallback'))).toBe('fallback');
    expect(resolvePromptsPreference(env('BUILTIN'))).toBe('fallback');
    expect(resolvePromptsPreference(env('readline'))).toBe('fallback');
    expect(resolvePromptsPreference(env('inquirer'))).toBe('inquirer');
  });

  it('retries invalid selections then gives up cleanly', async () => {
    const input = new PassThrough();
    const prompts = await createFallbackPrompts({ input });
    input.write('nope\n2\n');
    input.end();
    const picked = await prompts.select<string>({
      message: 'pick',
      choices: [
        { name: 'one', value: '1' },
        { name: 'two', value: '2' },
      ],
    });
    expect(picked).toBe('2');
  });
});

describe('shell tab completer (spec §4.4)', () => {
  const source = buildCompletionSource(buildCatalog(allCommands), [
    'help', 'browse', 'menu', 'history', 'clear', 'status', 'login', 'logout', 'exit', 'quit',
  ]);

  it('offers builtins and groups on the first token', () => {
    const [hits, echo] = completeLine('', source);
    expect(hits).toContain('help');
    expect(hits).toContain('profile');
    expect(hits).toContain('osint');
    expect(echo).toBe('');
  });

  it('completes group prefixes', () => {
    expect(completeLine('prof', source)[0]).toEqual(['profile']);
    expect(completeLine('osint c', source)).toBeDefined();
  });

  it('completes subcommands after a group', () => {
    const [hits] = completeLine('profile ', source);
    expect(hits).toEqual(expect.arrayContaining(['view', 'me', 'posts', 'contact-info']));
    expect(completeLine('profile co', source)[0]).toEqual(['contact-info']);
  });

  it('completes long flags of the current command on `--`', () => {
    const [hits] = completeLine('search people --', source);
    expect(hits).toEqual(expect.arrayContaining(['--keywords', '--network', '--limit']));
    expect(completeLine('search people --key', source)[0]).toEqual(['--keywords']);
    expect(completeLine('osint employees --g', source)[0]).toEqual(['--geo', '--geoblast']);
  });

  it('completes group names after `browse`', () => {
    expect(completeLine('browse os', source)[0]).toEqual(['osint']);
    expect(completeLine('browse ', source)[0]).toEqual(expect.arrayContaining(['profile', 'osint']));
  });

  it('returns nothing for unknown groups or deeper tokens', () => {
    expect(completeLine('foo ', source)[0]).toEqual([]);
    expect(completeLine('profile view johndoe ', source)[0]).toEqual([]);
  });
});

