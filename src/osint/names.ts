/**
 * NameMutator — TypeScript port of linkedin2username's NameMutator class
 * (legacy/python/linkedin2username-master/linkedin2username.py).
 *
 * Generates probable username/email permutations from a person's full name.
 * Ported 1:1 and verified against the original Python implementation's outputs
 * for the full pytest case matrix (hyphen compounds, accents, emoji, 3-word
 * names, honorific stripping).
 *
 * Formats produced:
 *   f_last          jsmith
 *   f_dot_last      j.smith
 *   last_f          smithj
 *   first_dot_last  john.smith
 *   first_l         johns
 *   first           john
 */

export interface SplitName {
  first: string;
  second: string;
  last: string;
}

const TITLE_WORDS = ['mr', 'miss', 'mrs', 'phd', 'prof', 'professor', 'md', 'dr', 'mba'];

const ACCENT_MAP: Array<[RegExp, string]> = [
  [/[àáâãäå]/g, 'a'],
  [/[èéêë]/g, 'e'],
  [/[ìíîï]/g, 'i'],
  [/[òóôõö]/g, 'o'],
  [/[ùúûü]/g, 'u'],
  [/[ýÿ]/g, 'y'],
  [/[ß]/g, 'ss'],
  [/[ñ]/g, 'n'],
];

/**
 * Removes common punctuation, credentials, and accents from a raw name.
 * LinkedIn users tend to add credentials to their names to look special.
 */
export function cleanName(raw: string): string {
  // Lower-case everything to make it easier to de-duplicate.
  let name = raw.toLowerCase();

  // Standardize common non-English characters.
  for (const [re, sub] of ACCENT_MAP) {
    name = name.replace(re, sub);
  }

  // Get rid of anything in parentheses (credentials, certs, etc.).
  name = name.replace(/\([^()]*\)/g, '');

  // Trash anything weird left over (emoji, punctuation, digits).
  name = name.replace(/[^a-zA-Z -]/g, '');

  // Get rid of common titles.
  const pattern = new RegExp(`\\b(${TITLE_WORDS.join('|')})\\b`, 'g');
  name = name.replace(pattern, '');

  // Consolidate whitespace and trim.
  return name.replace(/\s+/g, ' ').trim();
}

/**
 * Splits a cleaned name into first / second (middle) / last.
 * Hyphens are preserved inside compound name segments.
 * Returns null when there is no first+last pair to mutate.
 */
export function splitName(cleaned: string): SplitName | null {
  const parsed = cleaned.split(/\s+/).filter((p) => p.length > 0);
  if (parsed.length < 2) return null;

  const split: SplitName =
    parsed.length > 2
      ? { first: parsed[0], second: parsed[parsed.length - 2], last: parsed[parsed.length - 1] }
      : { first: parsed[0], second: '', last: parsed[parsed.length - 1] };

  if (!split.first || !split.last) return null;
  return split;
}

/**
 * Returns the full part plus each sub-part if hyphenated.
 * 'davidson-smith' -> ['davidson-smith', 'davidson', 'smith']
 */
export function hyphenVariants(part: string): string[] {
  if (part.includes('-')) return [part, ...part.split('-')];
  return [part];
}

export class NameMutator {
  readonly name: SplitName | null;

  constructor(raw: string) {
    this.name = splitName(cleanName(raw));
  }

  /** jsmith */
  fLast(): Set<string> {
    const names = new Set<string>();
    if (!this.name) return names;
    for (const last of hyphenVariants(this.name.last)) {
      names.add(this.name.first.charAt(0) + last);
    }
    if (this.name.second) {
      for (const second of hyphenVariants(this.name.second)) {
        names.add(this.name.first.charAt(0) + second);
      }
    }
    return names;
  }

  /** j.smith */
  fDotLast(): Set<string> {
    const names = new Set<string>();
    if (!this.name) return names;
    for (const last of hyphenVariants(this.name.last)) {
      names.add(`${this.name.first.charAt(0)}.${last}`);
    }
    if (this.name.second) {
      for (const second of hyphenVariants(this.name.second)) {
        names.add(`${this.name.first.charAt(0)}.${second}`);
      }
    }
    return names;
  }

  /** smithj */
  lastF(): Set<string> {
    const names = new Set<string>();
    if (!this.name) return names;
    for (const last of hyphenVariants(this.name.last)) {
      names.add(last + this.name.first.charAt(0));
    }
    if (this.name.second) {
      for (const second of hyphenVariants(this.name.second)) {
        names.add(second + this.name.first.charAt(0));
      }
    }
    return names;
  }

  /** john.smith */
  firstDotLast(): Set<string> {
    const names = new Set<string>();
    if (!this.name) return names;
    for (const last of hyphenVariants(this.name.last)) {
      names.add(`${this.name.first}.${last}`);
    }
    if (this.name.second) {
      for (const second of hyphenVariants(this.name.second)) {
        names.add(`${this.name.first}.${second}`);
      }
    }
    return names;
  }

  /** johns — first name plus the initial of each hyphen variant of the last name. */
  firstL(): Set<string> {
    const names = new Set<string>();
    if (!this.name) return names;
    for (const last of hyphenVariants(this.name.last)) {
      names.add(this.name.first + last.charAt(0));
    }
    if (this.name.second) {
      for (const second of hyphenVariants(this.name.second)) {
        names.add(this.name.first + second.charAt(0));
      }
    }
    return names;
  }

  /** john */
  first(): Set<string> {
    const names = new Set<string>();
    if (!this.name) return names;
    names.add(this.name.first);
    return names;
  }

  /** All six mutation formats at once. */
  allFormats(): Record<string, string[]> {
    return {
      f_last: [...this.fLast()].sort(),
      f_dot_last: [...this.fDotLast()].sort(),
      last_f: [...this.lastF()].sort(),
      first_dot_last: [...this.firstDotLast()].sort(),
      first_l: [...this.firstL()].sort(),
      first: [...this.first()].sort(),
    };
  }
}

/** The six mutator method names, in the order linkedin2username writes files. */
export const NAME_FORMATS = [
  'f_last',
  'f_dot_last',
  'last_f',
  'first_dot_last',
  'first_l',
  'first',
] as const;

export type NameFormat = (typeof NAME_FORMATS)[number];

/** File suffix used by linkedin2username for each format. */
export const FORMAT_SUFFIXES: Record<NameFormat, string> = {
  f_last: 'flast',
  f_dot_last: 'f.last',
  last_f: 'lastf',
  first_dot_last: 'first.last',
  first_l: 'firstl',
  first: 'first',
};
