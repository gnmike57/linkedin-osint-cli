/**
 * People loaders + org chart builder (TypeScript port of osint_build_orgchart.py).
 *
 * loadPeople() accepts every legacy toolkit format:
 *   - array of people
 *   - {"people": [...]}                       (single company scrape)
 *   - {"companies": [{"people": [...]}]}      (batch scrape master DB)
 *   - {"divisions": [{"levels": [...]}]}      (org chart data)
 * plus the CSV written by the legacy company scraper.
 *
 * buildHierarchicalData() classifies every person with the rules engine and
 * groups them into divisions x hierarchy levels, exec-first sorted.
 */

import { readFile } from 'node:fs/promises';
import { parseCsvObjects } from './csv.js';
import {
  classifyTitle,
  cleanTitle,
  getHierarchyOrder,
  getDivisionNames,
  HIERARCHY_LEVELS,
} from './classify.js';

export interface Person {
  name: string;
  title: string;
  profile_url?: string;
  profile_image_url?: string;
  connection_degree?: string;
  company?: string;
  role_level?: string;
  role_weight?: number;
  division_name?: string;
  division_color?: string;
  [key: string]: unknown;
}

/** Map a legacy scraper row (camelCase) to the canonical person shape. */
export function normalizePerson(raw: Record<string, unknown>): Person | null {
  const name = String(raw.name ?? raw.displayName ?? '').trim();
  if (!name) return null;
  return {
    ...raw,
    name,
    title: String(raw.title ?? '').trim(),
    profile_url: String(raw.profile_url ?? raw.profileUrl ?? ''),
    profile_image_url: String(raw.profile_image_url ?? raw.profileImageUrl ?? ''),
    connection_degree: String(raw.connection_degree ?? raw.connectionDegree ?? ''),
    company: raw.company !== undefined ? String(raw.company) : undefined,
  };
}

/** Extract people from arbitrary JSON in one of the toolkit formats. */
export function peopleFromJson(data: unknown): Person[] {
  if (Array.isArray(data)) {
    return data
      .map((p) => normalizePerson(p as Record<string, unknown>))
      .filter((p): p is Person => p !== null);
  }
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.people)) {
      return peopleFromJson(obj.people);
    }
    if (Array.isArray(obj.companies)) {
      const out: Person[] = [];
      for (const company of obj.companies as Array<Record<string, unknown>>) {
        const cname = String(company.company ?? company.name ?? 'Unknown');
        for (const p of (company.people as unknown[]) ?? []) {
          const person = normalizePerson(p as Record<string, unknown>);
          if (person) {
            if (!person.company) person.company = cname;
            out.push(person);
          }
        }
      }
      return out;
    }
    if (Array.isArray(obj.divisions)) {
      const out: Person[] = [];
      for (const division of obj.divisions as Array<Record<string, unknown>>) {
        for (const level of (division.levels as Array<Record<string, unknown>>) ?? []) {
          for (const p of (level.people as unknown[]) ?? []) {
            const person = normalizePerson(p as Record<string, unknown>);
            if (person) {
              person.division_name = String(division.name ?? person.division_name ?? '');
              person.role_level = String(level.name ?? person.role_level ?? '');
              out.push(person);
            }
          }
        }
      }
      return out;
    }
    // Last resort: any list that looks like people
    for (const value of Object.values(obj)) {
      if (
        Array.isArray(value) &&
        value.length > 0 &&
        typeof value[0] === 'object' &&
        value[0] !== null &&
        ('name' in (value[0] as object) || 'title' in (value[0] as object))
      ) {
        return peopleFromJson(value);
      }
    }
  }
  return [];
}

/** Load people from a CSV or JSON file path. */
export async function loadPeopleFile(path: string): Promise<Person[]> {
  const text = await readFile(path, 'utf-8');
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return peopleFromJson(JSON.parse(trimmed));
  }
  // CSV: the legacy scraper's columns
  const rows = parseCsvObjects(trimmed);
  return rows
    .map((row) =>
      normalizePerson({
        name: row['name'],
        title: row['title'],
        profile_url: row['profile_url'],
        profile_image_url: row['profile_image_url'],
        connection_degree: row['connection_degree'],
      }),
    )
    .filter((p): p is Person => p !== null);
}

