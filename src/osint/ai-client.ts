/**
 * AI Enhancer — optional Groq LLM integration (TypeScript port of
 * osint_classify_ai.py). Uses Groq chat completions with Llama models.
 *
 * This module is NEVER required — all functions gracefully return input
 * unchanged if GROQ_API_KEY is missing or calls fail. Prompts come from
 * prompts.ts (inlined from the toolkit's prompt markdown files); taxonomy
 * lists are derived from classification_rules.json (single source of truth).
 */

import { getHierarchyOrder, getDivisionNames } from './classify.js';
import { SYSTEM_PROMPT, SKILL_CLASSIFY_PROMPT, SKILL_SCORE_PROMPT } from './prompts.js';

export const GROQ_MODEL = 'llama-3.3-70b-versatile';
const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const RATE_DELAY_MS = 500; // free tier safe

/** Classification constants derived from the rules JSON (kept in sync). */
export const HIERARCHY_LEVELS_LIST = getHierarchyOrder();
export const DIVISIONS_LIST = getDivisionNames();

export function getGroqApiKey(): string {
  return (process.env.GROQ_API_KEY ?? '').trim();
}

/** AI enhancement is available when an API key is configured. */
export function isAiAvailable(): boolean {
  return getGroqApiKey().length > 0;
}

let lastCallAt = 0;

/** Send a chat completion request to Groq. Returns response text or ''. */
export async function aiChat(
  systemPrompt: string,
  userPrompt: string,
  temperature = 0.1,
): Promise<string> {
  const apiKey = getGroqApiKey();
  if (!apiKey) return '';

  const gap = Date.now() - lastCallAt;
  if (gap < RATE_DELAY_MS) {
    await new Promise((r) => setTimeout(r, RATE_DELAY_MS - gap));
  }
  lastCallAt = Date.now();

  try {
    const res = await fetch(GROQ_CHAT_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature,
        max_tokens: 1024,
      }),
    });
    if (!res.ok) {
      console.error(`[AI] Groq API call failed: HTTP ${res.status}`);
      return '';
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data?.choices?.[0]?.message?.content?.trim() ?? '';
  } catch (err) {
    console.error(`[AI] Groq API call failed: ${err instanceof Error ? err.message : err}`);
    return '';
  }
}

/** Extract a JSON object from an LLM response (handles markdown fences). */
export function parseAiJsonObject(text: string): Record<string, unknown> {
  if (!text) return {};
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned
      .split('\n')
      .filter((l) => !l.trim().startsWith('```'))
      .join('\n');
  }
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}') + 1;
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end)) as Record<string, unknown>;
      } catch {
        /* fall through */
      }
    }
  }
  return {};
}

/** Extract a JSON array from an LLM response (handles markdown fences). */
export function parseAiJsonArray(text: string): Array<Record<string, unknown>> {
  if (!text) return [];
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned
      .split('\n')
      .filter((l) => !l.trim().startsWith('```'))
      .join('\n');
  }
  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']') + 1;
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(cleaned.slice(start, end));
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        /* fall through */
      }
    }
  }
  return [];
}

/** Composite system prompt: base persona + skill file, joined like the original. */
export function buildSystemPrompt(skillPrompt: string, extra = ''): string {
  const parts = [SYSTEM_PROMPT, skillPrompt, extra].filter((p) => p.length > 0);
  return parts.join('\n\n---\n\n');
}

/** Taxonomy context appended to classification prompts. */
export function buildTaxonomyExtra(): string {
  return (
    `Hierarchy levels: ${HIERARCHY_LEVELS_LIST.join(', ')}\n` +
    `Departments: ${DIVISIONS_LIST.join(', ')}`
  );
}

export interface AiCompany {
  name?: string;
  industry?: string;
  location?: string;
  summary?: string;
  ai_relevance_score?: number;
  ai_reasoning?: string;
  [key: string]: unknown;
}

/**
 * MACRO LEVEL: score discovered companies for relevance to an objective.
 * Adds `ai_relevance_score` (0-100) and `ai_reasoning`, returns companies
 * sorted by score descending. Batches of 15 like the original.
 */
