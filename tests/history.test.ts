import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendHistory,
  historyFilePath,
  loadHistory,
  redactSecrets,
} from '../src/interactive/history.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linkedin-cli-history-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('redactSecrets', () => {
  it('masks a cookie flag value (quoted or bare)', () => {
    expect(redactSecrets('login --li-at AQEDsecret --jsessionid "ajax:1"')).toBe(
      'login --li-at *** --jsessionid ***',
    );
  });

  it('masks the --flag=value form', () => {
    expect(redactSecrets('login --li-at=AQEDsecret')).toBe('login --li-at=***');
  });

  it('masks a token for the email lookup', () => {
    expect(redactSecrets('osint email-lookup --token abc.def')).toBe('osint email-lookup --token ***');
  });

  it('leaves non-secret commands untouched', () => {
    expect(redactSecrets('osint employees acme --depth 3')).toBe('osint employees acme --depth 3');
  });
});

describe('appendHistory', () => {
  it('never writes a credential to disk', () => {
    appendHistory('login --li-at AQEDnobody --jsessionid ajax:1', dir);

    const raw = readFileSync(historyFilePath(dir), 'utf-8');
    expect(raw).not.toContain('AQEDnobody');
    expect(raw).not.toContain('ajax:1');
    expect(raw).toContain('--li-at ***');
  });

  it('creates the file owner-only and appends in order', () => {
    appendHistory('feed view', dir);
    appendHistory('profile me', dir);

    expect(loadHistory(dir)).toEqual(['feed view', 'profile me']);
    if (process.platform !== 'win32') {
      expect(statSync(historyFilePath(dir)).mode & 0o777).toBe(0o600);
    }
  });

  it('ignores blank lines', () => {
    appendHistory('   ', dir);
    expect(loadHistory(dir)).toEqual([]);
  });
});
