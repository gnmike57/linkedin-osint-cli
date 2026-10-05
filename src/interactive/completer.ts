/*
 * Tab completion for the interactive shell (spec §4.4).
 *
 * - First token: builtin names + group names.
 * - Second token: subcommands of that group.
 * - On `--`: long option names of the current command, derived from
 *   cliMappings.
 * - Values are never completed (no offline value lists for e.g. geo URNs).
 *
 * Pure functions — unit-testable without readline.
 */

import type { CommandDefinition } from '../core/types.js';
import { longFlag } from './catalog.js';
import type { CatalogGroup } from './catalog.js';

export interface CompletionSource {
  builtins: string[];
  groups: string[];
  subcommands: Record<string, string[]>;
  /** Keyed by "<group> <subcommand>" → sorted unique long flags. */
  flags: Record<string, string[]>;
}

export function buildCompletionSource(catalog: CatalogGroup[], builtins: string[]): CompletionSource {
  const subcommands: Record<string, string[]> = {};
  const flags: Record<string, string[]> = {};
  for (const group of catalog) {
    subcommands[group.info.group] = group.commands.map((entry) => entry.command.subcommand);
    for (const entry of group.commands) {
      const command: CommandDefinition = entry.command;
      const key = `${group.info.group} ${command.subcommand}`;
      const longs = (command.cliMappings.options ?? [])
        .map((option) => longFlag(option.flags))
        .filter((flag) => flag.startsWith('--'));
      flags[key] = [...new Set(longs)].sort();
    }
  }
  return { builtins, groups: catalog.map((group) => group.info.group), subcommands, flags };
}

/**
 * readline-style completer: returns the candidate completions for `line`
 * plus the line itself (readline slices off the last word).
 */
export function completeLine(line: string, source: CompletionSource): [string[], string] {
  const endsWithSpace = /\s$/.test(line);
  const parts = line.trim().split(/\s+/).filter(Boolean);
  const fragment = endsWithSpace ? '' : parts[parts.length - 1] ?? '';
  const before = endsWithSpace ? parts : parts.slice(0, -1);
  const byPrefix = (list: string[], prefix: string): string[] =>
    list.filter((value) => value.startsWith(prefix)).sort();

  // First token — or the command position after `help`.
  if (before.length === 0) {
    return [byPrefix([...source.builtins, ...source.groups], fragment), line];
  }
  // `browse <TAB>` completes group names (§4.6 discovery).
  if (before[0] === 'browse' && before.length === 1) {
    return [byPrefix(source.groups, fragment), line];
  }

  const head = before[0] === 'help' ? before.slice(1) : before;

  if (head.length === 0) {
    return [byPrefix(source.groups, fragment), line];
  }
  // `--` fragment → long flags of the current command (§4.4).
  if (fragment.startsWith('-')) {
    const key = head.length >= 2 ? `${head[0]} ${head[1]}` : '';
    return [byPrefix(source.flags[key] ?? [], fragment), line];
  }
  if (head.length === 1) {
    const subs = source.subcommands[head[0]!];
    return subs ? [byPrefix(subs, fragment), line] : [[], line];
  }
  return [[], line];
}