export async function scoreCompanies(
  companies: AiCompany[],
  searchObjective: string,
): Promise<AiCompany[]> {
  if (companies.length === 0 || !searchObjective || !isAiAvailable()) return companies;

  console.error(`[AI] Scoring ${companies.length} companies for relevance...`);
  const systemPrompt = buildSystemPrompt(SKILL_SCORE_PROMPT);
  const batch = [...companies];
  const size = 15;

  for (let i = 0; i < batch.length; i += size) {
    const chunk = batch.slice(i, i + size);
    const companiesText = chunk
      .map(
        (c, j) =>
          `- ${i + j + 1}. "${c.name ?? 'Unknown'}" | Industry: ${c.industry ?? 'Unknown'} | ` +
          `Location: ${c.location ?? 'Unknown'} | Summary: ${String(c.summary ?? 'N/A').slice(0, 150)}`,
      )
      .join('\n');

    const userPrompt =
      `Search objective: "${searchObjective}"\n\n` +
      `Companies to evaluate:\n${companiesText}\n\n` +
      `Return JSON array: [{"index": 1, "score": 0-100, "reasoning": "one sentence"}]`;

    const response = await aiChat(systemPrompt, userPrompt);
    const results = parseAiJsonArray(response);
    if (!response.trim() || results.length === 0) {
      console.error(
        `[AI] Batch starting at #${i + 1} produced no usable scores (empty or unparseable response)`,
      );
    }

    for (const r of results) {
      const idx = Number(r.index) - 1;
      const target = batch[idx];
      if (!target) continue;
      if (r.score !== undefined) target.ai_relevance_score = Number(r.score);
      if (r.reasoning !== undefined) target.ai_reasoning = String(r.reasoning);
    }
  }

  const scored = batch.filter((c) => c.ai_relevance_score !== undefined).length;
  if (scored < batch.length) {
    console.error(`[AI] Scored ${scored}/${batch.length} companies (rest left unscored)`);
  }

  return batch.sort(
    (a, b) => (b.ai_relevance_score ?? -1) - (a.ai_relevance_score ?? -1),
  );
}

function applyTitleResult(person: Record<string, unknown>, result: Record<string, unknown>, promoteAt: number): void {
  const aiLevel = typeof result.role_level === 'string' ? result.role_level : '';
  const aiDivision = typeof result.division === 'string' ? result.division : '';
  const aiConf = Number(result.confidence ?? 0) || 0;
  const aiReason = typeof result.reasoning === 'string' ? result.reasoning : '';

  if (aiLevel && HIERARCHY_LEVELS_LIST.includes(aiLevel)) person['ai_role_level'] = aiLevel;
  if (aiDivision && DIVISIONS_LIST.includes(aiDivision)) person['ai_division'] = aiDivision;
  person['ai_confidence'] = Math.round(aiConf * 100) / 100;
  if (aiReason) person['ai_reasoning'] = aiReason;

  // Promote if confident and keyword classification was weak
  const kwLevel = String(person['role_level'] ?? person['original_role_level'] ?? 'Staff');
  const kwDiv = String(person['division_name'] ?? person['original_division'] ?? 'General');
  if (aiConf >= promoteAt) {
    if ((kwLevel === 'Staff' || kwLevel === 'Mid-Level') && HIERARCHY_LEVELS_LIST.includes(aiLevel)) {
      person['role_level'] = aiLevel;
      person['ai_promoted_level'] = true;
    }
    if (kwDiv === 'General' && DIVISIONS_LIST.includes(aiDivision)) {
      person['division_name'] = aiDivision;
      person['ai_promoted_division'] = true;
    }
  }
}

/** MEDIUM LEVEL (single): classify a person by title only. */
export async function enhanceClassification(
  person: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!isAiAvailable()) return person;

  const title = String(person['title'] ?? person['original_title'] ?? '');
  if (!title) return person;

  const systemPrompt = buildSystemPrompt(SKILL_CLASSIFY_PROMPT, buildTaxonomyExtra());
  const userPrompt =
    `Title: "${title}"\n\n` +
    `Return JSON: {"role_level": "...", "division": "...", "confidence": 0.0-1.0, "reasoning": "one sentence"}`;

  const response = await aiChat(systemPrompt, userPrompt);
  const result = parseAiJsonObject(response);
  if (Object.keys(result).length > 0) {
    applyTitleResult(person, result, 0.8);
  }
  return person;
}

