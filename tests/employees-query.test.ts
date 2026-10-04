import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildEmployeesVariables,
  buildEmployeesUrl,
  parseEmployeesResponse,
  defaultDepth,
  EMPLOYEES_PAGE_SIZE,
  EMPLOYEES_QUERY_ID,
} from '../src/osint/employees-query.js';

describe('buildEmployeesVariables', () => {
  it('builds a page-0 query with company filter at count 50', () => {
    const v = buildEmployeesVariables({ companyId: '1035', page: 0 });
    expect(v).toContain('(start:0,');
    expect(v).toContain('(key:currentCompany,value:List(1035))');
    expect(v).toContain('(key:resultType,value:List(PEOPLE))');
    expect(v).toContain(',count:50)');
    expect(v).toContain('flagshipSearchIntent:SEARCH_SRP');
    expect(v).toContain('includeFiltersInResponse:false');
    expect(EMPLOYEES_PAGE_SIZE).toBe(50);
  });

  it('paginates at 50 per page', () => {
    const v = buildEmployeesVariables({ companyId: '1035', page: 3 });
    expect(v).toContain('(start:150,');
  });

  it('encodes keyword spaces and includes geo filter', () => {
    const v = buildEmployeesVariables({
      companyId: '1035',
      page: 0,
      keyword: 'human resources',
      region: '103644278',
    });
    expect(v).toContain('keywords:human%20resources,');
    expect(v).toContain('(key:geoUrn,value:List(103644278))');
  });

  it('omits keyword and region when not provided', () => {
    const v = buildEmployeesVariables({ companyId: '1035', page: 0 });
    expect(v).not.toContain('keywords:');
    expect(v).not.toContain('geoUrn');
  });
});

describe('buildEmployeesUrl', () => {
  it('targets the voyager graphql endpoint with the verified queryId', () => {
    const url = buildEmployeesUrl({ companyId: '1035', page: 0 });
    expect(url.startsWith('https://www.linkedin.com/voyager/api/graphql?variables=')).toBe(true);
    expect(url).toContain(`queryId=${EMPLOYEES_QUERY_ID}`);
    expect(EMPLOYEES_QUERY_ID).toBe(
      'voyagerSearchDashClusters.66adc6056cf4138949ca5dcb31bb1749',
    );
  });
});

describe('parseEmployeesResponse (verified against linkedin2username fixtures)', () => {
  it('extracts employees from the original mock response', () => {
    const raw = readFileSync(
      'legacy/python/linkedin2username-master/tests/mock-employee-response',
      'utf-8',
    );
    const parsed = parseEmployeesResponse(raw);
    expect(parsed.jsonError).toBe(false);
    expect(parsed.upsellLimit).toBe(false);
    expect(parsed.employees).toEqual([
      { full_name: 'Michael Myers', occupation: 'Camp Counsellor' },
      { full_name: 'Freddy Krueger', occupation: 'Babysitter' },
    ]);
  });

  it('returns no employees on the last page', () => {
    const raw = readFileSync(
      'legacy/python/linkedin2username-master/tests/mock-employee-response-last-page',
      'utf-8',
    );
    const parsed = parseEmployeesResponse(raw);
    expect(parsed.employees).toEqual([]);
    expect(parsed.total).toBe(0);
  });

  it('filters LinkedIn Member placeholders and strips Dr prefix', () => {
    const raw = JSON.stringify({
      data: {
        searchDashClustersByAll: {
          paging: { total: 3 },
          elements: [
            {
              items: [
                {
                  item: {
                    entityResult: {
                      title: { text: 'Michael Myers' },
                      primarySubtitle: { text: 'Camp Counsellor' },
                    },
                  },
                },
                { item: { entityResult: { title: { text: 'LinkedIn Member' } } } },
                {
                  item: {
                    entityResult: {
                      title: { text: 'Dr Jane Doe' },
                      primarySubtitle: { text: 'Scientist' },
                    },
                  },
                },
              ],
            },
          ],
        },
      },
    });
    const parsed = parseEmployeesResponse(raw);
    expect(parsed.total).toBe(3);
    expect(parsed.employees).toEqual([
      { full_name: 'Michael Myers', occupation: 'Camp Counsellor' },
      { full_name: 'Jane Doe', occupation: 'Scientist' },
    ]);
  });

  it('flags the commercial search limit', () => {
    const parsed = parseEmployeesResponse('{"UPSELL_LIMIT": true, "more": "..."');
    expect(parsed.upsellLimit).toBe(true);
  });

  it('flags JSON errors on HTML responses', () => {
    const parsed = parseEmployeesResponse('<html>authwall</html>');
    expect(parsed.jsonError).toBe(true);
    expect(parsed.employees).toEqual([]);
  });
});

describe('defaultDepth', () => {
  it('caps at 20 pages (1000 results) and rounds up', () => {
    expect(defaultDepth(0)).toBe(20);
    expect(defaultDepth(60)).toBe(2);
    expect(defaultDepth(500)).toBe(10);
    expect(defaultDepth(999)).toBe(20);
    expect(defaultDepth(1200)).toBe(20);
  });
});
