/*
 * Interactive catalog — the data model behind `linkedin menu` / bare
 * `linkedin`. Pure functions (no inquirer) so they are unit-testable.
 */

import type { CommandDefinition } from '../core/types.js';

export interface CatalogGroupInfo {
  group: string;
  icon: string;
  /** Short verb phrase for the menu row. */
  tagline: string;
  /** One-line description under the tagline. */
  hint: string;
}

/** Presentation metadata per CLI group (not behavior — order is stable). */
export const GROUP_META: Record<string, CatalogGroupInfo> = {
  profile: {
    group: 'profile',
    icon: '👤',
    tagline: 'Profiles',
    hint: 'View me/others, skills, badges, network, posts, privacy, disconnect',
  },
  feed: {
    group: 'feed',
    icon: '🗞️ ',
    tagline: 'Feed',
    hint: 'Timeline view, user & company feeds',
  },
  posts: {
    group: 'posts',
    icon: '📝',
    tagline: 'Posts',
    hint: 'Create (text/image), edit, delete your posts',
  },
  engage: {
    group: 'engage',
    icon: '💖',
    tagline: 'Engagement',
    hint: 'React, comment, list reactions/comments, share',
  },
  connections: {
    group: 'connections',
    icon: '🤝',
    tagline: 'Connections',
    hint: 'Send / accept / reject / withdraw invitations, list pending',
  },
  messaging: {
    group: 'messaging',
    icon: '✉️ ',
    tagline: 'Messaging',
    hint: 'Conversations, send messages, mark read',
  },
  search: {
    group: 'search',
    icon: '🔍',
    tagline: 'Search',
    hint: 'People / companies / jobs with filters; posts explained',
  },
  companies: {
    group: 'companies',
    icon: '🏢',
    tagline: 'Companies',
    hint: 'View company profiles, follow / unfollow',
  },
  jobs: {
    group: 'jobs',
    icon: '💼',
    tagline: 'Jobs',
    hint: 'Job posting details and skill-match insights',
  },
  analytics: {
    group: 'analytics',
    icon: '📊',
    tagline: 'Analytics',
    hint: 'Who viewed your profile',
  },
  osint: {
    group: 'osint',
    icon: '🕵️ ',
    tagline: 'OSINT toolkit',
    hint: 'Discover companies, scrape employees, names, classify, orgcharts, matrix, funnel, email lookup',
  },
};

export interface CatalogEntry {
  command: CommandDefinition;
  /** Display label for the palette, e.g. "Profiles › view" */
  label: string;
  /** Searchable haystack for the fuzzy palette. */
  searchText: string;
}

export interface CatalogGroup {
  info: CatalogGroupInfo;
  commands: CatalogEntry[];
}

const FALLBACK_META = (group: string): CatalogGroupInfo => ({
  group,
  icon: '▸',
  tagline: group[0]?.toUpperCase() + group.slice(1),
  hint: '',
});

/** Group all command definitions in GROUP_META order, extras appended. */
export function buildCatalog(commands: CommandDefinition[]): CatalogGroup[] {
  const byGroup = new Map<string, CommandDefinition[]>();
  for (const cmd of commands) {
    if (!byGroup.has(cmd.group)) byGroup.set(cmd.group, []);
    byGroup.get(cmd.group)!.push(cmd);
  }

  const orderedGroups = [
    ...Object.keys(GROUP_META).filter((group) => byGroup.has(group)),
    ...[...byGroup.keys()].filter((group) => !(group in GROUP_META)).sort(),
  ];

  return orderedGroups.map((group) => ({
    info: GROUP_META[group] ?? FALLBACK_META(group),
    commands: byGroup.get(group)!.map((command) => ({
      command,
      label: `${(GROUP_META[group] ?? FALLBACK_META(group)).tagline} › ${command.subcommand}`,
      searchText: `${command.group} ${command.subcommand} ${command.name} ${command.description}`.toLowerCase(),
    })),
  }));
}

/** Does a CLI flag string take a value? `--count <n>` yes; `--remote` no. */
export function flagTakesValue(flags: string): boolean {
  return /[<\[][^>\]]+[>\]]/.test(flags);
}

/** Long-flag name for display/args rendering: `-l, --limit <n>` → `--limit`. */
export function longFlag(flags: string): string {
  return (flags.match(/--[a-z0-9-]+/)?.[0] ?? flags).trim();
}

/** Shell-safe single argument rendering. */
export function shellQuote(value: string): string {
  return /^[\w./:@=-]+$/.test(value) ? value : JSON.stringify(value);
}

/**
 * Render the equivalent non-interactive CLI command line for a given input —
 * shown before execution so users learn the scriptable form.
 */
export function renderCommandLine(
  cmd: CommandDefinition,
  input: Record<string, unknown>,
): string {
  const parts: string[] = ['linkedin', cmd.group, cmd.subcommand];
  for (const arg of cmd.cliMappings.args ?? []) {
    const value = input[arg.field];
    if (value !== undefined && value !== '') parts.push(shellQuote(String(value)));
  }
  for (const opt of cmd.cliMappings.options ?? []) {
    const value = input[opt.field];
    if (value === undefined || value === '' || value === false) continue;
    const flag = longFlag(opt.flags);
    if (flagTakesValue(opt.flags)) {
      parts.push(`${flag} ${shellQuote(String(value))}`);
    } else if (value === true) {
      parts.push(flag);
    }
  }
  return parts.join(' ');
}
