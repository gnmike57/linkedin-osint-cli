/**
 * Role Classifier — Data-Driven Engine (TypeScript port of osint_classify_rules.py)
 *
 * Classifies LinkedIn job titles into hierarchy levels and functional
 * divisions using ALL classification data from classification_rules.json
 * (learned from ~30K real profiles). This module is the engine only — edit
 * the JSON to tune classification.
 *
 * Hierarchy levels (most → least senior):
 * Executive 100, VP 90, Director 80, Head 70, Manager 60, Lead 50,
 * Senior 45, Specialist 40, Mid-Level 30, Junior 20, Entry 10, Staff 5.
 *
 * Ported 1:1 (including the directorate disambiguation, junior-modifier
 * suppression, compound pipe/slash handling, and the division-keyword →
 * Mid-Level fallback) and verified against the Python engine's 75/75
 * self-test.
 */

import rulesJson from './data/classification_rules.json';

export interface TitleOverride {
  level?: string;
  division?: string;
}

export const RULES = rulesJson as unknown as {
  meta: { version: string; last_updated?: string; profile_count?: number; description?: string };
  hierarchy_levels: Record<string, number>;
  division_keywords: Record<string, string[]>;
  title_overrides: Record<string, TitleOverride>;
  non_title_patterns: string[];
  company_name_patterns: string[];
  hierarchy_patterns: Array<{
    level?: string;
    pattern?: string;
    patterns?: string[];
    exclude?: string;
    require?: string;
    reclassify_to_specialist?: string;
    skip_if_junior?: boolean;
  }>;
};

export const HIERARCHY_LEVELS: Record<string, number> = RULES.hierarchy_levels;
export const DIVISION_KEYWORDS: Record<string, string[]> = RULES.division_keywords;

const NON_TITLE_RES = RULES.non_title_patterns.map((p) => new RegExp(p, 'i'));
const COMPANY_NAME_RES = (RULES.company_name_patterns ?? []).map((p) => new RegExp(p, 'i'));
const TITLE_OVERRIDES = new Map<string, TitleOverride>(
  Object.entries(RULES.title_overrides).map(([k, v]) => [k.toLowerCase(), v]),
);

interface CompiledRule {
  level: string;
  weight: number;
  compiled: RegExp[];
  multi: boolean;
  exclude: RegExp | null;
  require: RegExp | null;
  reclassifyToSpecialist: RegExp | null;
  skipIfJunior: boolean;
}

const HIERARCHY_RULES: CompiledRule[] = RULES.hierarchy_patterns.map((rule) => {
  const level = rule.level ?? 'Staff';
  const weight = HIERARCHY_LEVELS[level] ?? HIERARCHY_LEVELS['Staff'];
  const compiled = (rule.patterns ?? (rule.pattern ? [rule.pattern] : [])).map(
    (p) => new RegExp(p, 'i'),
  );
  return {
    level,
    weight,
    compiled,
    multi: Array.isArray(rule.patterns),
    exclude: rule.exclude ? new RegExp(rule.exclude, 'i') : null,
    require: rule.require ? new RegExp(rule.require, 'i') : null,
    reclassifyToSpecialist: rule.reclassify_to_specialist
      ? new RegExp(rule.reclassify_to_specialist, 'i')
      : null,
    skipIfJunior: rule.skip_if_junior ?? false,
  };
});

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const JUNIOR_MODIFIER_RE =
  /\b(junior|jr\.?|associate|assistant|intern|student|trainee|cadet)\b/i;

