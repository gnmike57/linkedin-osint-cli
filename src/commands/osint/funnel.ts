/**
 * `linkedin osint funnel` — the macro-to-micro pipeline (port of
 * osint_funnel.py), API-native:
 *   Phase 1 DISCOVER   companies by region/keyword/industry
 *   Phase 2 EMPLOYEES  people-search scrape for every discovered company
 *   Phase 3 ORGCHART   classify + build hierarchical org JSON
 *   Phase 4 MATRIX     standalone HTML visualization
 *
 * Each phase writes its own files to out_dir; --input resumes from an
 * existing output (auto-detects format and starting phase).
 */

import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import type { CommandDefinition } from '../../core/types.js';
import { peopleFromJson } from '../../osint/orgchart.js';
import { osintDiscoverCommand } from './discover.js';
import { osintEmployeesCommand } from './employees.js';
import { osintOrgchartCommand } from './orgchart.js';
import { osintMatrixCommand } from './matrix.js';
import { fileTimestamp, writeOutputFile } from './util.js';

const inputSchema = z.object({
  geo: z.string().optional().describe('Region for discovery (phase 1)'),
  keyword: z.string().optional().describe('Keyword for discovery (phase 1)'),
  industry: z.string().optional().describe('Industry filter (phase 1)'),
  limit: z.coerce.number().min(1).max(50).default(5).describe('Max companies (default 5)'),
  depth: z.coerce.number().min(1).max(50).optional().describe('Max pages per employee loop'),
  max_profiles: z.coerce.number().min(1).optional().describe('Max profiles per company'),
  input: z.string().optional().describe('Resume from an existing output file'),
  start_phase: z.coerce.number().min(1).max(4).default(1).describe('Start phase (default 1)'),
  end_phase: z.coerce.number().min(1).max(4).default(4).describe('End phase (default 4)'),
  company: z.string().optional().describe('Organization display name for outputs'),
  use_ai: z.boolean().default(false).describe('AI-enhanced classification (phase 3)'),
  out_dir: z.string().default('output').describe('Output directory'),
});

