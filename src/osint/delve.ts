/**
 * Email → LinkedIn profile deanonymization via Microsoft Outlook/Delve.
 * Ported from linkedin-osint-master/outlook_http_client.py.
 *
 * Requires a Microsoft session Bearer token (extracted from an authenticated
 * Outlook session — see the GoSecure write-up referenced in the legacy README).
 * Provide it via LINKEDIN_MS_TOKEN env var or --token-file.
 * Never log the token.
 */

import { randomUUID } from 'node:crypto';
import { httpRequest } from '../core/transport.js';

export const DELVE_PROFILE_URL =
  'https://sfnam.loki.delve.office.com/api/v1/linkedin/profiles/full';

export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 10;

/**
 * Normalize raw email-list lines ("Alice,a@x.com" CSV pairs, whitespace) into
 * bare email addresses. Keeps the legacy toolkit's "name,email" intake.
 */
export function normalizeEmails(lines: string[]): string[] {
  const emails: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // "name,email" → keep only the email column
    const email = trimmed.includes(',') ? (trimmed.split(',').pop()?.trim() ?? '') : trimmed;
    if (email) emails.push(email);
  }
  return emails;
}

/** Build the Delve LivePersonaCard lookup URL for one email. */
export function buildDelveUrl(email: string): string {
  const params = new URLSearchParams({
    AadObjectId: '',
    Smtp: email,
    OlsPersonaId: '',
    UserPrincipalName: '',
    RootCorrelationId: randomUUID(),
    CorrelationId: randomUUID(),
    ClientCorrelationId: randomUUID(),
    PersonaDisplayName: '',
    UserLocale: 'en-US',
    ExternalPageInstance: '00000000-0000-0000-0000-000000000000',
    PersonaType: 'User',
  });
  return `${DELVE_PROFILE_URL}?${params.toString()}`;
}

/** Request headers for the Delve lookup. The token is never logged. */
export function delveHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'x-clientfeature': 'LivePersonaCard',
    accept: 'text/plain, application/json, text/json',
    'x-clienttype': 'OwaMail',
    'x-hostappcapabilities': '{}',
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:57.0) Gecko/20100101 Firefox/57.0',
    'x-lpcversion': '1.20210418.1.0',
  };
}

export interface DelveSummary {
  displayName: string;
  headline: string;
  companyName: string;
  location: string;
}

export interface DelvePerson {
  found: boolean;
  person?: Record<string, unknown>;
  summary?: DelveSummary;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Parse a Delve response body. `found` is true when a person card exists. */
export function parseDelveResponse(text: string): DelvePerson {
  if (!text || !text.includes('displayName')) return { found: false };
  try {
    const data = JSON.parse(text) as { persons?: Array<Record<string, unknown>> };
    const persons = data.persons ?? [];
    if (persons.length === 0) return { found: false };
    const p = persons[0];
    return {
      found: true,
      person: p,
      summary: {
        displayName: str(p.displayName),
        headline: str(p.headline),
        companyName: str(p.companyName),
        location: str(p.location),
      },
    };
  } catch {
    return { found: false };
  }
}

export interface DelveLookupResult {
  email: string;
  found: boolean;
  person?: Record<string, unknown>;
  summary?: DelveSummary;
  error?: string;
}

/** Look up a single email. Never retries auth — like the original tool. */
export async function lookupDelveEmail(
  email: string,
  token: string,
  timeoutMs = 30_000,
): Promise<DelveLookupResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await httpRequest(buildDelveUrl(email), {
      method: 'GET',
      headers: delveHeaders(token),
      signal: controller.signal,
    });
    if (res.status !== 200) {
      return { email, found: false, error: `HTTP ${res.status}` };
    }
    const text = await res.text();
    const parsed = parseDelveResponse(text);
    return { email, ...parsed };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { email, found: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

export interface DelveBatchOptions {
  /** Abort after N consecutive misses (token expiry heuristic). Default 10. */
  maxConsecutiveFailures?: number;
  /** Extra delay between lookups in ms (the original had none). */
  delayMs?: number;
  /** Resume from this email (inclusive). */
  skipEmail?: string;
  /** Progress callback for streaming output. */
  onResult?: (result: DelveLookupResult, index: number, total: number) => void;
}

export interface DelveBatchResult {
  results: DelveLookupResult[];
  /** True when the failure circuit breaker aborted the batch early. */
  aborted: boolean;
  consecutiveFailures: number;
}

/**
 * Look up a list of emails with the original tool's batch semantics:
 * consecutive misses count as failures (token-expiry heuristic), a hit resets
 * the counter, and `maxConsecutiveFailures` (default 10) aborts the batch.
 */
export async function lookupDelveEmails(
  emails: string[],
  token: string,
  options: DelveBatchOptions = {},
): Promise<DelveBatchResult> {
  const maxFailures = options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
  const results: DelveLookupResult[] = [];
  let consecutiveFailures = 0;
  let skipFound = !options.skipEmail;

  for (const raw of emails) {
    // Support "name,email" CSV-style lines like the original parser
    let email = raw.trim();
    if (email.includes(',')) email = email.split(',')[1].trim();
    if (!email) continue;

    if (!skipFound) {
      if (email === options.skipEmail) {
        skipFound = true;
      } else {
        continue;
      }
    }

    const result = await lookupDelveEmail(email, token);
    const index = results.length;
    results.push(result);
    options.onResult?.(result, index, emails.length);

    if (result.found) {
      consecutiveFailures = 0;
    } else if (
      result.error &&
      (result.error.includes('socket hang up') || result.error.includes('ECONNRESET'))
    ) {
      // Connectivity blips aren't evidence of an expired token — the circuit
      // breaker exists to catch token expiry, so these don't count.
    } else {
      consecutiveFailures++;
      if (consecutiveFailures >= maxFailures) {
        return { results, aborted: true, consecutiveFailures };
      }
    }

    if (options.delayMs && options.delayMs > 0) {
      await new Promise((r) => setTimeout(r, options.delayMs));
    }
  }

  return { results, aborted: false, consecutiveFailures };
}

