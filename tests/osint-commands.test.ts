import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { osintEmployeesCommand, writeUsernameFiles } from '../src/commands/osint/employees.js';
import { osintMatrixCommand } from '../src/commands/osint/matrix.js';
import { detectPhase } from '../src/commands/osint/funnel.js';
import { normalizeProfileView } from '../src/commands/osint/deep-dive.js';

// ---- Mock LinkedInClient --------------------------------------------------

function makeCompanyView(companyId: string, staffCount: number): unknown {
  return {
    data: { company: { id: companyId, staffCount, displayName: 'TestCo' } },
    included: [
      {
        $type: 'com.linkedin.voyager.deco.organization.web.WebFullCompanyMain',
        urn: `urn:li:company:${companyId}`,
      },
    ],
  };
}

function makePeoplePayload(names: Array<[string, string]>, total: number): unknown {
  return {
    data: {
      searchDashClustersByAll: {
        paging: { total },
        elements: [
          {
            items: names.map(([name, occupation]) => ({
              item: {
                entityResult: {
                  title: { text: name },
                  primarySubtitle: { text: occupation },
                },
              },
            })),
          },
        ],
      },
    },
  };
}

function mockClient(companyId: string, staffCount: number, pages: Array<Array<[string, string]>>) {
  let call = 0;
  return {
    get: async (path: string, query?: Record<string, any>) => {
      if (path === '/organization/companies') {
        return makeCompanyView(companyId, staffCount);
      }
      if (path === '/graphql') {
        expect(query.variables).toContain('(key:currentCompany,value:List(1035))');
        const page = pages[call] ?? [];
        call++;
        return makePeoplePayload(page, pages.length * 50);
      }
      throw new Error(`unexpected path ${path}`);
    },
  } as never;
}

describe('osint employees command (mocked client)', () => {
  const outDir = 'output_test_employees';

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it('paginates, dedupes, and writes JSON + username files', async () => {
    const client = mockClient('1035', 120, [
      [
        ['Michael Myers', 'Camp Counsellor'],
        ['Freddy Krueger', 'Babysitter'],
        ['LinkedIn Member', ''],
        ['Dr Jane Doe', 'Scientist'],
      ],
      [
        ['Michael Myers', 'Camp Counsellor'], // duplicate across pages
        ['Laurie Strode', 'Final Girl'],
      ],
      [], // end of results
    ]);

    const result = (await osintEmployeesCommand.handler(
      {
        company: 'testco',
        geoblast: false,
        out_dir: outDir,
        format: 'json',
        domain: 'haddonfield.com',
        delay_ms: 0,
      } as never,
      client,
    )) as any;

    expect(result.company_id).toBe('1035');
    expect(result.staff_count).toBe(120);
    expect(result.total).toBe(4); // member placeholder filtered, dup dropped
    expect(result.employees.map((e: any) => e.full_name)).toEqual([
      'Michael Myers',
      'Freddy Krueger',
      'Jane Doe', // Dr prefix stripped
      'Laurie Strode',
    ]);
    expect(result.upsell_limit).toBeUndefined();

    // Master JSON + 8 username files
    expect(result.files).toHaveLength(9);
    const master = JSON.parse(await readFile(result.files[0], 'utf-8'));
    expect(master.company).toBe('testco');
    expect(master.total).toBe(4);

    const fLast = await readFile(`${outDir}/testco-f.last.txt`, 'utf-8');
    expect(fLast).toContain('m.myers@haddonfield.com');
    expect(fLast).toContain('l.strode@haddonfield.com');
    const first = await readFile(`${outDir}/testco-first.txt`, 'utf-8');
    expect(first).toContain('michael');
  });

  it('stops with upsell_limit when the commercial cap appears', async () => {
    let called = 0;
    const upsellClient = {
      get: async (path: string) => {
        if (path === '/organization/companies') return makeCompanyView('77', 5000);
        if (path === '/graphql') {
          called++;
          if (called === 1) return makePeoplePayload([['A B', 'X']], 5000);
          return { data: {}, upsell: 'UPSELL_LIMIT' };
        }
        throw new Error('unexpected');
      },
    } as never;

    const result = (await osintEmployeesCommand.handler(
      {
        company: 'bigco',
        geoblast: false,
        out_dir: outDir,
        format: 'json',
        delay_ms: 0,
      } as never,
      upsellClient,
    )) as any;

    expect(result.upsell_limit).toBe(true);
    expect(result.total).toBe(1);
    expect(result.loops[0].stopped).toBe('UPSELL_LIMIT');
  });

  it('skips company resolution when --company-id is provided', async () => {
    let page = 0;
    const noResolve = {
      get: async (path: string) => {
        if (path === '/graphql') {
          const current = page++;
          return makePeoplePayload(current === 0 ? [['Jane Roe', 'Analyst']] : [], 50);
        }
        throw new Error('must not be called');
      },
    } as never;

    const result = (await osintEmployeesCommand.handler(
      {
        company: 'whatever',
        company_id: '42',
        geoblast: false,
        out_dir: outDir,
        format: 'json',
        delay_ms: 0,
      } as never,
      noResolve,
    )) as any;

    expect(result.company_id).toBe('42');
    expect(result.total).toBe(1);
  });
});

describe('funnel detectPhase', () => {
  it('detects the phase from existing output formats', () => {
    expect(detectPhase({ companies: [{ name: 'A', url: 'x' }] })).toBe(2);
    expect(detectPhase({ companies: [{ company: 'A', people: [{ name: 'B' }] }] })).toBe(3);
    expect(detectPhase({ people: [{ name: 'B' }] })).toBe(3);
    expect(detectPhase({ divisions: [{ name: 'X', levels: [] }] })).toBe(4);
    expect(detectPhase({})).toBe(1);
  });
});

