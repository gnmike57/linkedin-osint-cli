/**
 * `linkedin osint employees` — scrape a company's employees via the Voyager
 * GraphQL people search (port of linkedin2username's search engine).
 *
 * Outer loops (--keywords or --geoblast) bypass LinkedIn's ~1000-result cap;
 * the inner loop pages 50 results at a time. Detects UPSELL_LIMIT
 * (commercial search limit) and stops with a clear message.
 */

import { z } from 'zod';
import type { CommandDefinition } from '../../core/types.js';
import { LinkedInError } from '../../core/errors.js';
import {
  buildEmployeesVariables,
  parseEmployeesPayload,
  parseEmployeesResponse,
  defaultDepth,
  EMPLOYEES_QUERY_ID,
} from '../../osint/employees-query.js';
import { resolveGeo, GEO_CODES } from '../../osint/geo-codes.js';
import { NameMutator, FORMAT_SUFFIXES, NAME_FORMATS } from '../../osint/names.js';
import { stringifyCsv } from '../../osint/csv.js';
import {
  fileTimestamp,
  resolveCompanyId,
  sleep,
  writeOutputFile,
} from './util.js';

const inputSchema = z.object({
  company: z.string().describe('Company universal name (URL slug)'),
  company_id: z.string().optional().describe('Numeric company ID (skips resolution)'),
  geo: z.string().optional().describe('Region filter for a single search (name or code)'),
  keywords: z.string().optional().describe('Comma-separated keywords — one outer loop each'),
  geoblast: z.boolean().default(false).describe('Outer loops across all regions (bypasses the 1000-result cap)'),
  depth: z.coerce.number().min(1).max(50).optional().describe('Max pages per loop (50 results each; default from staff count)'),
  max_profiles: z.coerce.number().min(1).optional().describe('Stop after this many unique profiles'),
  domain: z.string().optional().describe('Append @domain to generated usernames (writes the 6 username files too)'),
  out_dir: z.string().default('output').describe('Output directory'),
  format: z.enum(['json', 'csv']).default('json').describe('Master output format'),
  query_id: z.string().optional().describe('Override the people-search queryId if LinkedIn rotates it'),
  delay_ms: z.coerce.number().min(0).default(0).describe('Extra delay between pages (ms)'),
});

