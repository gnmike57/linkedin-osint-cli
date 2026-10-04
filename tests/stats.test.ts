import { describe, expect, it } from 'vitest';
import {
  classifyAll,
  suggestOverrides,
  hierarchyRows,
  divisionRows,
  healthSummary,
  unclassifiedSamples,
  pct,
  bar,
} from '../src/osint/stats.js';
import type { Person } from '../src/osint/orgchart.js';

const PEOPLE: Person[] = [
  { name: 'A', title: 'CEO' },
  { name: 'B', title: 'VP Engineering' },
  { name: 'C', title: 'Software Engineer' },
  { name: 'D', title: 'Looking for new opportunity' },
  { name: 'E', title: 'Quantum Flux Harmonizer' },
  { name: 'F', title: 'Quantum Flux Harmonizer' },
];

describe('classifyAll', () => {
  it('collects hierarchy and division distributions', () => {
    const stats = classifyAll(PEOPLE);
    expect(stats.total).toBe(6);
    expect(stats.hierarchy.get('Executive')).toBe(1); // CEO
    expect(stats.hierarchy.get('VP')).toBe(1); // VP Engineering
    expect(stats.hierarchy.get('Mid-Level')).toBe(1);
    expect(stats.hierarchy.get('Staff')).toBe(3);
    expect(stats.division.get('Software Development')).toBeGreaterThanOrEqual(1);
  });

  it('tracks unclassified title frequency', () => {
    const stats = classifyAll(PEOPLE);
    expect(stats.staffTitles.get('quantum flux harmonizer')).toBe(2);
    expect(stats.staffTitles.get('looking for new opportunity')).toBeUndefined(); // junk → not cleaned
  });
});

describe('report helpers', () => {
  it('computes percentages, bars, and rows', () => {
    expect(pct(1, 4)).toBe(25);
    expect(bar(50)).toBe('#########################'.slice(0, 25));
    const stats = classifyAll(PEOPLE);
    const hRows = hierarchyRows(stats);
    expect(hRows[0][0]).toBe('Executive');
    const dRows = divisionRows(stats);
    expect(dRows.length).toBeGreaterThan(0);
    expect(dRows[0][1]).toBeGreaterThanOrEqual(dRows[1]?.[1] ?? 0);
  });

  it('summarizes health with thresholds', () => {
    const stats = classifyAll(PEOPLE);
    const health = healthSummary(stats);
    expect(health.staffCount).toBe(3);
    expect(health.hierarchyStatus).toBe('NEEDS WORK'); // 50% ≥ 10%
  });

  it('suggests overrides for repeated unclassified titles only', () => {
    const stats = classifyAll(PEOPLE);
    const suggestions = suggestOverrides(stats, 10, 2);
    const flux = suggestions.find((s) => s.title === 'quantum flux harmonizer');
    expect(flux).toBeDefined();
    expect(flux?.count).toBe(2);
    expect(flux?.issue).toBe('Staff (no hierarchy match)');
    // one-off unclassified titles are not suggested
    expect(suggestions.find((s) => s.title === 'bush pilot')).toBeUndefined();
  });

  it('samples unclassified titles', () => {
    const stats = classifyAll(PEOPLE);
    const samples = unclassifiedSamples(stats, 'hierarchy');
    expect(samples.length).toBeGreaterThan(0);
    expect(samples[0]).toContain('quantum flux harmonizer');
  });
});
