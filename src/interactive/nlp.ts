/*
 * Local, deterministic NLP parser for the interactive shell (spec §5).
 *
 * Pipeline: text → tokenize → intent scoring over the command catalog →
 * pick command(s) → entity extraction into Zod-field slots → ParseResult.
 *
 * No I/O, no client, no env access, no randomness — parse() is deep-equal
 * for the same (text, commands) pair. The ambiguity memory lives outside
 * the parser (a Map owned by the shell) so the parser stays pure.
 */

import type { CommandDefinition } from '../core/types.js';
import { flagTakesValue, longFlag } from './catalog.js';
import {
  COMMAND_SYNONYMS,
  VALUE_TRIGGERS,
  REACTION_WORDS,
  NUMBER_CONTEXT,
  URN_FIELD_HINTS,
  OVERLAP_STOPWORDS,
  LOCATION_FIELD,
  NEVER_GUESSED_FIELDS,
} from './nlp-synonyms.js';

export interface Token {
  /** Original text (case and inner punctuation preserved; quotes stripped). */
  raw: string;
  /** Lowercased text used for matching. */
  lower: string;
  /** Inside double quotes — value semantics, never used for intent scoring. */
  quoted: boolean;
}

/** A synonym phrase matched at token range [start, end). */
export interface SynonymHit {
  phrase: string;
  start: number;
  end: number;
}

/** Spec §5.5 ParseResult. */
export interface ParsedCommand {
  command: CommandDefinition;
  /** Extracted slots (pre-Zod). */
  input: Record<string, unknown>;
  matched: { via: 'nlp' | 'session-memory'; score: number };
  /** Present only on ambiguity. */
  candidates?: CommandDefinition[];
  /** Tokens not consumed by intent or slot extraction. */
  unclaimed: string[];
}

export type ParseOutcome =
  | { kind: 'match'; parsed: ParsedCommand }
  | { kind: 'ambiguity'; parsed: ParsedCommand; candidates: CommandDefinition[]; phrase: string }
  | { kind: 'refusal'; nearest: CommandDefinition[] };

/** Tokenize respecting double quotes; strips edge punctuation on bare tokens. */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const isSpace = (ch: string): boolean => /\s/.test(ch);
  let i = 0;
  while (i < text.length) {
    if (isSpace(text[i]!)) {
      i++;
      continue;
    }
    if (text[i] === '"') {
      const end = text.indexOf('"', i + 1);
      if (end !== -1) {
        const raw = text.slice(i + 1, end).trim();
        if (raw) tokens.push({ raw, lower: raw.toLowerCase(), quoted: true });
        i = end + 1;
        continue;
      }
    }
    let j = i;
    while (j < text.length && !isSpace(text[j]!)) j++;
    const raw = text.slice(i, j).replace(/^[,.;:!?]+|[,.;:!?]+$/g, '');
    if (raw) tokens.push({ raw, lower: raw.toLowerCase(), quoted: false });
    i = j;
  }
  return tokens;
}

function searchTextOf(command: CommandDefinition): string {
  return `${command.group} ${command.subcommand} ${command.name} ${command.description}`.toLowerCase();
}

function wordBoundaryIncludes(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(haystack);
}

/**
 * Contiguous phrase matches over the full token sequence (case-insensitive).
 * At each position the longest phrase wins; matches never overlap.
 */
