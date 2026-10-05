import { describe, expect, it } from 'vitest';
import { allCommands } from '../src/commands';
import { COMMAND_SYNONYMS } from '../src/interactive/nlp-synonyms.js';
import {
  parse,
  tokenize,
  extractSlots,
  synonymHits,
  nearestEntries,
  coerceValue,
  fieldInfos,
} from '../src/interactive/nlp.js';

const cmd = (name: string) => allCommands.find((c) => c.name === name)!;

describe('nlp tokenizer', () => {
  it('splits words, strips edge punctuation, lowercases bare tokens', () => {
    const tokens = tokenize('Scrape all the sales guys at Acme, limit 50.');
    expect(tokens.map((t) => t.lower)).toEqual([
      'scrape', 'all', 'the', 'sales', 'guys', 'at', 'acme', 'limit', '50',
    ]);
    expect(tokens.every((t) => !t.quoted)).toBe(true);
  });

  it('preserves quoted strings verbatim (case-sensitive values)', () => {
    const tokens = tokenize('who is "Jane Doe"');
    expect(tokens[2]).toEqual({ raw: 'Jane Doe', lower: 'jane doe', quoted: true });
  });

  it('keeps unterminated quotes as bare text', () => {
    const tokens = tokenize('find people "software');
    expect(tokens.map((t) => t.lower)).toEqual(['find', 'people', '"software']);
  });
});

describe('nlp intent scoring', () => {
  it('resolves every one of the 56 commands via its first curated phrase', () => {
    const names = allCommands.map((c) => c.name).sort();
    expect(Object.keys(COMMAND_SYNONYMS).sort()).toEqual(names);
    for (const command of allCommands) {
      const phrase = COMMAND_SYNONYMS[command.name]![0]!;
      const outcome = parse(phrase, allCommands);
      expect(outcome.kind, `${command.name} via "${phrase}"`).toBe('match');
      if (outcome.kind === 'match') {
        expect(outcome.parsed.command.name, `via "${phrase}"`).toBe(command.name);
        expect(outcome.parsed.candidates, `via "${phrase}"`).toBeUndefined();
      }
    }
  });

  it('multi-word synonyms beat token overlap of competitors', () => {
    const outcome = parse('my feed', allCommands);
    expect(outcome.kind).toBe('match');
    if (outcome.kind === 'match') expect(outcome.parsed.command.name).toBe('feed_view');
  });

  it('the spec flagship phrase resolves to osint employees', () => {
    const outcome = parse('scrape all the sales guys at acme, limit 50', allCommands);
    expect(outcome.kind).toBe('match');
    if (outcome.kind !== 'match') return;
    expect(outcome.parsed.command.name).toBe('osint_employees');
    expect(outcome.parsed.input['company']).toBe('acme');
    expect(outcome.parsed.input['keywords']).toBe('sales guys');
    // osint employees declares --max-profiles, not --limit: the bare number
    // stays unclaimed and goes to the guided prompt (§5.4).
    expect(outcome.parsed.input['limit']).toBeUndefined();
    expect(outcome.parsed.unclaimed).toContain('50');
  });

  it('scores ties within one point as ambiguity candidates', () => {
    // bare "text" scores messaging_send-new 2 and posts_create 1 (overlap)
    const outcome = parse('text', allCommands);
    expect(outcome.kind).toBe('ambiguity');
    if (outcome.kind !== 'ambiguity') return;
    const names = outcome.candidates.map((c) => c.name);
    expect(names).toContain('messaging_send-new');
    expect(names).toContain('posts_create');
    expect(outcome.parsed.candidates).toBeDefined();
  });

  it('refuses low-confidence phrases with nearest catalog entries', () => {
    const outcome = parse('flurb the wibble', allCommands);
    expect(outcome.kind).toBe('refusal');
    if (outcome.kind !== 'refusal') return;
    expect(outcome.nearest).toHaveLength(5);
    const also = nearestEntries('flurb the wibble', allCommands, 5);
    expect(also).toHaveLength(5);
  });

  it('refuses bare common words with under threshold scores', () => {
    const outcome = parse('the', allCommands);
    expect(outcome.kind).toBe('refusal');
  });
});

describe('nlp entity extraction', () => {
  it('fills quoted strings into required string fields first', () => {
    const tokens = tokenize('who is "Jane Doe"');
    const { input } = extractSlots(cmd('profile_view'), tokens, synonymHits(cmd('profile_view'), tokens));
    expect(input).toEqual({ public_id: 'Jane Doe' });
  });

  it('fills a second quoted string into the next string field', () => {
    const tokens = tokenize('search jobs "software engineer" "San Francisco"');
    const view = cmd('search_jobs');
    const { input } = extractSlots(view, tokens, synonymHits(view, tokens));
    expect(input['keywords']).toBe('software engineer');
    expect(input['location']).toBe('San Francisco');
  });

  it('joins leftover bare tokens into a required string option', () => {
    const tokens = tokenize('find people software engineer');
    const view = cmd('search_people');
    const { input, unclaimed } = extractSlots(view, tokens, synonymHits(view, tokens));
    expect(input['keywords']).toBe('software engineer');
    expect(unclaimed).toEqual([]);
  });

  it('reports unclaimed tokens it cannot place', () => {
    const outcome = parse('who is johndoe extra', allCommands);
    expect(outcome.kind).toBe('match');
    if (outcome.kind !== 'match') return;
    expect(outcome.parsed.input['public_id']).toBe('johndoe');
    expect(outcome.parsed.unclaimed).toEqual(['extra']);
  });

  it('routes "limit 50" and "25 results" into numeric limit fields', () => {
    const first = parse('search people recruiters limit 50', allCommands);
    expect(first.kind).toBe('match');
    if (first.kind === 'match') {
      expect(first.parsed.command.name).toBe('search_people');
      expect(first.parsed.input['limit']).toBe(50);
    }
    const second = parse('find people engineers 25 results', allCommands);
    expect(second.kind).toBe('match');
    if (second.kind === 'match') expect(second.parsed.input['limit']).toBe(25);
  });

  it('routes "last 10 posts" counts and URN digits correctly', () => {
    const outcome = parse('last 10 posts from 123456789', allCommands);
    expect(outcome.kind).toBe('match');
    if (outcome.kind !== 'match') return;
    expect(outcome.parsed.command.name).toBe('profile_posts');
    expect(outcome.parsed.input['limit']).toBe(10);
    expect(outcome.parsed.input['urn_id']).toBe('123456789');
  });
});

