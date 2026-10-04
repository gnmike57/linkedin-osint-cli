/**
 * `linkedin osint discover` — discover companies by region/keyword/industry
 * via the verified voyagerSearchDashClusters company search, with industry
 * classification (port of osint_discover.py's classification helpers).
 *
 * The geo facet key `companyHqGeo` comes from LinkedIn's own company-search
 * URL parameters (documented in the legacy toolkit docs). If LinkedIn rotates
 * the queryId or facet, override with --query-id.
 */

import { z } from 'zod';
import type { CommandDefinition } from '../../core/types.js';
import { SEARCH_CLUSTERS_QUERY_ID } from '../search/search.js';
import { resolveGeo, GEO_CODES } from '../../osint/geo-codes.js';
import { classifyIndustry } from '../../osint/industries.js';
import { sanitizeGroupedTerm } from '../../osint/employees-query.js';
import { fileTimestamp, writeOutputFile } from './util.js';

const inputSchema = z.object({
  geo: z.string().describe('Region name (e.g., USA) or LinkedIn geo code'),
  keyword: z.string().optional().describe('Search keyword (e.g., cybersecurity, fintech)'),
  industry: z.string().optional().describe('Filter by industry category (see osint industries taxonomy)'),
  limit: z.coerce.number().min(1).max(100).default(10).describe('Max companies to discover'),
  region_name: z.string().default('region').describe('Region label for the output filename'),
  out_dir: z.string().default('output').describe('Output directory'),
  use_ai: z.boolean().default(false).describe('Score companies with Groq AI (requires GROQ_API_KEY)'),
  search_objective: z.string().optional().describe('Research objective for AI scoring'),
  query_id: z.string().optional().describe('Override the search queryId'),
});

export const osintDiscoverCommand: CommandDefinition = {
  name: 'osint_discover',
  group: 'osint',
  subcommand: 'discover',
  description:
    'Discover companies in a region via LinkedIn company search (geo + keyword + industry filters, optional AI relevance scoring)',
  examples: [
    'linkedin osint discover --geo USA --keyword cybersecurity --limit 10',
    'linkedin osint discover --geo 103644278 --industry Cybersecurity --limit 20',
    'linkedin osint discover --geo USA --use-ai --search-objective "SOC teams for defense research"',
  ],

  inputSchema,

  cliMappings: {
    options: [
      { field: 'geo', flags: '-g, --geo <region>', description: 'Region name or geo code (required)' },
      { field: 'keyword', flags: '-k, --keyword <text>', description: 'Search keyword' },
      { field: 'industry', flags: '--industry <category>', description: 'Industry category filter' },
      { field: 'limit', flags: '-l, --limit <n>', description: 'Max companies (default 10)' },
      { field: 'region_name', flags: '-r, --region-name <label>', description: 'Region label for filenames' },
      { field: 'out_dir', flags: '-o, --out-dir <dir>', description: 'Output directory (default: output)' },
      { field: 'use_ai', flags: '--use-ai', description: 'Groq AI relevance scoring' },
      { field: 'search_objective', flags: '--search-objective <text>', description: 'Research objective for AI' },
      { field: 'query_id', flags: '--query-id <id>', description: 'Override the search queryId' },
    ],
  },

  handler: async (input, client) => {
    const inputAny = input as any as {
      geo: string;
      keyword?: string;
      industry?: string;
      limit: number;
      region_name: string;
      out_dir: string;
      use_ai: boolean;
      search_objective?: string;
      query_id?: string;
    };

    const geoCode = resolveGeo(inputAny.geo);
    if (!geoCode) {
      return {
        error: `Unknown geo "${inputAny.geo}". Use a code or one of: ${Object.keys(GEO_CODES).join(', ')}`,
        code: 'UNKNOWN_GEO',
      };
    }

    const filters: string[] = [
      '(key:resultType,value:List(COMPANIES))',
      `(key:companyHqGeo,value:List(${geoCode}))`,
    ];
    const keywords = inputAny.keyword ? sanitizeGroupedTerm(inputAny.keyword) : '';
    const buildVariables = (start: number) =>
      `(start:${start},origin:GLOBAL_SEARCH_HEADER,query:(keywords:${keywords},` +
      'flagshipSearchIntent:SEARCH_SRP,' +
      `queryParameters:List(${filters.join(',')}),` +
      'includeFiltersInResponse:false))';

    // Paginate the company search until `limit` is satisfied (one page only
    // yields a handful of companies, so --limit 50/100 would be silently
    // truncated otherwise).
    const PAGE_SIZE = 49;
    let start = 0;

    // Extract companies from the entityResult clusters (defensive parsing)
    const companies: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();

    pageLoop: while (companies.length < inputAny.limit) {
      const response = await client.get<unknown>('/graphql', {
        variables: buildVariables(start),
        queryId: inputAny.query_id ?? SEARCH_CLUSTERS_QUERY_ID,
      });

      const clusters = (response as any)?.data?.searchDashClustersByAll ?? {};
      const pageCountBefore = companies.length;

      for (const element of clusters?.elements ?? []) {
        for (const itemBody of element?.items ?? []) {
          const entity = itemBody?.item?.entityResult;
          if (!entity) continue;
          const name = String(entity?.title?.text ?? '').trim();
          if (!name || name.toLowerCase() === 'linkedin member') continue;
          if (seen.has(name.toLowerCase())) continue;
          seen.add(name.toLowerCase());

          const subtitle = String(entity?.primarySubtitle?.text ?? '');
          const industryRaw = subtitle.split('\n')[0]?.trim() ?? '';
          const location = subtitle.split('\n').slice(1).join(', ').trim();

          // Prefer the real universalName from navigationUrl; only fall back to
          // a slugified display name when LinkedIn didn't include the URL — the
          // next funnel phase resolves companies via this URL, and a guessed
          // slug silently points at the wrong (or a nonexistent) company.
          const navUrl = String(entity?.navigationUrl ?? '');
          const navMatch = navUrl.match(/linkedin\.com\/company\/([^/?#\s"'<>]+)/);
          const url = navMatch
            ? `https://www.linkedin.com/company/${navMatch[1]}`
            : `https://www.linkedin.com/company/${slugify(name)}`;

          companies.push({
            name,
            subtitle,
            industry: classifyIndustry(industryRaw),
            industry_raw: industryRaw,
            location,
            url,
            entity,
          });
          if (companies.length >= inputAny.limit) break pageLoop;
        }
      }

      // Empty page → end of results; stop before looping forever.
      if (companies.length === pageCountBefore) break;
      start += PAGE_SIZE;
    }

    // Optional AI relevance scoring
    if (inputAny.use_ai) {
      const { scoreCompanies } = await import('../../osint/ai-client.js');
      const objective = inputAny.search_objective ?? inputAny.keyword ?? inputAny.industry ?? '';
      if (objective) {
        const scored = await scoreCompanies(companies as never, objective);
        scored.forEach((c, i) => {
          companies[i] = c as unknown as Record<string, unknown>;
        });
      }
    }

    const file = await writeOutputFile(
      inputAny.out_dir,
      `discovered_companies_${inputAny.region_name}_${fileTimestamp()}.json`,
      JSON.stringify(
        { discovered_at: new Date().toISOString(), geo: geoCode, count: companies.length, companies },
        null,
        2,
      ) + '\n',
    );

    return { geo: geoCode, count: companies.length, file, companies };
  },
};

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