/** Clean a raw LinkedIn title for classification. */
export function cleanTitle(title: string): string {
  if (!title) return '';

  const stripped = title.trim();
  const titleLower = stripped.toLowerCase();

  // Filter junk entries
  for (const rx of NON_TITLE_RES) {
    if (rx.test(titleLower)) return '';
  }

  // Filter company-name-only entries
  for (const rx of COMPANY_NAME_RES) {
    if (rx.test(titleLower)) return '';
  }

  // Strip "at Company Name" suffix (case-insensitive)
  let cleaned = stripped.replace(/\s+at\s+\S.*$/i, '');

  // Strip trailing parenthetical company names
  cleaned = cleaned.replace(/\s*\(former\s+known\s+.*$/i, '');
  cleaned = cleaned.replace(/\s*\([^)]{15,}\)\s*$/, '');

  // Strip trailing "- COMPANY" tails, but only when the tail actually looks
  // like a company name: ALL-CAPS ("- STRIPE", "- GOOGLE INC") or ending in a
  // corporate marker (Inc/LLC/Ltd/GmbH/Corp/…). Mixed-case tails like
  // "- Customer Success" carry real division keywords and are kept.
  cleaned = cleaned.replace(
    /\s+-\s+([A-Z][A-Z0-9a-z\s.&]*)$/,
    (whole, tail: string) => {
      const hasLowercase = /[a-z]/.test(tail);
      const corporateMarker =
        /\b(inc|llc|ltd|gmbh|corp|corporation|company|co|group|plc|pty|srl|bv|ab|ag|se|s\.a)\.?$/i.test(
          tail,
        );
      return !hasLowercase || corporateMarker ? '' : whole;
    },
  );

  return cleaned.trim();
}

/**
 * Classify a job title into a hierarchy level.
 * Strategy: exact overrides → compound parts → collect all pattern matches,
 * return the highest weight (first-wins on ties), then the division-keyword
 * Mid-Level fallback.
 */
