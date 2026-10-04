/**
 * `linkedin osint names` — generate username/email permutation lists from a
 * name or an employees file (port of linkedin2username's output writer).
 */

import { z } from 'zod';
import type { CommandDefinition } from '../../core/types.js';
import { NameMutator, FORMAT_SUFFIXES, NAME_FORMATS } from '../../osint/names.js';
import { loadPeopleFile } from '../../osint/orgchart.js';
import { readFile } from 'node:fs/promises';
import { writeUsernameFiles } from './employees.js';

const inputSchema = z.object({
  name: z.string().optional().describe('A single full name to mutate'),
  file: z.string().optional().describe('Employees JSON or a plain names .txt file'),
  domain: z.string().optional().describe('Append @domain to every username'),
  prefix: z.string().default('names').describe('Output filename prefix'),
  out_dir: z.string().default('output').describe('Output directory'),
});

export const osintNamesCommand: CommandDefinition = {
  name: 'osint_names',
  group: 'osint',
  subcommand: 'names',
  description:
    'Generate username lists (flast, f.last, firstl, first.last, first, lastf) from a name or employees file',
  examples: [
    'linkedin osint names --name "John Smith" --domain acme.com',
    'linkedin osint names --file output/employees_acme.json --prefix acme',
  ],

  inputSchema,

  cliMappings: {
    options: [
      { field: 'name', flags: '-n, --name <name>', description: 'Single full name' },
      { field: 'file', flags: '-f, --file <path>', description: 'Employees JSON or names .txt file' },
      { field: 'domain', flags: '-d, --domain <domain>', description: 'Append @domain to usernames' },
      { field: 'prefix', flags: '-p, --prefix <name>', description: 'Output filename prefix (default: names)' },
      { field: 'out_dir', flags: '-o, --out-dir <dir>', description: 'Output directory (default: output)' },
    ],
  },

  handler: async (input) => {
    const inputAny = input as any as {
      name?: string;
      file?: string;
      domain?: string;
      prefix: string;
      out_dir: string;
    };

    let employees: Array<{ full_name: string; occupation: string }> = [];

    if (inputAny.name) {
      employees = [{ full_name: inputAny.name, occupation: '' }];
    } else if (inputAny.file) {
      const text = await readFile(inputAny.file, 'utf-8');
      const trimmed = text.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        const people = await loadPeopleFile(inputAny.file);
        employees = people.map((p) => ({ full_name: p.name, occupation: p.title ?? '' }));
      } else {
        employees = trimmed
          .split(/\r?\n/)
          .filter((l) => l.trim().length > 0)
          .map((l) => ({ full_name: l.trim(), occupation: '' }));
      }
    } else {
      return { error: 'Provide --name or --file.', code: 'VALIDATION_ERROR' };
    }

    const domain = inputAny.domain ? `@${inputAny.domain.replace(/^@/, '')}` : '';
    const files = await writeUsernameFiles(inputAny.prefix, domain, employees, inputAny.out_dir);

    // Preview of the first name's mutations (handy for single-name mode)
    const preview = employees[0] ? new NameMutator(employees[0].full_name).allFormats() : {};

    return {
      names: employees.length,
      domain: domain || undefined,
      files,
      preview,
    };
  },
};

// Re-export for consumers that want the suffix map
export { FORMAT_SUFFIXES, NAME_FORMATS };