/** Division display colors (ported from osint_build_orgchart.py). */
export const DIVISION_COLORS: Record<string, string> = {
  'Cyber Security': '#e74c3c',
  'IT Infrastructure': '#3498db',
  'Software Development': '#9b59b6',
  'Data & AI': '#1abc9c',
  'R&D': '#673ab7',
  Product: '#ff5722',
  'Project Management': '#00bcd4',
  Operations: '#ff9800',
  Finance: '#f39c12',
  HR: '#e91e63',
  Marketing: '#8bc34a',
  Sales: '#4caf50',
  'Legal & Compliance': '#607d8b',
  'Customer Service': '#009688',
  Strategy: '#795548',
  Intelligence: '#f44336',
  'Military/Defense': '#455a64',
  General: '#95a5a6',
};

/** Get the display color for a division (gray fallback). */
export function getDivisionColor(divisionName: string): string {
  return DIVISION_COLORS[divisionName] ?? '#95a5a6';
}

/** Deduplicate profiles by normalized name, preferring entries with images. */
export function dedupeByName(profiles: Person[]): Person[] {
  const seen = new Map<string, Person>();
  for (const profile of profiles) {
    const key = profile.name
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, profile);
    } else if (!existing.profile_image_url && profile.profile_image_url) {
      seen.set(key, profile);
    }
  }
  return [...seen.values()];
}

/**
 * Build hierarchical org chart data using the rules engine.
 * Groups by division x hierarchy level, sorts people by name, divisions
 * exec-first then by total people descending.
 */
export function buildHierarchicalData(
  profiles: Person[],
  options: { useAi?: boolean } = {},
): Array<Record<string, unknown>> {
  const allDivisions = [...getDivisionNames(), 'General'];
  const hierarchyOrder = getHierarchyOrder();

  // Classify each profile with the rules engine
  for (const profile of profiles) {
    const result = classifyTitle(profile.title ?? '');
    profile.role_level = result.role_level;
    profile.role_weight = result.role_weight;
    profile.division_name = result.division;
    profile.division_color = getDivisionColor(result.division);
  }

  // NOTE: AI enhancement is applied by the command layer via
  // enhanceClassificationsBatch() before calling this function when --use-ai
  // is set; weights and colors are then recomputed there.

  // Group by division and level
  const divisionsData = new Map<string, Record<string, unknown>>();
  for (const divName of allDivisions) {
    divisionsData.set(divName, {
      id: divName.toLowerCase().replace(/ /g, '_').replace(/&/g, 'and'),
      name: divName,
      color: getDivisionColor(divName),
      levels: new Map(hierarchyOrder.map((level) => [level, [] as Person[]])),
    });
  }

  for (const profile of profiles) {
    let divName = profile.division_name ?? 'General';
    if (!divisionsData.has(divName)) divName = 'General';
    const roleLevel = profile.role_level ?? 'Staff';
    const levels = (divisionsData.get(divName)!['levels'] as Map<string, Person[]>);
    if (!levels.has(roleLevel)) levels.set(roleLevel, []);
    levels.get(roleLevel)!.push(profile);
  }

  // Sort people within each level by name
  for (const divData of divisionsData.values()) {
    for (const people of (divData['levels'] as Map<string, Person[]>).values()) {
      people.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    }
  }

  // Convert to list, filter empty divisions
  const result: Array<Record<string, unknown>> = [];
  for (const divName of allDivisions) {
    const divData = divisionsData.get(divName)!;
    const levelsMap = divData['levels'] as Map<string, Person[]>;
    let totalPeople = 0;
    const levelsList: Array<Record<string, unknown>> = [];
    for (const levelName of hierarchyOrder) {
      const people = levelsMap.get(levelName) ?? [];
      totalPeople += people.length;
      if (people.length > 0) {
        levelsList.push({
          level: HIERARCHY_LEVELS[levelName],
          name: levelName,
          people,
        });
      }
    }
    if (totalPeople === 0) continue;
    result.push({
      id: divData['id'],
      name: divData['name'],
      color: divData['color'],
      total_people: totalPeople,
      levels: levelsList,
    });
  }

  // Sort: Executive Leadership first, then by total people descending
  result.sort((a, b) => {
    const aExec = String(a['id']).includes('executive') ? 0 : 1;
    const bExec = String(b['id']).includes('executive') ? 0 : 1;
    if (aExec !== bExec) return aExec - bExec;
    return (b['total_people'] as number) - (a['total_people'] as number);
  });

  return result;
}

