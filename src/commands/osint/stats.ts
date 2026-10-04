/**
 * `linkedin osint stats` — classification statistics across people files
 * (port of osint_stats.py).
 */

import { z } from 'zod';
import type { CommandDefinition } from '../../core/types.js';
import { loadPeopleFile } from '../../osint/orgchart.js';
import {
  classifyAll,
  hierarchyRows,
  divisionRows,
  healthSummary,
  unclassifiedSamples,
} from '../../osint/stats.js';

const inputSchema = z.object({
  files: z.string().describe('Comma-separated people files (JSON/CSV, any toolkit format)'),
  verbose: z.boolean().default(false).describe('Include unclassified title samples'),
});

export const osintStatsCommand: CommandDefinition = {
  name: 'osint_stats',
  group: 'osint',
  subcommand: 'stats',
  description:
    'Classification statistics for people files: hierarchy/division distributions and unclassified samples',
  examples: [
    'linkedin osint stats --file output/classified_acme.json',
    'linkedin osint stats --file a.json,b.csv --verbose',
  ],

  inputSchema,

  cliMappings: {
    options: [
      { field: 'files', flags: '-f, --files <list>', description: 'Comma-separated people files' },
      { field: 'verbose', flags: '-v, --verbose', description: 'Include unclassified samples' },
    ],
  },

  handler: async (input) => {
    const inputAny = input as any as { files: string; verbose: boolean };
    const paths = inputAny.files.split(',').map((p) => p.trim()).filter(Boolean);

    const reports: Array<Record<string, unknown>> = [];
    for (const path of paths) {
      const people = await loadPeopleFile(path);
      const stats = classifyAll(people);
      const health = healthSummary(stats);
      reports.push({
        file: path,
        total: stats.total,
        hierarchy: hierarchyRows(stats).map(([level, count, p]) => ({ level, count, pct: Math.round(p * 10) / 10 })),
        division: divisionRows(stats).map(([division, count, p]) => ({ division, count, pct: Math.round(p * 10) / 10 })),
        health,
        unclassified: inputAny.verbose
          ? {
              hierarchy: unclassifiedSamples(stats, 'hierarchy'),
              division: unclassifiedSamples(stats, 'division'),
            }
          : undefined,
      });
    }

    // Aggregate
    const totals = reports.reduce((sum, r) => sum + (r['total'] as number), 0);
    return { total_people: totals, files: reports.length, reports };
  },
};
