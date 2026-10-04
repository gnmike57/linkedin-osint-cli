/**
 * Classification statistics + scanner (TypeScript port of osint_stats.py and
 * osint_scan.py). Reports hierarchy/division distributions, unclassified
 * samples, and suggested title_overrides for classification_rules.json.
 */

import { classifyTitle, cleanTitle, getHierarchyOrder } from './classify.js';
import type { Person } from './orgchart.js';

export interface ClassificationStats {
  total: number;
  hierarchy: Map<string, number>;
  division: Map<string, number>;
  staffTitles: Map<string, number>;
  generalTitles: Map<string, number>;
}

/** Classify all titles and collect distributions. */
export function classifyAll(people: Person[]): ClassificationStats {
  const hierarchy = new Map<string, number>();
  const division = new Map<string, number>();
  const staffTitles = new Map<string, number>();
  const generalTitles = new Map<string, number>();

  const bump = (map: Map<string, number>, key: string) => {
    map.set(key, (map.get(key) ?? 0) + 1);
  };

  for (const person of people) {
    const title = person.title ?? '';
    const result = classifyTitle(title);
    bump(hierarchy, result.role_level);
    bump(division, result.division);

    const cleaned = cleanTitle(title);
    if (result.role_level === 'Staff' && cleaned) bump(staffTitles, cleaned.toLowerCase());
    if (result.division === 'General' && cleaned) bump(generalTitles, cleaned.toLowerCase());
  }

  return { total: people.length, hierarchy, division, staffTitles, generalTitles };
}

/** Entries sorted by count descending. */
export function sortedCounts(map: Map<string, number>): Array<[string, number]> {
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

/** Percentage for one bucket. */
export function pct(count: number, total: number): number {
  return total > 0 ? (count / total) * 100 : 0;
}

/** ASCII distribution bar used by the scan report. */
export function bar(pctValue: number): string {
  return '#'.repeat(Math.floor(pctValue / 2));
}

export interface OverrideSuggestion {
  title: string;
  count: number;
  issue: string;
  suggested: { level?: string; division?: string };
}

/**
 * Generate suggested title_overrides for the most common unclassified titles
 * (mirrors osint_scan.suggest_overrides — suggestions only, never applied
 * automatically).
 */
export function suggestOverrides(
  stats: ClassificationStats,
  limit = 25,
  minCount = 2,
): OverrideSuggestion[] {
  const suggestions: OverrideSuggestion[] = [];
  const seen = new Set<string>();

  for (const [title, count] of sortedCounts(stats.staffTitles)) {
    if (suggestions.length >= limit || count < minCount) break;
    seen.add(title);
    suggestions.push({
      title,
      count,
      issue: 'Staff (no hierarchy match)',
      suggested: { level: 'Mid-Level', division: '???' },
    });
  }

  for (const [title, count] of sortedCounts(stats.generalTitles)) {
    if (suggestions.length >= limit || count < minCount) break;
    if (seen.has(title)) continue;
    suggestions.push({
      title,
      count,
      issue: 'General (no division match)',
      suggested: { division: '???' },
    });
  }

  return suggestions;
}

/** Ordered hierarchy distribution rows for reports. */
export function hierarchyRows(stats: ClassificationStats): Array<[string, number, number]> {
  const order = getHierarchyOrder();
  return order
    .map((level) => {
      const count = stats.hierarchy.get(level) ?? 0;
      return [level, count, pct(count, stats.total)] as [string, number, number];
    })
    .filter(([, count]) => count > 0);
}

/** Division distribution rows for reports (largest first). */
export function divisionRows(stats: ClassificationStats): Array<[string, number, number]> {
  return sortedCounts(stats.division).map(
    ([division, count]) => [division, count, pct(count, stats.total)] as [string, number, number],
  );
}

/** Health summary like the scanner's SUMMARY block. */
export function healthSummary(stats: ClassificationStats): {
  staffCount: number;
  staffPct: number;
  generalCount: number;
  generalPct: number;
  hierarchyStatus: 'OK' | 'NEEDS WORK';
  divisionStatus: 'OK' | 'NEEDS WORK';
} {
  const staffCount = stats.hierarchy.get('Staff') ?? 0;
  const generalCount = stats.division.get('General') ?? 0;
  const staffPct = pct(staffCount, stats.total);
  const generalPct = pct(generalCount, stats.total);
  return {
    staffCount,
    staffPct,
    generalCount,
    generalPct,
    hierarchyStatus: staffPct < 10 ? 'OK' : 'NEEDS WORK',
    divisionStatus: generalPct < 25 ? 'OK' : 'NEEDS WORK',
  };
}

/** Sample of unclassified titles for verbose reports. */
export function unclassifiedSamples(
  stats: ClassificationStats,
  which: 'hierarchy' | 'division',
  size = 10,
): string[] {
  const source = which === 'hierarchy' ? stats.staffTitles : stats.generalTitles;
  return sortedCounts(source)
    .slice(0, size)
    .map(([title, count]) => `${count}x ${title}`);
}
