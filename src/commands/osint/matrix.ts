/**
 * `linkedin osint matrix` — generate the standalone HTML org chart matrix
 * (port of osint_generate_html.py). Accepts an org chart JSON or any people
 * file (classified on the fly).
 */

import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import type { CommandDefinition } from '../../core/types.js';
import { buildMatrixHtml } from '../../osint/matrix.js';
import { fileTimestamp, writeOutputFile } from './util.js';

const inputSchema = z.object({
  file: z.string().describe('Org chart JSON or people CSV/JSON file'),
  name: z.string().optional().describe('Display name for the organization'),
  out_dir: z.string().default('output').describe('Output directory'),
});

export const osintMatrixCommand: CommandDefinition = {
  name: 'osint_matrix',
  group: 'osint',
  subcommand: 'matrix',
  description:
    'Generate the standalone HTML matrix org chart (tiers x departments, avatars, search) — opens in any browser',
  examples: [
    'linkedin osint matrix --file output/org_chart_2026.json',
    'linkedin osint matrix --file employees_acme.json --name "Acme Corp"',
  ],

  inputSchema,

  cliMappings: {
    options: [
      { field: 'file', flags: '-f, --file <path>', description: 'Org chart JSON or people file (required)' },
      { field: 'name', flags: '-n, --name <label>', description: 'Organization display name' },
      { field: 'out_dir', flags: '-o, --out-dir <dir>', description: 'Output directory (default: output)' },
    ],
  },

  handler: async (input) => {
    const inputAny = input as any as {
      file: string;
      name?: string;
      out_dir: string;
    };

    const text = await readFile(inputAny.file, 'utf-8');
    const data = JSON.parse(text) as unknown;

    const html = buildMatrixHtml(data, { rootLabel: inputAny.name });
    const file = await writeOutputFile(
      inputAny.out_dir,
      `org_chart_matrix_${fileTimestamp()}.html`,
      html,
    );

    return { file, note: 'Open the HTML in a browser, or load the JSON into assets/org_chart_viewer.html' };
  },
};