export function classifyRoleLevel(title: string): [string, number] {
  if (!title) return ['Staff', HIERARCHY_LEVELS['Staff']];

  const cleaned = cleanTitle(title);
  if (!cleaned) return ['Staff', HIERARCHY_LEVELS['Staff']];

  // --- 1. Exact override lookup ---
  const override = TITLE_OVERRIDES.get(cleaned.toLowerCase());
  if (override && override.level) {
    return [override.level, HIERARCHY_LEVELS[override.level] ?? HIERARCHY_LEVELS['Staff']];
  }

  // --- 2. Handle pipe/slash-separated compound titles ---
  for (const sep of ['|', '/']) {
    if (cleaned.includes(sep)) {
      const parts = cleaned
        .split(sep)
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      if (parts.length > 1) {
        let best: [string, number] = ['Staff', HIERARCHY_LEVELS['Staff']];
        for (const part of parts) {
          const [lvl, w] = classifyRoleLevel(part);
          if (w > best[1]) best = [lvl, w];
        }
        if (best[1] > HIERARCHY_LEVELS['Staff']) return best;
      }
    }
  }

  // --- 3. Pattern-based classification ---
  const titleLower = cleaned.toLowerCase();
  const matches: Array<[string, number]> = [];
  const hasJuniorModifier = JUNIOR_MODIFIER_RE.test(titleLower);

  for (const rule of HIERARCHY_RULES) {
    // Skip mid-level roles if junior modifier present
    if (rule.skipIfJunior && hasJuniorModifier) continue;

    // Check require constraint
    if (rule.require && !rule.require.test(titleLower)) continue;

    if (rule.multi) {
      for (const rx of rule.compiled) {
        if (!rx.test(titleLower)) continue;
        // Check exclude (exclusion of one pattern doesn't disqualify the rest)
        if (rule.exclude && rule.exclude.test(titleLower)) continue;
        // Check reclassify
        if (rule.reclassifyToSpecialist && rule.reclassifyToSpecialist.test(titleLower)) {
          matches.push(['Specialist', HIERARCHY_LEVELS['Specialist']]);
        } else {
          matches.push([rule.level, rule.weight]);
        }
        break; // one match per rule group is enough
      }
    } else {
      const rx = rule.compiled[0];
      if (rx && rx.test(titleLower)) {
        if (rule.exclude && rule.exclude.test(titleLower)) continue;
        if (rule.reclassifyToSpecialist && rule.reclassifyToSpecialist.test(titleLower)) {
          matches.push(['Specialist', HIERARCHY_LEVELS['Specialist']]);
        } else {
          matches.push([rule.level, rule.weight]);
        }
      }
    }
  }

  // Special: "director" vs "directorate" disambiguation
  if (matches.some(([lvl]) => lvl === 'Director') && titleLower.includes('directorate')) {
    const dirPos = titleLower.indexOf('director');
    const dtoratePos = titleLower.indexOf('directorate');
    // If "directorate" appears at the same position, it's a company name
    if (dirPos === dtoratePos) {
      for (let i = matches.length - 1; i >= 0; i--) {
        if (matches[i][0] === 'Director') matches.splice(i, 1);
      }
    }
  }

  if (matches.length > 0) {
    let best = matches[0];
    for (const m of matches) {
      if (m[1] > best[1]) best = m;
    }
    return best;
  }

  // --- 4. Fallback: division-keyword match → Mid-Level ---
  // Titles like "Cloud & Information Security" are department-name-as-title
  // entries; Mid-Level is a reasonable default rather than Staff.
  const titleForDiv = cleaned.replace(/\|/g, ' ').replace(/\//g, ' ').toLowerCase();
  for (const keywords of Object.values(DIVISION_KEYWORDS)) {
    for (const kw of keywords) {
      const kwLower = kw.toLowerCase();
      if (kwLower.length <= 3) {
        if (new RegExp(`\\b${escapeRegExp(kwLower)}\\b`).test(titleForDiv)) {
          return ['Mid-Level', HIERARCHY_LEVELS['Mid-Level']];
        }
      } else if (titleForDiv.includes(kwLower)) {
        return ['Mid-Level', HIERARCHY_LEVELS['Mid-Level']];
      }
    }
  }

  return ['Staff', HIERARCHY_LEVELS['Staff']];
}

/** Classify a job title into a functional division (keyword scoring). */
export function classifyDivision(title: string): string {
  if (!title) return 'General';

  const cleaned = cleanTitle(title);
  if (!cleaned) return 'General';

  // --- 1. Exact override lookup ---
  const override = TITLE_OVERRIDES.get(cleaned.toLowerCase());
  if (override && override.division) return override.division;

  // --- 2. Keyword scoring (pipes/slashes merged to spaces) ---
  const titleLower = cleaned.replace(/\|/g, ' ').replace(/\//g, ' ').toLowerCase();

  const scores = new Map<string, number>();
  for (const [division, keywords] of Object.entries(DIVISION_KEYWORDS)) {
    let score = 0;
    for (const keyword of keywords) {
      const kwLower = keyword.toLowerCase();
      if (kwLower.length <= 3) {
        if (new RegExp(`\\b${escapeRegExp(kwLower)}\\b`).test(titleLower)) {
          score += kwLower.length + 5;
        }
      } else if (titleLower.includes(kwLower)) {
        score += kwLower.length;
      }
    }
    if (score > 0) scores.set(division, score);
  }

  if (scores.size > 0) {
    // First-wins on ties, matching Python's max(scores, key=scores.get)
    let bestDivision = '';
    let bestScore = -1;
    for (const [division, score] of scores) {
      if (score > bestScore) {
        bestScore = score;
        bestDivision = division;
      }
    }
    return bestDivision;
  }

  return 'General';
}

/** Fully classify a job title. */
export function classifyTitle(title: string): {
  role_level: string;
  role_weight: number;
  division: string;
} {
  const [level, weight] = classifyRoleLevel(title);
  return { role_level: level, role_weight: weight, division: classifyDivision(title) };
}

/** Hierarchy levels ordered from most senior to least. */
export function getHierarchyOrder(): string[] {
  return Object.keys(HIERARCHY_LEVELS).sort((a, b) => HIERARCHY_LEVELS[b] - HIERARCHY_LEVELS[a]);
}

/** Division names in the JSON's canonical order. */
export function getDivisionNames(): string[] {
  return Object.keys(DIVISION_KEYWORDS);
}
