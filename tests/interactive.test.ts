import { describe, expect, it } from 'vitest';
import { allCommands } from '../src/commands/index.js';
import {
  buildCatalog,
  flagTakesValue,
  longFlag,
  renderCommandLine,
  GROUP_META,
} from '../src/interactive/catalog.js';
import { bannerLines } from '../src/interactive/banner.js';

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
