/**
 * `linkedin osint orgchart` — build hierarchical org chart JSON from a
 * people CSV/JSON (port of osint_build_orgchart.py), optionally AI-enhanced.
 */

import { z } from 'zod';
import type { CommandDefinition } from '../../core/types.js';
import {
  loadPeopleFile,
  dedupeByName,
  buildHierarchicalData,
  getDivisionColor,
} from '../../osint/orgchart.js';
import { RULES } from '../../osint/classify.js';
import { fileTimestamp, writeOutputFile } from './util.js';

const inputSchema = z.object({
  file: z.string().describe('People CSV or JSON file (any toolkit format)'),
  company: z.string().optional().describe('Display name for the organization'),
  use_ai: z.boolean().default(false).describe('Enhance classification with Groq AI'),
  out_dir: z.string().default('output').describe('Output directory'),
});

export const osintOrgchartCommand: CommandDefinition = {
  name: 'osint_orgchart',
  group: 'osint',
  subcommand: 'orgchart',
  description:
    'Build hierarchical org chart JSON (divisions x hierarchy levels) from a people file; feed it to osint matrix or the viewer',
  examples: [
    'linkedin osint orgchart --file output/employees_acme.json',
    'linkedin osint orgchart --file linkedin_company_acme.csv --company "Acme Corp" --use-ai',
  ],

  inputSchema,

  cliMappings: {
    options: [
      { field: 'file', flags: '-f, --file <path>', description: 'People CSV or JSON file (required)' },
      { field: 'company', flags: '-c, --company <name>', description: 'Organization display name' },
      { field: 'use_ai', flags: '--use-ai', description: 'Groq AI enhancement' },
      { field: 'out_dir', flags: '-o, --out-dir <dir>', description: 'Output directory (default: output)' },
    ],
  },

  handler: async (input) => {
    const inputAny = input as any as {
      file: string;
      company?: string;
      use_ai: boolean;
      out_dir: string;
    };

    let people = await loadPeopleFile(inputAny.file);
    if (people.length === 0) {
      return { error: `No people found in ${inputAny.file}`, code: 'EMPTY_INPUT' };
    }
    people = dedupeByName(people);

    for (const person of people) {
      const result = (await import('../../osint/classify.js')).classifyTitle(person.title ?? '');
      person.role_level = result.role_level;
      person.role_weight = result.role_weight;
      person.division_name = result.division;
      person.division_color = getDivisionColor(result.division);
    }

    if (inputAny.use_ai) {
      const { isAiAvailable, enhanceClassificationsBatch } = await import('../../osint/ai-client.js');
      if (isAiAvailable()) {
        await enhanceClassificationsBatch(people as unknown as Array<Record<string, unknown>>);
        for (const person of people) {
          if (person.ai_promoted_level || person.ai_promoted_division) {
            person.role_weight =
              RULES.hierarchy_levels[String(person.role_level ?? 'Staff')] ?? RULES.hierarchy_levels['Staff'];
            person.division_color = getDivisionColor(String(person.division_name ?? 'General'));
          }
        }
      }
    }

    const divisions = buildHierarchicalData(people);
    const withImages = people.filter((p) => p.profile_image_url).length;

    const file = await writeOutputFile(
      inputAny.out_dir,
      `org_chart_${fileTimestamp()}.json`,
      JSON.stringify(
        {
          generated_at: new Date().toISOString(),
          company_name: inputAny.company,
          total_people: people.length,
          total_with_images: withImages,
          total_divisions: divisions.length,
          divisions,
        },
        null,
        2,
      ) + '\n',
    );

    return {
      total_people: people.length,
      total_divisions: divisions.length,
      divisions: divisions.map((d) => ({
        name: d['name'],
        total_people: d['total_people'],
      })),
      file,
    };
  },
};
