/**
 * `linkedin osint scan` — scan a directory of toolkit JSON files, classify
 * every title, and suggest new title_overrides for classification_rules.json
 * (port of osint_scan.py). Suggestions are never applied automatically.
 */

import { z } from 'zod';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandDefinition } from '../../core/types.js';
import { peopleFromJson } from '../../osint/orgchart.js';
import { writeOutputFile } from './util.js';
import {
  classifyAll,
  hierarchyRows,
  divisionRows,
  healthSummary,
  unclassifiedSamples,
  suggestOverrides,
} from '../../osint/stats.js';

/** Aggregate/metadata files that are not per-company scraped data. */
const SKIP_PREFIXES = [
  'all_companies_people_',
  'all_companies_classified_',
  'org_chart_',
  'deep_dive_',
  'discovered_companies_',
  'email_lookup_',
  'classified_',
  'funnel_state_',
];

const inputSchema = z.object({
  directory: z.string().describe('Directory containing toolkit JSON files (e.g., output/)'),
  suggest: z.coerce.number().min(0).default(25).describe('Top N override suggestions'),
  json_suggest: z.string().optional().describe('Write suggestions JSON to this file'),
});

export const osintScanCommand: CommandDefinition = {
  name: 'osint_scan',
  group: 'osint',
  subcommand: 'scan',
  description:
    'Scan a results directory and report classification health plus suggested title_overrides for the rules JSON',
  examples: [
    'linkedin osint scan --directory output/',
    'linkedin osint scan --directory results/ --suggest 50 --json-suggest overrides.json',
  ],

  inputSchema,

  cliMappings: {
    options: [
      { field: 'directory', flags: '-d, --directory <dir>', description: 'Directory with toolkit JSON files' },
      { field: 'suggest', flags: '--suggest <n>', description: 'Top N suggestions (default 25)' },
      { field: 'json_suggest', flags: '--json-suggest <file>', description: 'Write suggestions JSON to file' },
    ],
  },

  handler: async (input) => {
    const inputAny = input as any as {
      directory: string;
      suggest: number;
      json_suggest?: string;
    };

    const entries = await readdir(inputAny.directory);
    const jsonFiles = entries.filter(
      (f) => f.endsWith('.json') && !SKIP_PREFIXES.some((p) => f.startsWith(p)),
    );

    const people = [];
    let filesLoaded = 0;
    for (const fname of jsonFiles) {
      try {
        const data = JSON.parse(await readFile(join(inputAny.directory, fname), 'utf-8'));
        people.push(...peopleFromJson(data));
        filesLoaded++;
      } catch {
        // Skip unreadable/invalid files like the original scanner
      }
    }

    if (people.length === 0) {
      return {
        directory: inputAny.directory,
        files_loaded: filesLoaded,
        total: 0,
        note: 'No titles found. Nothing to scan.',
      };
    }

    const stats = classifyAll(people);
    const health = healthSummary(stats);
    const suggestions = suggestOverrides(stats, inputAny.suggest || inputAny.suggest === 0 ? inputAny.suggest : 25);

    const result: Record<string, unknown> = {
      directory: inputAny.directory,
      files_loaded: filesLoaded,
      total: stats.total,
      hierarchy: hierarchyRows(stats).map(([level, count, p]) => ({ level, count, pct: Math.round(p * 10) / 10 })),
      division: divisionRows(stats).map(([division, count, p]) => ({ division, count, pct: Math.round(p * 10) / 10 })),
      health,
      unclassified: {
        hierarchy: unclassifiedSamples(stats, 'hierarchy', 15),
        division: unclassifiedSamples(stats, 'division', 15),
      },
      suggestions,
    };

    if (inputAny.json_suggest) {
      const { dirname, basename } = await import('node:path');
      const dir = dirname(inputAny.json_suggest);
      const name = basename(inputAny.json_suggest);
      const file = await writeOutputFile(
        dir === '.' ? '.' : dir,
        name,
        JSON.stringify({ suggestions }, null, 2) + '\n',
      );
      result['suggestions_file'] = file;
    }
    return result;
  },
};
