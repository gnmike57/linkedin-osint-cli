import { afterEach, describe, expect, it } from 'vitest';
import {
  parseAiJsonObject,
  parseAiJsonArray,
  buildSystemPrompt,
  buildTaxonomyExtra,
  isAiAvailable,
  scoreCompanies,
  enhanceClassification,
  HIERARCHY_LEVELS_LIST,
  DIVISIONS_LIST,
  GROQ_MODEL,
} from '../src/osint/ai-client.js';
import { SYSTEM_PROMPT, SKILL_CLASSIFY_PROMPT, SKILL_SCORE_PROMPT } from '../src/osint/prompts.js';

describe('parseAiJsonObject', () => {
  it('parses plain JSON', () => {
    expect(parseAiJsonObject('{"a": 1}')).toEqual({ a: 1 });
  });

  it('strips markdown code fences', () => {
    const fenced = '```json\n{"role_level": "Director"}\n```';
    expect(parseAiJsonObject(fenced)).toEqual({ role_level: 'Director' });
  });

  it('extracts JSON embedded in prose', () => {
    const noisy = 'Here is the result:\n{"division": "Cyber Security", "confidence": 0.9}\nDone.';
    expect(parseAiJsonObject(noisy)).toEqual({ division: 'Cyber Security', confidence: 0.9 });
  });

  it('returns empty object on garbage', () => {
    expect(parseAiJsonObject('')).toEqual({});
    expect(parseAiJsonObject('no json here')).toEqual({});
  });
});

describe('parseAiJsonArray', () => {
  it('parses arrays with fences', () => {
    const fenced = '```\n[{"index": 1, "score": 85}]\n```';
    expect(parseAiJsonArray(fenced)).toEqual([{ index: 1, score: 85 }]);
  });

  it('extracts arrays embedded in prose', () => {
    const noisy = 'Results:\n[{"index": 2, "score": 35}] end';
    expect(parseAiJsonArray(noisy)).toEqual([{ index: 2, score: 35 }]);
  });

  it('returns empty array on non-array JSON', () => {
    expect(parseAiJsonArray('{"a": 1}')).toEqual([]);
    expect(parseAiJsonArray('')).toEqual([]);
  });
});

describe('prompts and taxonomy', () => {
  it('composes system prompts with the --- separator', () => {
    const composed = buildSystemPrompt(SKILL_SCORE_PROMPT, 'extra');
    expect(composed).toContain(SYSTEM_PROMPT);
    expect(composed).toContain(SKILL_SCORE_PROMPT);
    expect(composed).toContain('---\n\nextra');
  });

  it('derives taxonomy lists from the rules JSON', () => {
    expect(HIERARCHY_LEVELS_LIST[0]).toBe('Executive');
    expect(HIERARCHY_LEVELS_LIST).toHaveLength(12);
    expect(DIVISIONS_LIST).toContain('Cyber Security');
    expect(DIVISIONS_LIST).toHaveLength(20);
  });

  it('ships the three runtime prompts with real content', () => {
    expect(SYSTEM_PROMPT).toContain('OSINT Analyst');
    expect(SKILL_CLASSIFY_PROMPT).toContain('organizational classification');
    expect(SKILL_SCORE_PROMPT).toContain('company relevance evaluation');
    expect(GROQ_MODEL).toBe('llama-3.3-70b-versatile');
  });
});

describe('graceful degradation without GROQ_API_KEY', () => {
  const originalKey = process.env.GROQ_API_KEY;

  afterEach(() => {
    if (originalKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = originalKey;
  });

  it('reports unavailable when the key is missing', () => {
    delete process.env.GROQ_API_KEY;
    expect(isAiAvailable()).toBe(false);
  });

  it('returns companies unchanged when AI is unavailable', async () => {
    delete process.env.GROQ_API_KEY;
    const companies = [{ name: 'CyberArk' }, { name: 'Wix' }];
    const result = await scoreCompanies(companies, 'cybersecurity');
    expect(result).toEqual(companies);
    expect(result[0].ai_relevance_score).toBeUndefined();
  });

  it('returns people unchanged when AI is unavailable', async () => {
    delete process.env.GROQ_API_KEY;
    const person = { title: 'Security Architect', role_level: 'Staff' };
    const result = await enhanceClassification(person);
    expect(result).toBe(person);
    expect(result.ai_role_level).toBeUndefined();
  });
});
