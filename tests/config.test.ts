import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `config.ts` resolves its directory once at import time, so XDG_CONFIG_HOME is
 * set before the dynamic imports below — the same pattern
 * tests/extension-proxy.test.ts uses for its port. That also keeps this suite
 * off the operator's real ~/.linkedin-cli/config.json.
 */
const sandbox = mkdtempSync(join(tmpdir(), 'linkedin-cli-config-'));
process.env.XDG_CONFIG_HOME = sandbox;

const { loadConfig, saveConfig, saveSession } = await import('../src/core/config.js');

const dir = join(sandbox, 'linkedin-cli');
const configPath = join(dir, 'config.json');

function writeRaw(raw: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, raw);
}

afterAll(() => {
  delete process.env.XDG_CONFIG_HOME;
  rmSync(sandbox, { recursive: true, force: true });
});

describe('loadConfig robustness', () => {
  it('returns null for a missing, corrupt, or non-object file', async () => {
    rmSync(configPath, { force: true });
    expect(await loadConfig()).toBeNull();

    writeRaw('not json at all');
    expect(await loadConfig()).toBeNull();

    writeRaw('[1,2,3]');
    expect(await loadConfig()).toBeNull();

    writeRaw('"a string"');
    expect(await loadConfig()).toBeNull();
  });

  it('returns null for a partial config instead of a half-built one', async () => {
    // Regression: `parsed.jsessionid.replace(...)` used to throw here and the
    // catch swallowed it, reporting "no session" for a config with a valid
    // li_at. Both credentials must be handled explicitly.
    writeRaw(JSON.stringify({ li_at: 'LI' }));
    expect(await loadConfig()).toBeNull();

    writeRaw(JSON.stringify({ jsessionid: 'ajax:1' }));
    expect(await loadConfig()).toBeNull();
  });

  it('drops non-string junk and unknown keys, and normalizes a quoted jsessionid', async () => {
    writeRaw(
      JSON.stringify({
        li_at: 'LI',
        jsessionid: '"ajax:1"',
        query_id: 42,
        cookie_header: { not: 'a string' },
        something_else: 'ignored',
      }),
    );

    expect(await loadConfig()).toEqual({ li_at: 'LI', jsessionid: 'ajax:1' });
  });
});

describe('saveSession field semantics', () => {
  it('writes the session and preserves sticky metadata', async () => {
    await saveConfig({
      li_at: 'A',
      jsessionid: 'a:1',
      profile_name: 'Ada Lovelace',
      profile_urn: 'urn:li:fsd_profile:A',
      query_id: 'voyagerSearchDashClusters.q1',
      cookie_header: 'li_at=A; JSESSIONID=a:1',
    });

    await saveSession({
      li_at: 'B',
      jsessionid: 'b:1',
      cookie_header: 'li_at=B; JSESSIONID=b:1',
    });

    expect(await loadConfig()).toEqual({
      li_at: 'B',
      jsessionid: 'b:1',
      profile_name: 'Ada Lovelace',
      profile_urn: 'urn:li:fsd_profile:A',
      query_id: 'voyagerSearchDashClusters.q1',
      cookie_header: 'li_at=B; JSESSIONID=b:1',
    });
  });

  it('DROPS a stored jar when the new session has none', async () => {
    // The critical case: a jar left behind by an earlier session WINS over
    // li_at at request time, so keeping it would keep the CLI on the old
    // credentials while reporting a fresh login.
    await saveConfig({
      li_at: 'A',
      jsessionid: 'a:1',
      cookie_header: 'li_at=A; JSESSIONID=a:1',
      query_id: 'voyagerSearchDashClusters.q1',
    });

    await saveSession({ li_at: 'B', jsessionid: 'b:1' });

    const cfg = await loadConfig();
    expect(cfg!.li_at).toBe('B');
    expect(cfg!.cookie_header).toBeUndefined();
    expect(cfg!.query_id).toBe('voyagerSearchDashClusters.q1'); // sticky survives
  });

  it('normalizes a quoted jsessionid and works with no existing config', async () => {
    rmSync(configPath, { force: true });
    await saveSession({ li_at: 'A', jsessionid: '"ajax:1"' });
    expect(await loadConfig()).toEqual({ li_at: 'A', jsessionid: 'ajax:1' });
  });

  it('overwrites sticky metadata only when a non-empty value is supplied', async () => {
    await saveConfig({ li_at: 'A', jsessionid: 'a:1', profile_name: 'Ada', query_id: 'q1' });

    await saveSession({ li_at: 'B', jsessionid: 'b:1', profile_urn: '' });

    const cfg = await loadConfig();
    expect(cfg!.profile_name).toBe('Ada'); // untouched
    expect(cfg!.profile_urn).toBeUndefined(); // empty string is "not provided"
    expect(cfg!.query_id).toBe('q1');
  });

  it('restricts the config file to the owner', async () => {
    await saveSession({ li_at: 'A', jsessionid: 'a:1' });
    if (process.platform === 'win32') return; // no POSIX modes on Windows
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it('writes atomically — no temp file is left behind', async () => {
    rmSync(configPath, { force: true });
    await saveSession({ li_at: 'A', jsessionid: 'a:1' });
    expect(existsSync(`${configPath}.tmp`)).toBe(false);
    expect(await loadConfig()).toEqual({ li_at: 'A', jsessionid: 'a:1' });
  });
});