export function synonymHits(command: CommandDefinition, tokens: Token[]): SynonymHit[] {
  const phrases = COMMAND_SYNONYMS[command.name] ?? [];
  const byLength = [...phrases].sort((a, b) => b.split(' ').length - a.split(' ').length);
  const hits: SynonymHit[] = [];
  let i = 0;
  outer: while (i < tokens.length) {
    for (const phrase of byLength) {
      const parts = phrase.split(' ');
      if (i + parts.length > tokens.length) continue;
      let ok = true;
      for (let k = 0; k < parts.length; k++) {
        if (tokens[i + k]!.lower !== parts[k]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        hits.push({ phrase, start: i, end: i + parts.length });
        i += parts.length;
        continue outer;
      }
    }
    i++;
  }
  return hits;
}

/** Spec §5.2 scoring: 3× multi-word synonyms + 2× single synonyms + 1× overlap. */
function scoreCommand(searchText: string, tokens: Token[], hits: SynonymHit[]): number {
  const multi = hits.filter((hit) => hit.phrase.includes(' ')).length;
  const single = hits.length - multi;
  const seen = new Set<string>();
  let overlap = 0;
  for (const token of tokens) {
    if (token.quoted || token.lower.length < 2) continue;
    if (OVERLAP_STOPWORDS.has(token.lower) || seen.has(token.lower)) continue;
    seen.add(token.lower);
    if (wordBoundaryIncludes(searchText, token.lower)) overlap++;
  }
  return 3 * multi + 2 * single + overlap;
}

/** Stable phrase key for the shell's ambiguity memory (quoted values dropped). */
export function phraseKey(tokens: Token[]): string {
  return tokens.filter((token) => !token.quoted).map((token) => token.lower).join(' ');
}

function leftoverTokens(tokens: Token[]): string[] {
  return tokens
    .filter((token) => !token.quoted && !OVERLAP_STOPWORDS.has(token.lower))
    .map((token) => token.raw);
}

/**
 * Parse a plain-English phrase against the command catalog.
 *
 * - top score < 2 → refusal with the nearest catalog entries (§5.3)
 * - two or more commands within 1 point of the top → ambiguity candidates
 * - otherwise → single match with extracted slots
 */
export function parse(
  text: string,
  commands: CommandDefinition[],
  memory?: ReadonlyMap<string, string>,
): ParseOutcome {
  const tokens = tokenize(text);
  const key = phraseKey(tokens);

  if (memory && key && memory.has(key)) {
    const remembered = commands.find((command) => command.name === memory.get(key));
    if (remembered) {
      const { input, unclaimed } = extractSlots(remembered, tokens, synonymHits(remembered, tokens));
      return {
        kind: 'match',
        parsed: {
          command: remembered,
          input,
          matched: { via: 'session-memory', score: Number.MAX_SAFE_INTEGER },
          unclaimed,
        },
      };
    }
  }

  const scored = commands
    .map((command, index) => {
      const hits = synonymHits(command, tokens);
      return { command, index, hits, score: scoreCommand(searchTextOf(command), tokens, hits) };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const top = scored[0];
  if (!top || top.score < 2) {
    return { kind: 'refusal', nearest: nearestEntries(text, commands, 5) };
  }

  const tied = scored.filter((entry) => entry.score >= top.score - 1);
  if (tied.length > 1) {
    const candidateCommands = tied.map((entry) => entry.command);
    return {
      kind: 'ambiguity',
      candidates: candidateCommands,
      phrase: key,
      parsed: {
        command: top.command,
        input: {},
        matched: { via: 'nlp', score: top.score },
        candidates: candidateCommands,
        unclaimed: leftoverTokens(tokens),
      },
    };
  }

  const { input, unclaimed } = extractSlots(top.command, tokens, top.hits);
  return {
    kind: 'match',
    parsed: {
      command: top.command,
      input,
      matched: { via: 'nlp', score: top.score },
      unclaimed,
    },
  };
}

/** Nearest catalog entries by token overlap — used for refusals (§5.3). */
export function nearestEntries(
  text: string,
  commands: CommandDefinition[],
  count: number,
): CommandDefinition[] {
  const tokens = tokenize(text);
  const scored = commands
    .map((command, index) => {
      const searchText = searchTextOf(command);
      const seen = new Set<string>();
      let score = 0;
      for (const token of tokens) {
        if (token.quoted || token.lower.length < 2) continue;
        if (OVERLAP_STOPWORDS.has(token.lower) || seen.has(token.lower)) continue;
        seen.add(token.lower);
        if (wordBoundaryIncludes(searchText, token.lower)) score++;
      }
      return { command, index, score };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const best = scored.filter((entry) => entry.score > 0).slice(0, count).map((entry) => entry.command);
  return best.length > 0 ? best : commands.slice(0, count);
}

/** Where a Zod field sits in the command's CLI mapping. */
export interface FieldInfo {
  field: string;
  kind: 'string' | 'number' | 'boolean' | 'enum' | 'other';
  /** Allowed values for enum fields. */
  values?: string[];
  /** Mapped as a positional CLI argument. */
  positional: boolean;
  required: boolean;
  /** Long flag that takes a value, e.g. `--limit`. */
  flag?: string;
  /** Long flag that is a boolean, e.g. `--remote`. */
  boolFlag?: string;
}

function unwrapZod(node: unknown): any {
  let cur = node as any;
  for (let i = 0; i < 8 && cur?.def; i++) {
    const t = cur.def.type;
    if (t === 'optional' || t === 'default' || t === 'nullable' || t === 'catch') {
      cur = cur.def.innerType;
      continue;
    }
    return cur;
  }
  return cur;
}

function zodKindOf(node: unknown): { kind: FieldInfo['kind']; values?: string[] } {
  const core = unwrapZod(node);
  const t = core?.def?.type;
  if (t === 'string') return { kind: 'string' };
  if (t === 'number') return { kind: 'number' };
  if (t === 'boolean') return { kind: 'boolean' };
  if (t === 'enum') {
    const values = Array.isArray(core.options) ? core.options.map(String) : undefined;
    return { kind: 'enum', values };
  }
  return { kind: 'other' };
}

function zodIsRequired(node: unknown): boolean {
  const schema = node as { isOptional?: () => boolean } | undefined;
  return typeof schema?.isOptional === 'function' ? !schema.isOptional() : true;
}

/** Ordered field info for a command: positional args first, then options. */
export function fieldInfos(command: CommandDefinition): FieldInfo[] {
  const shape = (command.inputSchema as unknown as { shape: Record<string, unknown> }).shape ?? {};
  const infos: FieldInfo[] = [];
  for (const arg of command.cliMappings.args ?? []) {
    const node = shape[arg.field];
    const { kind, values } = zodKindOf(node);
    infos.push({
      field: arg.field,
      kind,
      values,
      positional: true,
      required: arg.required ?? zodIsRequired(node),
      flag: undefined,
      boolFlag: undefined,
    });
  }
  for (const option of command.cliMappings.options ?? []) {
    const node = shape[option.field];
    const { kind, values } = zodKindOf(node);
    const flag = longFlag(option.flags);
    const takesValue = flagTakesValue(option.flags);
    infos.push({
      field: option.field,
      kind,
      values,
      positional: false,
      required: zodIsRequired(node),
      flag: takesValue ? flag : undefined,
      boolFlag: takesValue ? undefined : flag,
    });
  }
  return infos;
}

/** Coerce a raw string into the field's Zod type (boolean/number/string). */
export function coerceValue(command: CommandDefinition, field: string, raw: string): unknown {
  const info = fieldInfos(command).find((entry) => entry.field === field);
  const value = raw.trim();
  if (!info) return value;
  if (info.kind === 'boolean') {
    return ['true', '1', 'y', 'yes'].includes(value.toLowerCase());
  }
  if (info.kind === 'number') {
    const n = Number(value);
    return Number.isNaN(n) ? value : n;
  }
  return value;
}

/** Allowed enum values for a field (empty when the field is not an enum). */
export function enumValuesOf(command: CommandDefinition, field: string): string[] {
  return fieldInfos(command).find((entry) => entry.field === field)?.values ?? [];
}

/**
 * Entity extraction into Zod slots (§5.4). Deterministic; anything it cannot
 * place with confidence stays unfilled and is reported in `unclaimed`, so
 * NLP can never invent an invalid input.
 */
export function extractSlots(
  command: CommandDefinition,
  tokens: Token[],
  hits: SynonymHit[] = [],
): { input: Record<string, unknown>; unclaimed: string[] } {
  const infos = fieldInfos(command);
  const input: Record<string, unknown> = {};
  const consumed = new Array<boolean>(tokens.length).fill(false);
  for (const hit of hits) {
    for (let i = hit.start; i < hit.end; i++) consumed[i] = true;
  }

  const isDigit = (raw: string): boolean => /^\d+$/.test(raw);
  const isGuessable = (info: FieldInfo): boolean =>
    info.kind === 'string' && !NEVER_GUESSED_FIELDS.has(info.field);
  const canTakeRaw = (info: FieldInfo, raw: string): boolean =>
    !(isDigit(raw) && info.kind === 'string' && !URN_FIELD_HINTS.has(info.field));

  // 0) Reaction words fill engage_react's `type` even when the same token is
  //    also a synonym ("like") — double duty by design (§5.4).
  if (command.name === 'engage_react') {
    const typeField = infos.find((f) => f.field === 'type' && f.kind === 'enum');
    if (typeField) {
      for (const token of tokens) {
        const value = REACTION_WORDS[token.lower];
        if (value && input['type'] === undefined) input['type'] = value;
      }
    }
  }

  const blockedWords: string[] = [];

  // 1) Quoted strings → required string fields first, then optional ones
  //    (mapping order inside each group); URN-typed fields (geo) are skipped.
  const stringPool = infos.filter(isGuessable);
  const orderedPool = [
    ...stringPool.filter((f) => f.required),
    ...stringPool.filter((f) => !f.required),
  ];
  for (let i = 0; i < tokens.length; i++) {
    if (!tokens[i]!.quoted || consumed[i]) continue;
    const target = orderedPool.find((f) => input[f.field] === undefined);
    if (!target) break;
    input[target.field] = tokens[i]!.raw;
    consumed[i] = true;
  }

  // 2) Value triggers (multi-token first) + reaction words + enum/sort/boolean.
  const triggerKeys = Object.keys(VALUE_TRIGGERS).sort((a, b) => b.length - a.length);
  for (let i = 0; i < tokens.length; i++) {
    if (consumed[i] || tokens[i]!.quoted) continue;
    if (command.name === 'engage_react' && REACTION_WORDS[tokens[i]!.lower]) {
      const typeField = infos.find((f) => f.field === 'type' && f.kind === 'enum');
      if (typeField && input['type'] === undefined) {
        input['type'] = REACTION_WORDS[tokens[i]!.lower];
        consumed[i] = true;
        continue;
      }
    }
    let matched = false;
    for (const key of triggerKeys) {
      const parts = key.split(' ');
      if (parts.length < 2 || i + parts.length > tokens.length) continue;
      const ok = parts.every((p, k) => !consumed[i + k] && tokens[i + k]!.lower === p);
      if (!ok) continue;
      const trigger = VALUE_TRIGGERS[key]!;
      const field = infos.find((f) => f.field === trigger.field);
      if (!field || input[field.field] !== undefined) continue;
      if (field.kind === 'enum' && !(field.values ?? []).includes(String(trigger.value))) continue;
      input[field.field] = trigger.value;
      for (let k = 0; k < parts.length; k++) consumed[i + k] = true;
      matched = true;
      break;
    }
    if (matched) continue;
    const single = VALUE_TRIGGERS[tokens[i]!.lower];
    if (single) {
      const field = infos.find((f) => f.field === single.field);
      const enumBlocks =
        field?.kind === 'enum' && !(field.values ?? []).includes(String(single.value));
      if (field && !enumBlocks && input[field.field] === undefined) {
        input[field.field] = single.value;
        consumed[i] = true;
      }
    }
  }

  // 3) Location phrases: "in [the] <place>" → free-string `location` only.
  const locationField = infos.find((f) => f.field === LOCATION_FIELD && f.kind === 'string');
  for (let i = 0; i < tokens.length; i++) {
    if (consumed[i] || tokens[i]!.lower !== 'in') continue;
    let j = i + 1;
    if (tokens[j]?.lower === 'the') j++;
    const place: string[] = [];
    const idxs: number[] = [];
    while (j < tokens.length && place.length < 3) {
      const t = tokens[j]!;
      if (
        t.quoted || consumed[j] || OVERLAP_STOPWORDS.has(t.lower) ||
        VALUE_TRIGGERS[t.lower] !== undefined || REACTION_WORDS[t.lower] !== undefined ||
        isDigit(t.lower)
      ) break;
      place.push(t.raw);
      idxs.push(j);
      j++;
    }
    if (locationField && place.length > 0 && input[locationField.field] === undefined) {
      input[locationField.field] = place.join(' ');
      consumed[i] = true;
      if (tokens[i + 1]?.lower === 'the') consumed[i + 1] = true;
      for (const idx of idxs) consumed[idx] = true;
    } else if (!locationField && place.length > 0) {
      // Location intent with no location slot: the place words belong to the
      // guided prompt — never leaked into keywords/ids (§5.4).
      for (const idx of idxs) consumed[idx] = true;
      blockedWords.push(...place);
    }
  }

  // 4) Integers: URN ids for commands that declare them, then numeric affinity.
  const numericFields = infos.filter((f) => f.kind === 'number');
  const numericTarget = (prev?: string, next?: string): FieldInfo | undefined => {
    if (prev) {
      const byName = numericFields.find(
        (f) => f.field === prev || f.field.replace(/_/g, '-') === prev.replace(/_/g, '-'),
      );
      if (byName && input[byName.field] === undefined) return byName;
    }
    const context = [prev, next].filter((value): value is string => value !== undefined);
    for (const name of ['count', 'limit', 'start'] as const) {
      const field = numericFields.find((f) => f.field === name);
      if (!field || input[field.field] !== undefined) continue;
      if (context.some((word) => NUMBER_CONTEXT[name].includes(word))) return field;
    }
    for (const name of ['count', 'limit', 'start'] as const) {
      const field = numericFields.find((f) => f.field === name);
      if (field && input[field.field] === undefined) return field;
    }
    return undefined;
  };
  for (let i = 0; i < tokens.length; i++) {
    if (consumed[i] || tokens[i]!.quoted || !isDigit(tokens[i]!.lower)) continue;
    const digits = tokens[i]!.lower;
    const prev = i > 0 && !consumed[i - 1] ? tokens[i - 1]!.lower : undefined;
    const next = i + 1 < tokens.length && !consumed[i + 1] ? tokens[i + 1]!.lower : undefined;
    if (digits.length >= 7) {
      const urnField = infos.find(
        (f) => f.kind === 'string' && URN_FIELD_HINTS.has(f.field) && input[f.field] === undefined,
      );
      if (urnField) {
        input[urnField.field] = digits;
        consumed[i] = true;
        continue;
      }
    }
    const target = numericTarget(prev, next);
    if (target) {
      input[target.field] = Number(digits);
      consumed[i] = true;
      continue;
    }
    // No numeric slot: keep numeric context words with their number ("limit
    // 50" on a command without --limit) — both go to unclaimed, never leaked
    // into keyword-style fields.
    const contextWords = new Set([
      ...NUMBER_CONTEXT.count, ...NUMBER_CONTEXT.limit, ...NUMBER_CONTEXT.start,
    ]);
    const prevIsNumericContext =
      prev !== undefined &&
      (contextWords.has(prev) ||
        numericFields.some((f) => f.field.replace(/_/g, '-') === prev.replace(/_/g, '-')));
    if (prevIsNumericContext) {
      consumed[i - 1] = true;
      blockedWords.push(prev!, digits);
      consumed[i] = true;
    }
  }

  // 5) Leftover bare tokens → positional args; "at|from|for <token>" first.
  const leftovers: Array<{ raw: string; idx: number }> = [];
  for (let i = 0; i < tokens.length; i++) {
    if (consumed[i] || tokens[i]!.quoted || OVERLAP_STOPWORDS.has(tokens[i]!.lower)) continue;
    leftovers.push({ raw: tokens[i]!.raw, idx: i });
  }
  const positionals = infos.filter((f) => f.positional && isGuessable(f));
  const prepositions = new Set(['at', 'from', 'for']);
  for (let i = 0; i < tokens.length; i++) {
    if (consumed[i] || tokens[i]!.quoted || !prepositions.has(tokens[i]!.lower)) continue;
    const next = leftovers.find((entry) => entry.idx === i + 1 && !consumed[entry.idx]);
    if (!next) continue;
    const target = positionals.find((f) => input[f.field] === undefined && canTakeRaw(f, next.raw));
    if (!target) continue;
    input[target.field] = next.raw;
    consumed[next.idx] = true;
    consumed[i] = true;
  }

  // Remaining leftovers → open positionals in mapping order.
  for (const field of positionals) {
    if (input[field.field] !== undefined) continue;
    const candidate = leftovers.find((entry) => !consumed[entry.idx] && canTakeRaw(field, entry.raw));
    if (!candidate) continue;
    input[field.field] = candidate.raw;
    consumed[candidate.idx] = true;
  }

  // Join rule: remaining leftovers land in the most specific unfilled
  // non-positional string field (keywords / text / recipients…), never a
  // URN-id field.
  const rest = leftovers.filter((entry) => !consumed[entry.idx]);
  const joinable = rest.filter((entry) => !isDigit(entry.raw));
  if (joinable.length > 0) {
    const joinTargets = infos.filter(
      (f) => !f.positional && isGuessable(f) && !URN_FIELD_HINTS.has(f.field) && input[f.field] === undefined,
    );
    const joined = joinTargets.find((f) => f.required) ?? joinTargets[0];
    if (joined) {
      input[joined.field] = joinable.map((entry) => entry.raw).join(' ');
      for (const entry of joinable) consumed[entry.idx] = true;
    }
  }

  const unclaimed: string[] = [];
  for (const entry of rest) {
    if (!consumed[entry.idx]) unclaimed.push(entry.raw);
  }
  unclaimed.push(...blockedWords);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]!.quoted && !consumed[i]) unclaimed.push(`"${tokens[i]!.raw}"`);
  }
  return { input, unclaimed };
}
