/**
 * `linkedin osint classify` — classify job titles with the rules engine
 * (single title, or every person in a toolkit JSON/CSV), optionally with
 * Groq AI enhancement (--use-ai).
 */

import { z } from 'zod';
import type { CommandDefinition } from '../../core/types.js';
import { classifyTitle, RULES } from '../../osint/classify.js';
import { loadPeopleFile, getDivisionColor } from '../../osint/orgchart.js';
import { fileTimestamp, writeOutputFile } from './util.js';

const inputSchema = z.object({
  title: z.string().optional().describe('A single job title to classify'),
  file: z.string().optional().describe('JSON/CSV of people — classifies every "title" field'),
  use_ai: z.boolean().default(false).describe('Enhance with Groq AI (requires GROQ_API_KEY)'),
  out_dir: z.string().default('output').describe('Output directory for file mode'),
});

export const osintClassifyCommand: CommandDefinition = {
  name: 'osint_classify',
  group: 'osint',
  subcommand: 'classify',
  description:
    'Classify job titles into hierarchy levels (Executive…Staff) and divisions (Cyber Security, Finance, ...) using the 30K-profile rules engine',
  examples: [
    'linkedin osint classify --title "Senior Cyber Security Manager"',
    'linkedin osint classify --file output/employees_acme.json',
    'linkedin osint classify --file employees.csv --use-ai',
  ],

  inputSchema,

  cliMappings: {
    options: [
      { field: 'title', flags: '-t, --title <title>', description: 'Single title to classify' },
      { field: 'file', flags: '-f, --file <path>', description: 'JSON/CSV people file to classify' },
      { field: 'use_ai', flags: '--use-ai', description: 'Groq AI enhancement' },
      { field: 'out_dir', flags: '-o, --out-dir <dir>', description: 'Output directory (default: output)' },
    ],
  },

  handler: async (input) => {
    const inputAny = input as any as {
      title?: string;
      file?: string;
      use_ai: boolean;
      out_dir: string;
    };

    // --- Single title mode ---
    if (inputAny.title) {
      const result = classifyTitle(inputAny.title);
      if (!inputAny.use_ai) return { title: inputAny.title, ...result };

      const { isAiAvailable, enhanceClassification } = await import('../../osint/ai-client.js');
      if (!isAiAvailable()) {
        return {
          title: inputAny.title,
          ...result,
          ai_note: 'GROQ_API_KEY not set — keyword rules only',
        };
      }
      const person = { title: inputAny.title, ...result } as unknown as Record<string, unknown>;
      const enhanced = await enhanceClassification(person);
      return { title: inputAny.title, ...enhanced };
    }

    // --- File mode ---
    if (inputAny.file) {
      const people = await loadPeopleFile(inputAny.file);
      if (people.length === 0) {
        return { error: `No people found in ${inputAny.file}`, code: 'EMPTY_INPUT' };
      }

      for (const person of people) {
        const result = classifyTitle(person.title ?? '');
        person.role_level = result.role_level;
        person.role_weight = result.role_weight;
        person.division_name = result.division;
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

      const file = await writeOutputFile(
        inputAny.out_dir,
        `classified_${fileTimestamp()}.json`,
        JSON.stringify(
          {
            generated_at: new Date().toISOString(),
            source: inputAny.file,
            total: people.length,
            people,
          },
          null,
          2,
        ) + '\n',
      );

      const levelCounts: Record<string, number> = {};
      for (const person of people) {
        const level = person.role_level ?? 'Staff';
        levelCounts[level] = (levelCounts[level] ?? 0) + 1;
      }

      return { total: people.length, distribution: levelCounts, file, people };
    }

    return { error: 'Provide --title or --file.', code: 'VALIDATION_ERROR' };
  },
};
