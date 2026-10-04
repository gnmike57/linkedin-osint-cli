/**
 * Voyager GraphQL people-search query builder + parser.
 *
 * Ported from linkedin2username's get_results() and find_employees()
 * (legacy/python/linkedin2username-master). The queryId below is the one that
 * tool verified against LinkedIn's mobile API — it accepts `count: 50`
 * (versus the 49/page cap of the web SRP clusters queryId used by
 * `search people`), which is what lets `osint employees` out-paginate it.
 *
 * If LinkedIn rotates the queryId, override it with --query-id.
 */

export const EMPLOYEES_QUERY_ID = 'voyagerSearchDashClusters.66adc6056cf4138949ca5dcb31bb1749';
export const EMPLOYEES_PAGE_SIZE = 50;

export interface EmployeesQueryOptions {
  /** Numeric LinkedIn company ID. */
  companyId: string;
  /** 0-based page index; start = page * count. */
  page: number;
  /** Optional geo region code (geoUrn filter) for geoblast loops. */
  region?: string;
  /** Optional keyword filter. */
  keyword?: string;
  /** Page size (default 50). */
  count?: number;
}

/**
 * Strip characters that terminate or corrupt LinkedIn's grouped-query syntax
 * `(key:...,value:List(...))` — commas close the current parameter and parens
 * break nesting. Values are inserted raw (the HTTP transport URL-encodes the
 * whole `variables` string exactly once), so never encodeURIComponent these.
 */
export function sanitizeGroupedTerm(value: string): string {
  return value.replace(/[(),]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Build the `variables=(...)` payload for the people search. */
export function buildEmployeesVariables(opts: EmployeesQueryOptions): string {
  const count = opts.count ?? EMPLOYEES_PAGE_SIZE;
  const keyword = opts.keyword ? `keywords:${sanitizeGroupedTerm(opts.keyword)},` : '';
  const region = opts.region ? `(key:geoUrn,value:List(${opts.region})),` : '';
  return (
    `(start:${opts.page * count},` +
    'query:(' +
    keyword +
    'flagshipSearchIntent:SEARCH_SRP,' +
    'queryParameters:List(' +
    `(key:currentCompany,value:List(${opts.companyId})),` +
    region +
    '(key:resultType,value:List(PEOPLE))' +
    '),' +
    'includeFiltersInResponse:false' +
    `),count:${count})`
  );
}

export interface EmployeeEntry {
  full_name: string;
  occupation: string;
}

export interface ParsedEmployeesResult {
  employees: EmployeeEntry[];
  /** paging.total from the response — 0 means end of results. */
  total: number;
  /** True when LinkedIn's commercial search limit was hit (UPSELL_LIMIT). */
  upsellLimit: boolean;
  /** True when the response body was not valid JSON. */
  jsonError: boolean;
}

export interface ParsedEmployeesPayload {
  employees: EmployeeEntry[];
  /** paging.total from the response — 0 means end of results. */
  total: number;
}

/**
 * Parse an already-deserialized people-search payload (what `client.get`
 * returns after JSON.parse). Shared by the text parser below and the
 * command layer.
 */
export function parseEmployeesPayload(data: unknown): ParsedEmployeesPayload {
  const employees: EmployeeEntry[] = [];
  const clusters = (data as any)?.data?.searchDashClustersByAll ?? {};
  const total = clusters?.paging?.total ?? 0;
  const elements = clusters?.elements ?? [];

  for (const element of elements) {
    for (const itemBody of element?.items ?? []) {
      const entity = itemBody?.item?.entityResult;
      if (!entity) continue;

      const fullName = String(entity?.title?.text ?? '').trim();

      // Skip placeholder profiles with no real name
      if (fullName.toLowerCase() === 'linkedin member') continue;

      const cleanedName = fullName.startsWith('Dr ') ? fullName.slice(3) : fullName;

      // Some users are missing a primary subtitle
      const occupation = String(entity?.primarySubtitle?.text ?? '');

      if (cleanedName) employees.push({ full_name: cleanedName, occupation });
    }
  }

  return { employees, total: Number(total) || 0 };
}

/**
 * Parse a people-search response body into employee entries.
 * Filters "LinkedIn Member" placeholders and strips "Dr " prefixes
 * (the original Python had an off-by-one here; this port strips exactly 3 chars).
 */
export function parseEmployeesResponse(text: string): ParsedEmployeesResult {
  const result: ParsedEmployeesResult = {
    employees: [],
    total: 0,
    upsellLimit: false,
    jsonError: false,
  };

  if (text.includes('UPSELL_LIMIT')) {
    result.upsellLimit = true;
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    result.jsonError = true;
    return result;
  }

  const payload = parseEmployeesPayload(data);
  result.employees = payload.employees;
  result.total = payload.total;
  return result;
}

/**
 * Default search depth (inner-loop page count) from a staff count.
 * LinkedIn caps people search at ~1000 results: ceil(staff/50), max 20 pages.
 */
export function defaultDepth(staffCount: number): number {
  if (!staffCount || staffCount <= 0) return 20;
  return Math.min(Math.ceil(staffCount / EMPLOYEES_PAGE_SIZE), 20);
}