describe('normalizeProfileView (deep dive)', () => {
  it('extracts profile, positions, education, and skills', () => {
    const response = {
      included: [
        {
          $type: 'com.linkedin.voyager.dash.identity.profile.Profile',
          firstName: 'Jane',
          lastName: 'Doe',
          headline: 'Security Architect',
          locationName: 'Tel Aviv, Israel',
          summary: '15 years in infosec',
        },
        {
          $type: 'com.linkedin.voyager.dash.identity.profile.Position',
          title: 'Head of Security',
          companyName: 'TestCo',
          dateRange: { start: { year: 2020 } },
        },
        {
          $type: 'com.linkedin.voyager.dash.identity.profile.Education',
          schoolName: 'Technion',
          degreeName: 'BSc',
        },
        { $type: 'com.linkedin.voyager.dash.identity.profile.Skill', name: 'SIEM' },
      ],
    };
    const normalized = normalizeProfileView(response, 'janedoe');
    expect(normalized.public_id).toBe('janedoe');
    expect(normalized.name).toBe('Jane Doe');
    expect(normalized.headline).toBe('Security Architect');
    expect(normalized.about).toBe('15 years in infosec');
    expect(normalized.experience).toEqual([
      {
        title: 'Head of Security',
        company: 'TestCo',
        date_range: '2020-Present',
        location: '',
        description: '',
      },
    ]);
    expect(normalized.education).toEqual([{ degree: 'BSc', school: 'Technion', date_range: '' }]);
    expect(normalized.skills).toEqual(['SIEM']);
  });

  it('tolerates empty responses', () => {
    const normalized = normalizeProfileView({}, 'x');
    expect(normalized.name).toBe('');
    expect(normalized.experience).toEqual([]);
  });
});

describe('writeUsernameFiles', () => {
  const outDir = 'output_test_names';

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it('writes all 8 files with the legacy naming', async () => {
    const files = await writeUsernameFiles(
      'acme',
      '@acme.com',
      [{ full_name: 'John Davidson-Smith', occupation: 'Engineer' }],
      outDir,
    );
    expect(files).toHaveLength(8);
    const flast = await readFile(`${outDir}/acme-flast.txt`, 'utf-8');
    expect(flast).toContain('jdavidson-smith@acme.com');
    expect(flast).toContain('jsmith@acme.com');
    const metadata = await readFile(`${outDir}/acme-metadata.txt`, 'utf-8');
    expect(metadata).toContain('full_name,occupation');
    expect(metadata).toContain('John Davidson-Smith,Engineer');
  });
});

describe('osint employees error resilience', () => {
  const outDir = 'output_test_employees_err';

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it('keeps partial output when the scrape aborts with a network error', async () => {
    let pageCalls = 0;
    const client = {
      get: async (path: string) => {
        if (path === '/organization/companies') return makeCompanyView('1035', 120);
        pageCalls++;
        if (pageCalls === 1) {
          return makePeoplePayload([['First Person', 'Analyst']], 500);
        }
        throw new Error('session expired');
      },
    } as never;

    const result = (await osintEmployeesCommand.handler(
      {
        company: 'testco',
        geoblast: false,
        out_dir: outDir,
        format: 'json',
        delay_ms: 0,
      } as never,
      client,
    )) as any;

    expect(result.error).toContain('session expired');
    expect(result.total).toBe(1);
    expect(result.employees[0].full_name).toBe('First Person');
    expect(result.files.length).toBeGreaterThanOrEqual(1);
    const master = JSON.parse(await readFile(result.files[0], 'utf-8'));
    expect(master.error).toContain('session expired');
    expect(master.employees).toHaveLength(1);
  });
});



describe('osint matrix command input handling', () => {
  const outDir = 'output_test_matrix';
  const fixtures = 'output_test_matrix_fixtures';

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
    await rm(fixtures, { recursive: true, force: true });
  });

  it('accepts a CSV people file and classifies it on the fly', async () => {
    await mkdir(fixtures, { recursive: true });
    const csv = `${fixtures}/people.csv`;
    await writeFile(
      csv,
      'name,title,profile_url\n' +
        'Ada Lovelace,Chief Technology Officer,https://www.linkedin.com/in/ada\n' +
        'Grace Hopper,Senior Security Engineer,https://www.linkedin.com/in/grace\n',
      'utf-8',
    );

    const result = (await osintMatrixCommand.handler(
      { file: csv, name: 'Acme', out_dir: outDir } as never,
      {} as never,
    )) as any;

    expect(result.file).toContain('org_chart_matrix_');
    const html = await readFile(result.file, 'utf-8');
    expect(html).toContain('Ada Lovelace');
    expect(html).toContain('Grace Hopper');
  });

  it('reports EMPTY_INPUT for a file with no people instead of a parse error', async () => {
    await mkdir(fixtures, { recursive: true });
    const txt = `${fixtures}/names.txt`;
    await writeFile(txt, 'Ada Lovelace\nGrace Hopper\n', 'utf-8');

    const result = (await osintMatrixCommand.handler(
      { file: txt, out_dir: outDir } as never,
      {} as never,
    )) as any;

    expect(result.code).toBe('EMPTY_INPUT');
    expect(result.error).toContain('No people found');
  });

  it('throws a clear ValidationError for malformed JSON', async () => {
    await mkdir(fixtures, { recursive: true });
    const bad = `${fixtures}/bad.json`;
    await writeFile(bad, '{ "divisions": [', 'utf-8');

    await expect(
      osintMatrixCommand.handler({ file: bad, out_dir: outDir } as never, {} as never),
    ).rejects.toThrow(/is not valid JSON/);
  });
});