describe('nlp booleans, enums, reactions', () => {
  it('fills adjacency-named numeric fields like depth and geoblast', () => {
    const outcome = parse('scrape employees acme-corp geoblast depth 3', allCommands);
    expect(outcome.kind).toBe('match');
    if (outcome.kind !== 'match') return;
    expect(outcome.parsed.input['company']).toBe('acme-corp');
    expect(outcome.parsed.input['geoblast']).toBe(true);
    expect(outcome.parsed.input['depth']).toBe(3);
  });

  it('maps boolean trigger words onto declared fields', () => {
    const outcome = parse('search jobs "software engineer" in london remote', allCommands);
    expect(outcome.kind).toBe('match');
    if (outcome.kind !== 'match') return;
    expect(outcome.parsed.input['keywords']).toBe('software engineer');
    expect(outcome.parsed.input['location']).toBe('london');
    expect(outcome.parsed.input['remote']).toBe(true);
  });

  it('never guesses URN-typed geo fields offline', () => {
    const outcome = parse('discover companies in usa with ai', allCommands);
    expect(outcome.kind).toBe('match');
    if (outcome.kind !== 'match') return;
    expect(outcome.parsed.command.name).toBe('osint_discover');
    expect(outcome.parsed.input['use_ai']).toBe(true);
    expect(outcome.parsed.input['geo']).toBeUndefined();
    expect(outcome.parsed.unclaimed).toContain('usa');
  });

  it('maps reaction words onto the engage_react type enum', () => {
    const like = parse('like 7123456789', allCommands);
    expect(like.kind).toBe('match');
    if (like.kind === 'match') {
      expect(like.parsed.command.name).toBe('engage_react');
      expect(like.parsed.input['type']).toBe('LIKE');
      expect(like.parsed.input['post_urn']).toBe('7123456789');
    }
    const celebrate = parse('celebrate 7123456789', allCommands);
    expect(celebrate.kind).toBe('match');
    if (celebrate.kind === 'match') expect(celebrate.parsed.input['type']).toBe('PRAISE');
  });

  it('maps "newest" onto the comments-list sort enum', () => {
    const outcome = parse('list comments 7123456789 newest', allCommands);
    expect(outcome.kind).toBe('match');
    if (outcome.kind !== 'match') return;
    expect(outcome.parsed.input['sort']).toBe('REVERSE_CHRONOLOGICAL');
    expect(outcome.parsed.input['post_urn']).toBe('7123456789');
  });

  it('maps "connections only" onto posts_create visibility', () => {
    const outcome = parse('new post "hello world" connections only', allCommands);
    expect(outcome.kind).toBe('match');
    if (outcome.kind !== 'match') return;
    expect(outcome.parsed.command.name).toBe('posts_create');
    expect(outcome.parsed.input['visibility']).toBe('connections');
    expect(outcome.parsed.input['text']).toBe('hello world');
  });

  it('session memory resolves an ambiguous phrase without re-asking', () => {
    const memory = new Map([['text', 'messaging_send-new']]);
    const outcome = parse('text', allCommands, memory);
    expect(outcome.kind).toBe('match');
    if (outcome.kind !== 'match') return;
    expect(outcome.parsed.command.name).toBe('messaging_send-new');
    expect(outcome.parsed.matched.via).toBe('session-memory');
  });
});

describe('nlp determinism and field info', () => {
  it('parse is pure: same input twice → deep-equal outcome', () => {
    const text = 'scrape all the sales guys at acme, limit 50';
    const a = JSON.stringify(parse(text, allCommands));
    const b = JSON.stringify(parse(text, allCommands));
    expect(a).toBe(b);
  });

  it('extractSlots alone is deterministic too', () => {
    const tokens = tokenize('find people software engineer');
    const view = cmd('search_people');
    const hits = synonymHits(view, tokens);
    const a = extractSlots(view, tokens, hits);
    const b = extractSlots(view, tokens, hits);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('fieldInfos reads kinds straight off the Zod schemas', () => {
    const employees = fieldInfos(cmd('osint_employees'));
    const company = employees.find((f) => f.field === 'company')!;
    expect(company.kind).toBe('string');
    expect(company.positional).toBe(true);
    expect(company.required).toBe(true);
    const geoblast = employees.find((f) => f.field === 'geoblast')!;
    expect(geoblast.kind).toBe('boolean');
    expect(geoblast.boolFlag).toBe('--geoblast');
    const format = employees.find((f) => f.field === 'format')!;
    expect(format.kind).toBe('enum');
    expect(format.values).toEqual(['json', 'csv']);
  });

  it('coerceValue converts to the field type', () => {
    expect(coerceValue(cmd('search_jobs'), 'remote', 'true')).toBe(true);
    expect(coerceValue(cmd('profile_skills'), 'limit', '50')).toBe(50);
    expect(coerceValue(cmd('search_jobs'), 'experience', '4')).toBe('4');
  });
});
