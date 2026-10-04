import { describe, expect, it } from 'vitest';
import {
  buildMatrixHtml,
  collectMatrixPeople,
  TIER_GROUPS,
} from '../src/osint/matrix.js';

const ORG_DATA = {
  divisions: [
    {
      id: 'executive_leadership',
      name: 'General',
      color: '#95a5a6',
      total_people: 2,
      levels: [
        {
          level: 100,
          name: 'Executive',
          people: [
            { name: 'Alice CEO', title: 'CEO', role_level: 'Executive', division_name: 'General', profile_url: 'https://linkedin.com/in/alice' },
          ],
        },
      ],
    },
    {
      id: 'cyber_security',
      name: 'Cyber Security',
      color: '#e74c3c',
      total_people: 1,
      levels: [
        {
          level: 30,
          name: 'Mid-Level',
          people: [
            { name: 'Bob Analyst', title: 'SOC Analyst', role_level: 'Mid-Level', division_name: 'Cyber Security' },
          ],
        },
      ],
    },
  ],
};

const RAW_PEOPLE = [
  { name: 'Carol CTO', title: 'Chief Technology Officer' },
  { name: 'Dave Eng', title: 'Software Engineer' },
];

describe('collectMatrixPeople', () => {
  it('reads the org-chart divisions format as-is', () => {
    const people = collectMatrixPeople(ORG_DATA);
    expect(people).toHaveLength(2);
    expect(people[0].level).toBe('Executive');
    expect(people[0].department).toBe('General');
    expect(people[1].department).toBe('Cyber Security');
    expect(people[1].level).toBe('Mid-Level');
  });

  it('classifies raw people collections on the fly', () => {
    const people = collectMatrixPeople(RAW_PEOPLE);
    expect(people).toHaveLength(2);
    expect(people[0].level).toBe('Executive');
    expect(people[0].department).toBe('IT Infrastructure');
    expect(people[1].level).toBe('Mid-Level');
    expect(people[0].initials).toBe('CC');
  });
});

describe('buildMatrixHtml', () => {
  it('produces a complete standalone HTML document', () => {
    const html = buildMatrixHtml(ORG_DATA, { rootLabel: 'TestCo' });
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('TestCo — Organization Chart');
    expect(html).toContain('class="stats"');
    expect(html).toContain('searchBox');
    expect(html).toContain('toggle(');
    expect(html).toContain('Executive / VP');
    expect(html).toContain('Cyber Security');
    // Avatar with initials fallback and a real link for the CEO
    expect(html).toContain('AC');
    expect(html).toContain('https://linkedin.com/in/alice');
    // Count badge with cell count
    expect(html).toMatch(/count-badge[^>]*>1</);
  });

  it('escapes HTML in names and titles', () => {
    const html = buildMatrixHtml({ people: [{ name: '<script>x</script>', title: 'CEO' }] });
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('omits empty tier rows', () => {
    const html = buildMatrixHtml(RAW_PEOPLE);
    expect(html).toContain('Executive / VP');
    expect(html).not.toContain('Entry / Staff'); // nobody at that tier
  });

  it('exposes all six tier groups', () => {
    expect(TIER_GROUPS).toHaveLength(6);
    expect(TIER_GROUPS[0].levels).toEqual(['Executive', 'VP']);
    expect(TIER_GROUPS[5].levels).toEqual(['Entry', 'Staff']);
  });
});