export const osintFunnelCommand: CommandDefinition = {
  name: 'osint_funnel',
  group: 'osint',
  subcommand: 'funnel',
  description:
    'Run the full OSINT funnel: discover companies → scrape employees → classify + org chart → HTML matrix',
  examples: [
    'linkedin osint funnel --geo USA --keyword cybersecurity --limit 5',
    'linkedin osint funnel --input output/discovered_companies_usa.json --start-phase 2',
    'linkedin osint funnel --input output/employees_acme.json --start-phase 3 --use-ai',
  ],

  inputSchema,

  cliMappings: {
    options: [
      { field: 'geo', flags: '-g, --geo <region>', description: 'Region for discovery (phase 1)' },
      { field: 'keyword', flags: '-k, --keyword <text>', description: 'Keyword for discovery (phase 1)' },
      { field: 'industry', flags: '--industry <category>', description: 'Industry filter (phase 1)' },
      { field: 'limit', flags: '-l, --limit <n>', description: 'Max companies (default 5)' },
      { field: 'depth', flags: '-d, --depth <pages>', description: 'Max pages per employee loop' },
      { field: 'max_profiles', flags: '--max-profiles <n>', description: 'Max profiles per company' },
      { field: 'input', flags: '-i, --input <file>', description: 'Resume from an existing output file' },
      { field: 'start_phase', flags: '--start-phase <n>', description: 'Start phase 1-4 (default 1)' },
      { field: 'end_phase', flags: '--end-phase <n>', description: 'End phase 1-4 (default 4)' },
      { field: 'company', flags: '-c, --company <name>', description: 'Organization display name' },
      { field: 'use_ai', flags: '--use-ai', description: 'AI-enhanced classification (phase 3)' },
      { field: 'out_dir', flags: '-o, --out-dir <dir>', description: 'Output directory (default: output)' },
    ],
  },

  handler: async (input, client) => {
    const args = input as any as {
      geo?: string;
      keyword?: string;
      industry?: string;
      limit: number;
      depth?: number;
      max_profiles?: number;
      input?: string;
      start_phase: number;
      end_phase: number;
      company?: string;
      use_ai: boolean;
      out_dir: string;
    };

    const funnel: Array<Record<string, unknown>> = [];
    const savedFiles: Record<string, string> = {};
    let startPhase = args.start_phase;
    const extra: Record<string, unknown> = {};

    // --- Resume detection ---
    if (args.input) {
      const data = JSON.parse(await readFile(args.input, 'utf-8')) as Record<string, any>;
      const detected = detectPhase(data);
      if (detected > startPhase) startPhase = detected;
      funnel.push({ phase: 'resume', detected_phase: detected, input: args.input });
      if (detected === 2) {
        const slugs = (data.companies ?? [])
          .map((c: Record<string, any>) => extractSlug(String(c.url ?? '')) || slugifyName(String(c.name ?? '')))
          .filter(Boolean);
        extra['slugs'] = slugs;
      }
      if (detected === 3) {
        const people = peopleFromJson(data);
        const master = await writeOutputFile(
          args.out_dir,
          `funnel_people_${fileTimestamp()}.json`,
          JSON.stringify({ generated_at: new Date().toISOString(), total: people.length, people }, null, 2) + '\n',
        );
        savedFiles['people'] = master;
        extra['masterFile'] = master;
      }
      if (detected === 4) {
        savedFiles['org_chart'] = args.input;
      }
    }

    // --- Phase 1: Discover ---
    if (startPhase <= 1 && args.end_phase >= 1) {
      try {
        if (!args.geo) throw new Error('--geo is required for phase 1');
        const result = (await osintDiscoverCommand.handler(
          {
            geo: args.geo,
            keyword: args.keyword,
            industry: args.industry,
            limit: args.limit,
            region_name: args.keyword ?? 'region',
            out_dir: args.out_dir,
            use_ai: false,
          } as never,
          client,
        )) as { count: number; file: string; companies: Array<Record<string, unknown>> };
        savedFiles['discovered'] = result.file;
        if (!extra['slugs']) {
          extra['slugs'] = result.companies
            .map((c) => extractSlug(String(c.url ?? '')) || slugifyName(String(c.name ?? '')))
            .filter(Boolean);
        }
        funnel.push({ phase: 1, name: 'DISCOVER', count: result.count, file: result.file });
      } catch (err) {
        funnel.push({ phase: 1, name: 'DISCOVER', error: (err as Error).message });
        return { funnel, files: savedFiles };
      }
    }

    // --- Phase 2: Employees per company ---
    if (startPhase <= 2 && args.end_phase >= 2) {
      const slugs = (extra['slugs'] as string[] | undefined) ?? [];
      const allPeople: Array<Record<string, unknown>> = [];
      const perCompany: Array<Record<string, unknown>> = [];
      for (const slug of slugs.slice(0, args.limit)) {
        try {
          const result = (await osintEmployeesCommand.handler(
            employeesInput(args, slug),
            client,
          )) as { total: number; employees: Array<Record<string, unknown>>; files: string[] };
          allPeople.push(...result.employees.map((e) => ({ ...e, company: slug })));
          perCompany.push({ company: slug, total: result.total });
          if (result.files[0]) savedFiles[`employees_${slug}`] = result.files[0];
        } catch (err) {
          perCompany.push({ company: slug, error: (err as Error).message });
        }
      }
      funnel.push({ phase: 2, name: 'EMPLOYEES', companies: perCompany, total: allPeople.length });

      if (allPeople.length > 0) {
        const master = await writeOutputFile(
          args.out_dir,
          `funnel_people_${fileTimestamp()}.json`,
          JSON.stringify(
            { generated_at: new Date().toISOString(), total: allPeople.length, people: allPeople },
            null,
            2,
          ) + '\n',
        );
        savedFiles['people'] = master;
        extra['masterFile'] = master;
      } else if (args.end_phase >= 3) {
        funnel.push({ phase: 2, note: 'No people collected — phases 3-4 skipped' });
        return { funnel, files: savedFiles };
      }
    }

    // --- Phase 3: Classify + org chart ---
    if (startPhase <= 3 && args.end_phase >= 3) {
      try {
        const masterFile = (extra['masterFile'] as string | undefined) ?? savedFiles['people'];
        if (!masterFile) throw new Error('No people file available for phase 3');
        const result = (await osintOrgchartCommand.handler(
          {
            file: masterFile,
            company: args.company,
            use_ai: args.use_ai,
            out_dir: args.out_dir,
          } as never,
          client,
        )) as { file: string; total_people: number; total_divisions: number };
        savedFiles['org_chart'] = result.file;
        funnel.push({
          phase: 3,
          name: 'ORGCHART',
          total_people: result.total_people,
          total_divisions: result.total_divisions,
          file: result.file,
        });
      } catch (err) {
        funnel.push({ phase: 3, name: 'ORGCHART', error: (err as Error).message });
        return { funnel, files: savedFiles };
      }
    }

    // --- Phase 4: Matrix HTML ---
    if (startPhase <= 4 && args.end_phase >= 4) {
      try {
        const orgFile = savedFiles['org_chart'];
        if (!orgFile) throw new Error('No org chart file available for phase 4');
        const result = (await osintMatrixCommand.handler(
          { file: orgFile, name: args.company, out_dir: args.out_dir } as never,
          client,
        )) as { file: string };
        savedFiles['matrix'] = result.file;
        funnel.push({ phase: 4, name: 'MATRIX', file: result.file });
      } catch (err) {
        funnel.push({ phase: 4, name: 'MATRIX', error: (err as Error).message });
      }
    }

    return { funnel, files: savedFiles };
  },
};

/** Map funnel CLI args to the employees command's input. */
function employeesInput(args: any, company: string): Record<string, unknown> {
  return {
    company,
    depth: args.depth,
    max_profiles: args.max_profiles,
    out_dir: args.out_dir,
    format: 'json',
    delay_ms: 0,
  };
}

function extractSlug(url: string): string {
  const match = url.match(/linkedin\.com\/company\/([^/?#]+)/);
  return match ? match[1] : '';
}

function slugifyName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Detect which funnel phase an existing output file corresponds to. */
export function detectPhase(data: unknown): number {
  const obj = data as Record<string, any> | null;
  if (obj && typeof obj === 'object') {
    if (Array.isArray(obj.divisions)) return 4; // org chart JSON → matrix only
    if (Array.isArray(obj.companies) && obj.companies.some((c: any) => Array.isArray(c?.people))) {
      return 3; // batch people → classify
    }
    if (Array.isArray(obj.companies)) return 2; // discovered companies → scrape
    if (Array.isArray(obj.people)) return 3;
  }
  return 1;
}
