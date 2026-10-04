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

/** Build the `variables=(...)` payload for the people search. */
export function buildEmployeesVariables(opts: EmployeesQueryOptions): string {
  const count = opts.count ?? EMPLOYEES_PAGE_SIZE;
  const keyword = opts.keyword ? `keywords:${encodeURIComponent(opts.keyword)},` : '';
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

/** Full Voyager GraphQL URL for a people-search page. */
export function buildEmployeesUrl(
  opts: EmployeesQueryOptions,
  queryId: string = EMPLOYEES_QUERY_ID,
): string {
  return (
    'https://www.linkedin.com/voyager/api/graphql' +
    `?variables=${encodeURIComponent(buildEmployeesVariables(opts))}` +
    `&queryId=${queryId}`
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

  const clusters = (data as any)?.data?.searchDashClustersByAll ?? {};
  result.total = clusters?.paging?.total ?? 0;
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

      if (cleanedName) result.employees.push({ full_name: cleanedName, occupation });
    }
  }

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
