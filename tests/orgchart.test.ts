import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  dedupeByName,
  getDivisionColor,
  loadPeopleFile,
  peopleFromJson,
  buildHierarchicalData,
  type Person,
} from '../src/osint/orgchart.js';

const SAMPLE_PEOPLE: Person[] = [
  { name: 'Alice Founder', title: 'Founder & CEO' },
  { name: 'Bob VP', title: 'VP of Engineering' },
  { name: 'Carol Director', title: 'Director of Cyber Technologies' },
  { name: 'Dave Manager', title: 'Engineering Manager' },
  { name: 'Eve Engineer', title: 'Software Engineer' },
  { name: 'Frank SOC', title: 'SOC Analyst' },
  { name: 'Grace Intern', title: 'Intern' },
];

describe('peopleFromJson', () => {
  it('handles plain arrays', () => {
    const people = peopleFromJson([
      { name: 'John', title: 'CEO' },
      { name: 'Jane', title: 'CTO' },
    ]);
    expect(people).toHaveLength(2);
    expect(people[0].name).toBe('John');
  });

  it('handles the batch-scrape master format with company metadata', () => {
    const people = peopleFromJson({
      companies: [
        { company: 'CyberCo', people: [{ name: 'John', title: 'CISO' }] },
        { company: 'BankCo', people: [{ name: 'Jane', title: 'Banker' }] },
      ],
    });
    expect(people).toHaveLength(2);
    expect(people[0].company).toBe('CyberCo');
    expect(people[1].company).toBe('BankCo');
  });

  it('handles {people: [...]}, org chart divisions, and camelCase rows', () => {
    expect(peopleFromJson({ people: [{ name: 'A', title: 'CEO' }] })).toHaveLength(1);
    const fromDivisions = peopleFromJson({
      divisions: [{ name: 'Cyber Security', levels: [{ name: 'Director', people: [{ name: 'A', title: 'X' }] }] }],
    });
    expect(fromDivisions).toHaveLength(1);
    expect(fromDivisions[0].division_name).toBe('Cyber Security');
    expect(peopleFromJson({ companies: [] })).toEqual([]);
    expect(peopleFromJson({})).toEqual([]);
  });

  it('maps legacy camelCase keys', () => {
    const [person] = peopleFromJson([
      {
        name: 'Jane',
        profileUrl: 'https://linkedin.com/in/jane',
        profileImageUrl: 'https://media.licdn.com/x.jpg',
        connectionDegree: '1st',
      },
    ]);
    expect(person.profile_url).toBe('https://linkedin.com/in/jane');
    expect(person.profile_image_url).toBe('https://media.licdn.com/x.jpg');
    expect(person.connection_degree).toBe('1st');
  });

  it('drops rows without a name', () => {
    expect(peopleFromJson([{ title: 'CEO' }])).toEqual([]);
  });
});

describe('loadPeopleFile', () => {
  it('parses CSV in the legacy scraper format', async () => {
    const csv = `name,title,profile_url,profile_image_url,connection_degree,mutual_connections,action_state
"John Smith","CISO at CyberCo","https://linkedin.com/in/jsmith","https://media.licdn.com/x.jpg","1st","3","",""`;
    const path = 'output_test_people.csv';
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, csv, 'utf-8');
    try {
      const people = await loadPeopleFile(path);
      expect(people).toHaveLength(1);
      expect(people[0].name).toBe('John Smith');
      expect(people[0].title).toBe('CISO at CyberCo');
      expect(people[0].profile_image_url).toBe('https://media.licdn.com/x.jpg');
    } finally {
      const { rm } = await import('node:fs/promises');
      await rm(path, { force: true });
    }
  });

  it('parses JSON files', async () => {
    const path = 'output_test_people.json';
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, JSON.stringify({ people: [{ name: 'A', title: 'CEO' }] }), 'utf-8');
    try {
      const people = await loadPeopleFile(path);
      expect(people).toHaveLength(1);
    } finally {
      const { rm } = await import('node:fs/promises');
      await rm(path, { force: true });
    }
  });
});

describe('dedupeByName', () => {
  it('dedupes case-insensitively and prefers entries with images', () => {
    const deduped = dedupeByName([
      { name: 'John Smith', title: 'A' },
      { name: 'john smith!', title: 'B', profile_image_url: 'img.jpg' },
      { name: 'Jane Doe', title: 'C' },
    ]);
    expect(deduped).toHaveLength(2);
    expect(deduped[0].profile_image_url).toBe('img.jpg');
  });
});

describe('buildHierarchicalData', () => {
  it('classifies and groups people into divisions x levels', async () => {
    const demo = JSON.parse(
      await readFile('assets/demo_org_chart.json', 'utf-8'),
    );
    const people = peopleFromJson(demo);
    const divisions = buildHierarchicalData(people);

    expect(divisions.length).toBeGreaterThan(0);
    // Divisions sort exec-named first, then by total people descending
    // (ported behavior: in practice, people-descending).
    const totals = divisions.map((d) => d['total_people'] as number);
    expect([...totals].sort((a, b) => b - a)).toEqual(totals);
    // Each division has levels sorted by weight descending
    for (const div of divisions) {
      const levels = div['levels'] as Array<{ level: number; people: unknown[] }>;
      expect(levels.length).toBeGreaterThan(0);
      const weights = levels.map((l) => l.level);
      expect([...weights].sort((a, b) => b - a)).toEqual(weights);
    }
  });

  it('totals match the input count', () => {
    const divisions = buildHierarchicalData([...SAMPLE_PEOPLE]);
    const total = divisions.reduce(
      (sum, d) => sum + (d['total_people'] as number),
      0,
    );
    expect(total).toBe(SAMPLE_PEOPLE.length);
  });
});

describe('getDivisionColor', () => {
  it('returns mapped colors and gray fallback', () => {
    expect(getDivisionColor('Cyber Security')).toBe('#e74c3c');
    expect(getDivisionColor('Made Up Division')).toBe('#95a5a6');
  });
});
