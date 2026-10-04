import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildDelveUrl,
  delveHeaders,
  parseDelveResponse,
  lookupDelveEmails,
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
} from '../src/osint/delve.js';

describe('buildDelveUrl', () => {
  it('targets the Delve LivePersonaCard endpoint with the email', () => {
    const url = buildDelveUrl('person@example.com');
    expect(url.startsWith('https://sfnam.loki.delve.office.com/api/v1/linkedin/profiles/full?')).toBe(true);
    expect(url).toContain('Smtp=person%40example.com');
    expect(url).toContain('PersonaType=User');
    expect(url).toContain('UserLocale=en-US');
    expect(url).toContain('ExternalPageInstance=00000000-0000-0000-0000-000000000000');
  });
});

describe('delveHeaders', () => {
  it('never exposes the token in logs, only in the auth header', () => {
    const headers = delveHeaders('secret-token-123');
    expect(headers['authorization']).toBe('Bearer secret-token-123');
    expect(headers['x-clientfeature']).toBe('LivePersonaCard');
    expect(headers['x-clienttype']).toBe('OwaMail');
    expect(JSON.stringify(headers)).not.toMatch(/secret-token-123(?=.*authorization)/);
  });
});

describe('parseDelveResponse', () => {
  it('extracts the person and summary when found', () => {
    const body = JSON.stringify({
      persons: [
        {
          displayName: 'Paul Attorney',
          headline: 'Attorney and Counsel',
          companyName: 'Law Firm LLP',
          location: 'Waltham, Massachusetts, United States',
          linkedInUrl: 'https://linkedin.com/in/paul',
          positions: [],
        },
      ],
    });
    const parsed = parseDelveResponse(body);
    expect(parsed.found).toBe(true);
    expect(parsed.summary?.displayName).toBe('Paul Attorney');
    expect(parsed.summary?.headline).toBe('Attorney and Counsel');
    expect(parsed.summary?.companyName).toBe('Law Firm LLP');
    expect(parsed.summary?.location).toBe('Waltham, Massachusetts, United States');
    expect(parsed.person?.linkedInUrl).toBe('https://linkedin.com/in/paul');
  });

  it('returns not-found for empty results', () => {
    expect(parseDelveResponse('{"persons": []}').found).toBe(false);
    expect(parseDelveResponse('').found).toBe(false);
    expect(parseDelveResponse('<html>error</html>').found).toBe(false);
    expect(parseDelveResponse('not json {').found).toBe(false);
  });
});

describe('lookupDelveEmails (mocked HTTP)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(foundFor: string[]): typeof fetch {
    return (async (input: string | URL | Request) => {
      const url = String(input);
      const email = decodeURIComponent(url.match(/Smtp=([^&]+)/)?.[1] ?? '');
      const body = foundFor.includes(email)
        ? JSON.stringify({
            persons: [{ displayName: 'Found Person', headline: '', companyName: '', location: '' }],
          })
        : JSON.stringify({ persons: [] });
      return {
        status: 200,
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => body,
      } as Response;
    }) as typeof fetch;
  }

  it('respects the default failure circuit breaker (10)', () => {
    expect(DEFAULT_MAX_CONSECUTIVE_FAILURES).toBe(10);
  });

  it('aborts after N consecutive misses and resets on hits', async () => {
    globalThis.fetch = mockFetch(['hit@example.com']);
    const res = await lookupDelveEmails(
      ['a@x.com', 'b@x.com', 'c@x.com', 'hit@example.com', 'd@x.com'],
      'token',
      { maxConsecutiveFailures: 3 },
    );
    expect(res.aborted).toBe(true);
    expect(res.consecutiveFailures).toBe(3);
    expect(res.results).toHaveLength(3); // a, b, c — never reached the hit
  });

  it('completes the batch when hits reset the counter', async () => {
    globalThis.fetch = mockFetch(['a@x.com', 'c@x.com']);
    const res = await lookupDelveEmails(
      ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com'],
      'token',
      { maxConsecutiveFailures: 2 },
    );
    expect(res.aborted).toBe(false);
    expect(res.results).toHaveLength(4);
    expect(res.results.filter((r) => r.found)).toHaveLength(2);
  });

  it('supports skip-email resume and CSV-style lines', async () => {
    globalThis.fetch = mockFetch(['c@x.com']);
    const res = await lookupDelveEmails(
      ['Alice,a@x.com', 'Bob,b@x.com', 'Carol,c@x.com'],
      'token',
      { skipEmail: 'b@x.com' },
    );
    expect(res.results.map((r) => r.email)).toEqual(['b@x.com', 'c@x.com']);
  });
});
