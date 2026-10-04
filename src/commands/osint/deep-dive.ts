/**
 * `linkedin osint deep-dive` — extract full profile intel (about, experience,
 * education, skills) for one person via the existing profileView endpoint,
 * then optionally run Groq deep classification (port of osint_scrape_profiles.py).
 */

import { z } from 'zod';
import type { CommandDefinition } from '../../core/types.js';

const inputSchema = z.object({
  public_id: z.string().describe('Public profile identifier (URL slug)'),
  use_ai: z.boolean().default(false).describe('Groq deep classification (requires GROQ_API_KEY)'),
});

export const osintDeepDiveCommand: CommandDefinition = {
  name: 'osint_deep-dive',
  group: 'osint',
  subcommand: 'deep-dive',
  description:
    'Deep dive one profile: normalize about/experience/education/skills from profileView, optionally with AI deep classification',
  examples: [
    'linkedin osint deep-dive johndoe',
    'linkedin osint deep-dive johndoe --use-ai',
  ],

  inputSchema,

  cliMappings: {
    args: [{ field: 'public_id', name: 'public-id', required: true }],
    options: [{ field: 'use_ai', flags: '--use-ai', description: 'Groq deep classification' }],
  },

  handler: async (input, client) => {
    const inputAny = input as any as { public_id: string; use_ai: boolean };

    const response = await client.get<unknown>(
      `/identity/profiles/${encodeURIComponent(inputAny.public_id)}/profileView`,
    );
    const normalized = normalizeProfileView(response, inputAny.public_id);

    if (inputAny.use_ai) {
      const { isAiAvailable, deepClassify } = await import('../../osint/ai-client.js');
      if (isAiAvailable()) {
        const person = {
          title: normalized.headline,
          original_title: normalized.headline,
          ...normalized,
        } as unknown as Record<string, unknown>;
        const enhanced = await deepClassify(person);
        return { ...normalized, ai: enhanced };
      }
      return { ...normalized, ai_note: 'GROQ_API_KEY not set — raw extraction only' };
    }

    return normalized;
  },
};

/**
 * Normalize a profileView response into the deep-dive schema.
 * Defensive extraction from the normalized-json `included[]` entities.
 */
export function normalizeProfileView(
  response: unknown,
  publicId = '',
): Record<string, unknown> {
  const obj = (response ?? {}) as Record<string, any>;
  const included: Array<Record<string, any>> = Array.isArray(obj.included) ? obj.included : [];

  const typeOf = (e: Record<string, any>) => String(e?.$type ?? '');

  // The primary profile entity: has firstName/lastName and is not a sub-entity
  const profile =
    included.find(
      (e) =>
        typeOf(e).includes('Profile') &&
        !typeOf(e).includes('Position') &&
        !typeOf(e).includes('Education') &&
        (e.firstName !== undefined || e.headline !== undefined),
    ) ??
    obj.data ??
    {};

  const positions = included
    .filter((e) => typeOf(e).includes('Position') && (e.title || e.companyName))
    .map((e) => ({
      title: String(e.title ?? ''),
      company: String(e.companyName ?? ''),
      date_range: [e.dateRange?.start, e.dateRange?.end].some(Boolean)
        ? `${e.dateRange?.start?.year ?? '?'}-${e.dateRange?.end?.year ?? 'Present'}`
        : String(e.dateRange ?? ''),
      location: String(e.locationName ?? ''),
      description: String(e.description ?? ''),
    }));

  const education = included
    .filter((e) => typeOf(e).includes('Education') && (e.schoolName || e.degreeName))
    .map((e) => ({
      degree: String(e.degreeName ?? ''),
      school: String(e.schoolName ?? ''),
      date_range: [e.dateRange?.start, e.dateRange?.end].some(Boolean)
        ? `${e.dateRange?.start?.year ?? '?'}-${e.dateRange?.end?.year ?? '?'}`
        : '',
    }));

  const skills = included
    .filter((e) => typeOf(e).includes('Skill') && e.name)
    .map((e) => String(e.name));

  const name = [profile.firstName, profile.lastName].filter(Boolean).join(' ').trim();

  return {
    public_id: publicId,
    name,
    headline: String(profile.headline ?? ''),
    location: String(profile.locationName ?? profile.geoLocation ?? ''),
    about: String(profile.summary ?? ''),
    experience: positions,
    education,
    skills,
    entity_types_seen: [...new Set(included.map(typeOf).filter(Boolean))].slice(0, 20),
  };
}
