import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { postSession } from './helpers/bridge.js';

/**
 * `extension listen` writes the stored session on every capture (~every 60s
 * once the extension's auto-send alarm is running), so it MUST merge rather
 * than replace `config.json` — a bare overwrite silently erased `profile_name`
 * / `profile_urn` (written by `linkedin login`) and a previously learned
 * `query_id` on any capture that carried none.
 *
 * `config.ts` resolves its directory once at import time, so XDG_CONFIG_HOME is
 * set before the dynamic imports below (the same pattern
 * tests/extension-proxy.test.ts uses for its port). That also keeps this test
 * off the operator's real ~/.linkedin-cli/config.json.
 */
const sandbox = mkdtempSync(join(tmpdir(), 'linkedin-cli-cfg-'));
process.env.XDG_CONFIG_HOME = sandbox;

const { loadConfig, saveConfig } = await import('../src/core/config.js');
const { extensionListenCommand } = await import('../src/commands/extension/listen.js');

afterAll(() => {
  delete process.env.XDG_CONFIG_HOME;
  rmSync(sandbox, { recursive: true, force: true });
});

/** Run the listener for a single capture and return its result. */
async function listenOnce(
  port: number,
  payload: Record<string, unknown>,
): Promise<Record<string, any>> {
  const pending = extensionListenCommand.handler(
    { port, seconds: 5, once: true, validate: false, dry_run: false } as never,
    {} as never,
  ) as Promise<Record<string, any>>;

  const res = await postSession(port, payload);
  expect(res.status).toBe(200);
  return pending;
}

describe('extension listen config persistence', () => {
  it('merges a capture into the config instead of replacing it', async () => {
    await saveConfig({
      li_at: 'OLD',
      jsessionid: 'old:1',
      profile_name: 'Ada Lovelace',
      profile_urn: 'urn:li:fsd_profile:ACoAAEXAMPLE',
      query_id: 'voyagerSearchDashClusters.keepme00000000000000',
    });

    const result = await listenOnce(8892, { li_at: 'NEW', jsessionid: 'new:1' });
    expect(result.sessions_received).toBe(1);
    expect(result.saved).toBe(true);

    const cfg = await loadConfig();
    expect(cfg!.li_at).toBe('NEW');
    expect(cfg!.jsessionid).toBe('new:1');
    // Fields the capture did not carry must survive.
    expect(cfg!.profile_name).toBe('Ada Lovelace');
    expect(cfg!.profile_urn).toBe('urn:li:fsd_profile:ACoAAEXAMPLE');
    expect(cfg!.query_id).toBe('voyagerSearchDashClusters.keepme00000000000000');
  }, 15_000);

  it('replaces query_id when the capture carries a fresh one', async () => {
    const result = await listenOnce(8893, {
      li_at: 'NEW2',
      jsessionid: 'new:2',
      query_id: 'voyagerSearchDashClusters.fresh000000000000000',
    });
    expect(result.sessions_received).toBe(1);

    const cfg = await loadConfig();
    expect(cfg!.query_id).toBe('voyagerSearchDashClusters.fresh000000000000000');
    expect(cfg!.profile_name).toBe('Ada Lovelace');
  }, 15_000);
});
