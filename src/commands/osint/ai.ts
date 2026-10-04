/**
 * `linkedin osint ai-score` / `osint ai-classify` — direct access to the Groq
 * AI enhancer levels from the legacy toolkit's osint_classify_ai.py.
 */

import { z } from 'zod';
import type { CommandDefinition } from '../../core/types.js';
import { loadPeopleFile } from '../../osint/orgchart.js';
import { fileTimestamp, writeOutputFile } from './util.js';

const scoreSchema = z.object({
  file: z.string().describe('Companies JSON (e.g., discovered_companies_*.json)'),
  objective: z.string().describe('Research objective (free text)'),
  out_dir: z.string().default('output').describe('Output directory'),
});

export const osintAiScoreCommand: CommandDefinition = {
  name: 'osint_ai-score',
  group: 'osint',
  subcommand: 'ai-score',
  description:
    'Score discovered companies for relevance to a research objective with Groq AI (macro level)',
  examples: [
    'linkedin osint ai-score --file output/discovered_companies_usa.json --objective "SOC teams for defense research"',
  ],

  inputSchema: scoreSchema,

  cliMappings: {
    options: [
      { field: 'file', flags: '-f, --file <path>', description: 'Companies JSON file' },
      { field: 'objective', flags: '-j, --objective <text>', description: 'Research objective (required)' },
      { field: 'out_dir', flags: '-o, --out-dir <dir>', description: 'Output directory' },
    ],
  },

  handler: async (input) => {
    const inputAny = input as any as { file: string; objective: string; out_dir: string };

    const { readFile } = await import('node:fs/promises');
    const data = JSON.parse(await readFile(inputAny.file, 'utf-8')) as {
      companies?: Array<Record<string, unknown>>;
    };
    const companies = data.companies ?? [];
    if (companies.length === 0) {
      return { error: `No companies found in ${inputAny.file}`, code: 'EMPTY_INPUT' };
    }

    const { scoreCompanies } = await import('../../osint/ai-client.js');
    const scored = await scoreCompanies(companies as never, inputAny.objective);

    const file = await writeOutputFile(
      inputAny.out_dir,
      `ai_scored_companies_${fileTimestamp()}.json`,
      JSON.stringify({ objective: inputAny.objective, companies: scored }, null, 2) + '\n',
    );

    return {
      objective: inputAny.objective,
      total: scored.length,
      file,
      companies: scored.map((c) => ({
        name: c.name,
        score: c.ai_relevance_score,
        reasoning: c.ai_reasoning,
      })),
    };
  },
};

const classifySchema = z.object({
  file: z.string().describe('People JSON/CSV file'),
  out_dir: z.string().default('output').describe('Output directory'),
});

export const osintAiClassifyCommand: CommandDefinition = {
  name: 'osint_ai-classify',
  group: 'osint',
  subcommand: 'ai-classify',
  description:
    'Enhance classification for many people with Groq AI (title-only, batched; medium level)',
  examples: [
    'linkedin osint ai-classify --file output/employees_acme.json',
  ],

  inputSchema: classifySchema,

  cliMappings: {
    options: [
      { field: 'file', flags: '-f, --file <path>', description: 'People JSON/CSV file' },
      { field: 'out_dir', flags: '-o, --out-dir <dir>', description: 'Output directory' },
    ],
  },

  handler: async (input) => {
    const inputAny = input as any as { file: string; out_dir: string };

    const people = await loadPeopleFile(inputAny.file);
    if (people.length === 0) {
      return { error: `No people found in ${inputAny.file}`, code: 'EMPTY_INPUT' };
    }

    // Seed keyword classifications so AI promotion logic has a baseline
    const { classifyTitle, RULES } = await import('../../osint/classify.js');
    const { getDivisionColor } = await import('../../osint/orgchart.js');
    for (const person of people) {
      const result = classifyTitle(person.title ?? '');
      person.role_level = result.role_level;
      person.role_weight = result.role_weight;
      person.division_name = result.division;
      person.division_color = getDivisionColor(result.division);
    }

    const { enhanceClassificationsBatch } = await import('../../osint/ai-client.js');
    const enhanced = await enhanceClassificationsBatch(people as unknown as Array<Record<string, unknown>>);

    const file = await writeOutputFile(
      inputAny.out_dir,
      `ai_classified_${fileTimestamp()}.json`,
      JSON.stringify({ generated_at: new Date().toISOString(), total: enhanced.length, people: enhanced }, null, 2) + '\n',
    );

    const promoted = enhanced.filter(
      (p) => p.ai_promoted_level || p.ai_promoted_division,
    ).length;

    return {
      total: enhanced.length,
      ai_promoted: promoted,
      file,
      people: enhanced,
      rules_version: RULES.meta.version,
    };
  },
};
