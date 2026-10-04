import { describe, expect, it, vi } from 'vitest';
import { buildMatrixHtml } from '../src/osint/matrix.js';
import { classifyIndustry } from '../src/osint/industries.js';
import { classifyDivision, cleanTitle } from '../src/osint/classify.js';
import { output } from '../src/core/output.js';
import { normalizeEmails } from '../src/osint/delve.js';
import { createClient } from '../src/core/client.js';
import { LinkedInError } from '../src/core/errors.js';
import type { LinkedInAuth } from '../src/core/types.js';

function captureOutput(data: unknown, options: { fields?: string }): any {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  let recorded: unknown[][];
  try {
    output(data, { pretty: false, fields: options.fields });
    recorded = [...log.mock.calls]; // mockRestore() clears the calls array
  } finally {
    log.mockRestore();
  }
  if (!recorded || recorded.length === 0) throw new Error('output printed nothing');
  return JSON.parse(String(recorded[0]?.[0]));
}

const TEST_AUTH: LinkedInAuth = {
  liAt: 'unit-li_at',
  jsessionid: 'ajax:unit-jsessionid',
  cookieHeader: 'li_at=unit-li_at; JSESSIONID="ajax:unit-jsessionid"',
};

describe('matrix HTML injection hardening', () => {
  it('neutralizes javascript: profile URLs', () => {
    const html = buildMatrixHtml({
      people: [{ name: 'Evil Person', title: 'CEO', profile_url: 'javascript:alert(1)' }],
    });
    expect(html).not.toContain('javascript:');
    expect(html).toContain('EP'); // falls back to initials avatar
  });

  it('neutralizes non-http image URLs (data: exfiltration)', () => {
    const html = buildMatrixHtml({
      people: [
        { name: 'Data Leak', title: 'CTO', profile_image_url: 'data:text/html;base64,AAAA' },
      ],
    });
    expect(html).not.toContain('data:text/html');
  });

  it('keeps valid https profile links and CDATA-safe initials', () => {
    const html = buildMatrixHtml({
      people: [{ name: 'Safe Person', title: 'Analyst', profile_url: 'http://linkedin.com/in/safe' }],
    });
    expect(html).toContain('http://linkedin.com/in/safe');
  });
});

describe('classifyIndustry ordering', () => {
  it('matches Biotechnology to Healthcare (not the substring "tech")', () => {
    expect(classifyIndustry('Biotechnology')).toBe('Healthcare');
  });

  it('matches national security to Intelligence (not the substring "security")', () => {
    expect(classifyIndustry('Director of National Security')).toBe('Intelligence');
  });
});

describe('classify title suffix stripping', () => {
  it('does not eat real title suffixes like " - Customer Success"', () => {
    // The tail is kept, so its division keywords decide — 'customer success'
    // scores into Sales, not into whatever 'manager' alone would produce.
    expect(cleanTitle('Manager - Customer Success')).toBe('Manager - Customer Success');
    expect(classifyDivision('Manager - Customer Success')).toBe('Sales');
  });

  it('still strips ALL-CAPS company tails', () => {
    expect(cleanTitle('Senior Engineer - STRIPE')).toBe('Senior Engineer');
  });
});

describe('output --fields', () => {
  it('maps fields inside elements and preserves pagination metadata', () => {
    const result = captureOutput({ elements: [{ a: 1, b: 2 }], meta: { total: 7 } }, { fields: 'a' });
    expect(result.elements).toEqual([{ a: 1 }]);
    expect(result.meta).toEqual({ total: 7 });
  });

  it('maps fields inside items and preserves the rest', () => {
    const result = captureOutput({ items: [{ x: 1, y: 2 }], paging: { start: 0 } }, { fields: 'x' });
    expect(result.items).toEqual([{ x: 1 }]);
    expect(result.paging).toEqual({ start: 0 });
  });
});

describe('delve normalizeEmails', () => {
  it('splits CSV-style lines and trims whitespace', () => {
    expect(normalizeEmails(['Alice,a@x.com', '  b@x.com  ', 'c@x.com'])).toEqual([
      'a@x.com',
      'b@x.com',
      'c@x.com',
    ]);
  });
});

describe('client retry semantics', () => {
  const originalFetch = globalThis.fetch;

  it('does not retry non-GET requests on network errors (duplicate-write protection)', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new TypeError('fetch failed: socket hang up');
    }) as typeof fetch;
    try {
      const client = createClient(TEST_AUTH);
      await expect(client.post('/voyagerFeedDashShares', { text: 'x' })).rejects.toThrow(
        LinkedInError,
      );
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('retries GET requests on transient network errors', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls < 3) throw new TypeError('fetch failed: terminated');
      return {
        status: 200,
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => '{"ok":true}',
      } as Response;
    }) as typeof fetch;
    try {
      const client = createClient(TEST_AUTH);
      const res = await client.get<{ ok: boolean }>('/voyagerFeedDashFeed');
      expect(res.ok).toBe(true);
      expect(calls).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