/** MEDIUM LEVEL (batch): classify many people by title, numbered list in/out. */
export async function enhanceClassificationsBatch(
  people: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  if (people.length === 0 || !isAiAvailable()) return people;

  console.error(`[AI] Enhancing classification for ${people.length} titles...`);
  const systemPrompt = buildSystemPrompt(SKILL_CLASSIFY_PROMPT, buildTaxonomyExtra());
  let totalEnhanced = 0;
  const size = 20;

  for (let i = 0; i < people.length; i += size) {
    const chunk = people.slice(i, i + size);
    const titlesText = chunk
      .map((p, j) => `${i + j + 1}. "${String(p['title'] ?? p['original_title'] ?? '')}"`)
      .join('\n');

    const userPrompt =
      `Classify each title into one hierarchy level and one department.\n\n` +
      `${titlesText}\n\n` +
      `Return JSON array: [{"index": 1, "role_level": "...", "division": "...", "confidence": 0.0-1.0}]`;

    const response = await aiChat(systemPrompt, userPrompt);
    const results = parseAiJsonArray(response);

    for (const r of results) {
      const idx = Number(r.index) - 1;
      const target = people[idx];
      if (!target) continue;
      applyTitleResult(target, r, 0.8);
      totalEnhanced++;
    }

    console.error(
      `[AI] Batch ${Math.floor(i / size) + 1}: enhanced ${results.length}/${chunk.length} titles`,
    );
  }

  console.error(`[AI] Total enhanced: ${totalEnhanced}/${people.length}`);
  return people;
}

/** IN-DEPTH LEVEL: classify a person using their full profile context. */
export async function deepClassify(
  person: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!isAiAvailable()) return person;

  const title = String(person['title'] ?? person['original_title'] ?? '');
  const about = String(person['about'] ?? '');
  const experience = Array.isArray(person['experience'])
    ? (person['experience'] as Array<Record<string, unknown>>)
    : [];
  const education = Array.isArray(person['education'])
    ? (person['education'] as Array<Record<string, unknown>>)
    : [];
  const skills = Array.isArray(person['skills']) ? (person['skills'] as unknown[]) : [];

  // Build context from available data
  const contextParts: string[] = [];
  if (title) contextParts.push(`Current title: ${title}`);
  if (about) contextParts.push(`About: ${about.slice(0, 500)}`);
  if (experience.length > 0) {
    const expText = experience
      .slice(0, 5)
      .map(
        (e) =>
          `${e.title ?? ''} at ${e.company ?? ''} (${e.date_range ?? e.dates ?? ''})`,
      )
      .join('; ');
    contextParts.push(`Experience: ${expText}`);
  }
  if (education.length > 0) {
    const eduText = education
      .slice(0, 3)
      .map(
        (e) =>
          `${e.degree ?? ''} at ${e.school ?? ''} (${e.date_range ?? e.dates ?? ''})`,
      )
      .join('; ');
    contextParts.push(`Education: ${eduText}`);
  }
  if (skills.length > 0) {
    contextParts.push(`Skills: ${skills.slice(0, 15).map(String).join(', ')}`);
  }

  if (contextParts.length === 0) return person;

  const systemPrompt = buildSystemPrompt(SKILL_CLASSIFY_PROMPT, buildTaxonomyExtra());
  const userPrompt =
    `Full profile:\n${contextParts.join('\n')}\n\n` +
    `Return JSON: {"role_level": "...", "division": "...", ` +
    `"confidence": 0.0-1.0, "reasoning": "2-3 sentences explaining ` +
    `why based on the full profile context"}`;

  const response = await aiChat(systemPrompt, userPrompt);
  const result = parseAiJsonObject(response);
  if (Object.keys(result).length === 0) return person;

  const aiLevel = typeof result.role_level === 'string' ? result.role_level : '';
  const aiDivision = typeof result.division === 'string' ? result.division : '';
  const aiConf = Number(result.confidence ?? 0) || 0;

  if (aiLevel && HIERARCHY_LEVELS_LIST.includes(aiLevel)) person['ai_role_level'] = aiLevel;
  if (aiDivision && DIVISIONS_LIST.includes(aiDivision)) person['ai_division'] = aiDivision;
  person['ai_confidence'] = Math.round(aiConf * 100) / 100;
  if (typeof result.reasoning === 'string') person['ai_reasoning'] = result.reasoning;
  person['ai_deep_classified'] = true;

  // Deep classification with full context: promote if confidence >= 0.7
  // (lower threshold than title-only because we have much more context)
  const kwLevel = String(person['role_level'] ?? person['original_role_level'] ?? 'Staff');
  const kwDiv = String(person['division_name'] ?? person['original_division'] ?? 'General');
  if (aiConf >= 0.7) {
    if ((kwLevel === 'Staff' || kwLevel === 'Mid-Level') && HIERARCHY_LEVELS_LIST.includes(aiLevel)) {
      person['role_level'] = aiLevel;
      person['ai_promoted_level'] = true;
    }
    if (kwDiv === 'General' && DIVISIONS_LIST.includes(aiDivision)) {
      person['division_name'] = aiDivision;
      person['ai_promoted_division'] = true;
    }
  }

  return person;
}


