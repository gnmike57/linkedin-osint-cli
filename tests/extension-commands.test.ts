import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  extensionInstallCommand,
  resolveExtensionSource,
} from '../src/commands/extension/install.js';
import { extensionListenCommand } from '../src/commands/extension/listen.js';
import { extensionStatusCommand } from '../src/commands/extension/status.js';
import { extensionCommands } from '../src/commands/extension/index.js';
import { allCommands } from '../src/commands/index.js';
import { commandToTool } from '../src/mcp/server.js';
import { postSession, waitForPort } from './helpers/bridge.js';

const outDir = 'output_test_extension';

describe('extension install', () => {
  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it('resolves the bundled extension source from the repo layout', () => {
    const source = resolveExtensionSource();
    expect(source).toBeTruthy();
    expect(existsSync(join(source!, 'manifest.json'))).toBe(true);
  });

  it('copies the extension files and returns chrome steps by default', async () => {
    const result = (await extensionInstallCommand.handler(
      { browser: 'chrome', out_dir: outDir } as never,
      {} as never,
    )) as Record<string, any>;

    expect(result.error).toBeUndefined();
    expect(result.destination).toBe(outDir);
    expect(result.files_copied).toContain('manifest.json');
    expect(result.files_copied).toContain('service-worker.js');
    expect(result.files_copied).toContain('popup.js');

    expect(existsSync(join(outDir, 'manifest.json'))).toBe(true);
    expect(existsSync(join(outDir, 'service-worker.js'))).toBe(true);
    expect(JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf-8'))).toHaveProperty('name');

    const steps = result.steps.join('\n');
    expect(steps).toContain('chrome://extensions');
    expect(steps).not.toContain('edge://extensions');
    expect(steps).toContain(outDir);
    expect(steps).toContain('Send session to CLI');
    expect(result.file_url).toMatch(/^file:/);
  });

  it('targets edge:// when --browser edge', async () => {
    const result = (await extensionInstallCommand.handler(
      { browser: 'edge', out_dir: outDir } as never,
      {} as never,
    )) as Record<string, any>;
    const steps = result.steps.join('\n');
    expect(steps).toContain('edge://extensions');
    expect(steps).not.toContain('chrome://extensions');
  });
});

describe('extension status', () => {
  it('reports a disconnected bridge with troubleshooting steps', async () => {
    // State read only — no proxy server bind, no ping wait.
    process.env.LINKEDIN_EXTENSION_PING_WAIT_MS = '0';
    try {
      const result = (await extensionStatusCommand.handler({}, {} as never)) as Record<string, any>;

      expect(result.connected).toBe(false);
      expect(result.status).toBe('disconnected');
      expect(typeof result.proxyPort).toBe('number');
      expect(result.proxyPort).toBeGreaterThan(0);
      expect(result.troubleshooting.join('\n')).toContain('linkedin extension install');
    } finally {
      delete process.env.LINKEDIN_EXTENSION_PING_WAIT_MS;
    }
  });
});

describe('extension listen', () => {
  it('acks the POST and reports the session (dry run — never writes config)', async () => {
    const pending = extensionListenCommand.handler(
      { port: 8890, seconds: 3, once: true, validate: false, dry_run: true } as never,
      {} as never,
    ) as Promise<Record<string, any>>;

    // postSession polls until the listener has bound (no fixed sleep).
    const res = await postSession(8890, {
      li_at: 'LI',
      jsessionid: 'ajax:1',
      query_id: 'voyagerSearchDashClusters.abc123',
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      query_id: 'voyagerSearchDashClusters.abc123',
    });

    const result = await pending;
    expect(result.status).toBe('stopped');
    expect(result.reason).toBe('once');
    expect(result.port).toBe(8890);
    expect(result.sessions_received).toBe(1);
    expect(result.saved).toBe(false);
  }, 10_000);

  it('rejects a POST that is not application/json (blocks blind cross-origin posts)', async () => {
    const pending = extensionListenCommand.handler(
      { port: 8894, seconds: 3, once: true, validate: false, dry_run: true } as never,
      {} as never,
    ) as Promise<Record<string, any>>;

    // A browser can only send this content-type cross-origin without a
    // preflight, so it must not be accepted.
    await waitForPort(8894);
    const res = await fetch('http://127.0.0.1:8894/session', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ li_at: 'LI', jsessionid: 'ajax:1' }),
    });
    expect(res.status).toBe(415);

    // And a proper JSON post still works.
    const ok = await postSession(8894, { li_at: 'LI', jsessionid: 'ajax:1' });
    expect(ok.status).toBe(200);
    await pending;
  }, 10_000);

  it('stops on --seconds even with nothing connected', async () => {
    const started = Date.now();
    const result = (await extensionListenCommand.handler(
      { port: 8891, seconds: 1, once: false, validate: false, dry_run: true } as never,
      {} as never,
    )) as Record<string, any>;

    expect(result.reason).toBe('timeout');
    expect(result.sessions_received).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  }, 10_000);
});

describe('extension command registration', () => {
  it('wires install + listen + status into the CLI registry and MCP tools', () => {
    expect(extensionCommands.map((c) => c.name).sort()).toEqual([
      'extension_install',
      'extension_listen',
      'extension_status',
    ]);

    const names = allCommands.map((c) => c.name);
    expect(names).toContain('extension_install');
    expect(names).toContain('extension_listen');
    expect(names).toContain('extension_status');

    expect(commandToTool.has('extension_install')).toBe(true);
    expect(commandToTool.has('extension_listen')).toBe(true);
    expect(commandToTool.has('extension_status')).toBe(true);
  });
});