export const osintEmployeesCommand: CommandDefinition = {
  name: 'osint_employees',
  group: 'osint',
  subcommand: 'employees',
  description:
    "Scrape a company's employees (name + occupation) via the people-search API, with keyword/geoblast loops that bypass the 1000-result cap",
  examples: [
    'linkedin osint employees acme-corp',
    'linkedin osint employees acme-corp --keywords "sales,engineering" --domain acme.com',
    'linkedin osint employees acme-corp --geoblast --depth 3',
    'linkedin osint employees acme-corp --company-id 1035 --max-profiles 200',
  ],

  inputSchema,

  cliMappings: {
    args: [{ field: 'company', name: 'company', required: true }],
    options: [
      { field: 'company_id', flags: '--company-id <id>', description: 'Numeric company ID (skips resolution)' },
      { field: 'geo', flags: '--geo <region>', description: 'Region name or code for a single filtered search' },
      { field: 'keywords', flags: '-k, --keywords <list>', description: 'Comma-separated keywords (outer loops)' },
      { field: 'geoblast', flags: '-g, --geoblast', description: 'Outer loops across all regions' },
      { field: 'depth', flags: '-d, --depth <pages>', description: 'Max pages per loop (50 results each)' },
      { field: 'max_profiles', flags: '--max-profiles <n>', description: 'Stop after N unique profiles' },
      { field: 'domain', flags: '-n, --domain <domain>', description: 'Append @domain and write username files' },
      { field: 'out_dir', flags: '-o, --out-dir <dir>', description: 'Output directory (default: output)' },
      { field: 'format', flags: '--format <fmt>', description: 'Master output: json or csv' },
      { field: 'query_id', flags: '--query-id <id>', description: 'Override the people-search queryId' },
      { field: 'delay_ms', flags: '--delay-ms <n>', description: 'Extra delay between pages (ms)' },
    ],
  },

  handler: async (input, client) => {
    const inputAny = input as any as {
      company: string;
      company_id?: string;
      geo?: string;
      keywords?: string;
      geoblast: boolean;
      depth?: number;
      max_profiles?: number;
      domain?: string;
      out_dir: string;
      format: 'json' | 'csv';
      query_id?: string;
      delay_ms: number;
    };

    if (inputAny.keywords && inputAny.geoblast) {
      throw new LinkedInError(
        'keywords and geoblast are mutually exclusive — use one or the other.',
        'VALIDATION_ERROR',
      );
    }

    // --- Resolve company identity ---
    let companyId: string;
    let staffCount = 0;
    if (inputAny.company_id) {
      companyId = inputAny.company_id;
    } else {
      const identity = await resolveCompanyId(client, inputAny.company);
      companyId = identity.companyId;
      staffCount = identity.staffCount;
    }

    // --- Build outer loops ---
    const regionNames = Object.keys(GEO_CODES);
    let outerLoops: Array<{ region: string; keyword: string; label: string }> = [];
    if (inputAny.keywords) {
      const keywords = inputAny.keywords.split(',').map((k) => k.trim()).filter(Boolean);
      outerLoops = keywords.map((keyword) => ({ region: '', keyword, label: `keyword:${keyword}` }));
    } else if (inputAny.geoblast) {
      outerLoops = regionNames.map((name) => ({
        region: GEO_CODES[name],
        keyword: '',
        label: `region:${name}`,
      }));
    } else {
      const region = inputAny.geo ? resolveGeo(inputAny.geo) : '';
      outerLoops = [{ region: region ?? '', keyword: '', label: 'all' }];
    }

    // --- Search loops ---
    const employeesMap = new Map<string, { full_name: string; occupation: string }>();
    const loopResults: Array<{ label: string; pages: number; found: number; stopped: string }> = [];
    let upsellHit = false;
    const depth = inputAny.depth ?? defaultDepth(staffCount);

    for (const loop of outerLoops) {
      let pagesUsed = 0;
      let stopped = 'depth';
      for (let page = 0; page < depth; page++) {
        if (inputAny.max_profiles && employeesMap.size >= inputAny.max_profiles) {
          stopped = 'max_profiles';
          break;
        }

        const variables = buildEmployeesVariables({
          companyId,
          page,
          region: loop.region || undefined,
          keyword: loop.keyword || undefined,
        });

        let data: unknown;
        try {
          data = await client.get<unknown>('/graphql', {
            variables,
            queryId: inputAny.query_id ?? EMPLOYEES_QUERY_ID,
          });
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status && status !== 429 && status < 500) {
            stopped = `HTTP ${status}`;
            break;
          }
          throw err;
        }

        // Non-JSON body (client falls back to raw text) vs parsed payload
        if (typeof data === 'string') {
          const parsed = parseEmployeesResponse(data);
          if (parsed.upsellLimit) {
            upsellHit = true;
            stopped = 'UPSELL_LIMIT';
            break;
          }
          if (parsed.jsonError) {
            stopped = 'non-JSON response';
            break;
          }
          for (const emp of parsed.employees) {
            if (!employeesMap.has(emp.full_name)) employeesMap.set(emp.full_name, emp);
          }
        } else {
          if (JSON.stringify(data).includes('UPSELL_LIMIT')) {
            upsellHit = true;
            stopped = 'UPSELL_LIMIT';
            break;
          }
          const parsed = parseEmployeesPayload(data);
          if (parsed.employees.length === 0) {
            stopped = 'end of results';
            break;
          }
          for (const emp of parsed.employees) {
            if (!employeesMap.has(emp.full_name)) employeesMap.set(emp.full_name, emp);
          }
        }

        pagesUsed++;
        await sleep(inputAny.delay_ms);
      }

      loopResults.push({ label: loop.label, pages: pagesUsed, found: employeesMap.size, stopped });
      if (stopped === 'UPSELL_LIMIT' || stopped === 'max_profiles') break;
      if (outerLoops.length === 1 && stopped !== 'depth') break;
    }

    // --- Outputs ---
    const ts = fileTimestamp();
    const company = inputAny.company;
    const employees = [...employeesMap.values()];
    const files: string[] = [];

    if (inputAny.format === 'csv') {
      files.push(
        await writeOutputFile(
          inputAny.out_dir,
          `employees_${company}_${ts}.csv`,
          stringifyCsv(
            employees.map((e) => ({ full_name: e.full_name, occupation: e.occupation })),
            ['full_name', 'occupation'],
          ),
        ),
      );
    } else {
      files.push(
        await writeOutputFile(
          inputAny.out_dir,
          `employees_${company}_${ts}.json`,
          JSON.stringify(
            {
              generated_at: new Date().toISOString(),
              company,
              company_id: companyId,
              staff_count: staffCount || undefined,
              total: employees.length,
              loops: loopResults,
              employees,
            },
            null,
            2,
          ) + '\n',
        ),
      );
    }

    if (inputAny.domain) {
      files.push(
        ...(await writeUsernameFiles(
          company,
          `@${inputAny.domain.replace(/^@/, '')}`,
          employees,
          inputAny.out_dir,
        )),
      );
    }

    return {
      company,
      company_id: companyId,
      staff_count: staffCount || undefined,
      total: employees.length,
      upsell_limit: upsellHit || undefined,
      loops: loopResults,
      files,
      employees,
    };
  },
};

/**
 * Write the linkedin2username output file set: raw names, metadata CSV,
 * and the six username format files (optionally with @domain appended).
 */
export async function writeUsernameFiles(
  company: string,
  domain: string,
  employees: Array<{ full_name: string; occupation: string }>,
  outDir: string,
): Promise<string[]> {
  const files: string[] = [];

  files.push(
    await writeOutputFile(
      outDir,
      `${company}-rawnames.txt`,
      employees.map((e) => e.full_name).join('\n') + '\n',
    ),
  );

  files.push(
    await writeOutputFile(
      outDir,
      `${company}-metadata.txt`,
      'full_name,occupation\n' +
        employees.map((e) => `${e.full_name},${e.occupation}`).join('\n') +
        '\n',
    ),
  );

  for (const format of NAME_FORMATS) {
    const lines: string[] = [];
    for (const employee of employees) {
      const mutator = new NameMutator(employee.full_name);
      if (!mutator.name) continue;
      const names =
        format === 'f_last'
          ? mutator.fLast()
          : format === 'f_dot_last'
            ? mutator.fDotLast()
            : format === 'last_f'
              ? mutator.lastF()
              : format === 'first_dot_last'
                ? mutator.firstDotLast()
                : format === 'first_l'
                  ? mutator.firstL()
                  : mutator.first();
      for (const name of names) lines.push(name + domain);
    }
    files.push(
      await writeOutputFile(
        outDir,
        `${company}-${FORMAT_SUFFIXES[format]}.txt`,
        lines.join('\n') + (lines.length ? '\n' : ''),
      ),
    );
  }

  return files;
}


