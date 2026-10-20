import { Command } from 'commander';
import { join } from 'node:path';
import { output, outputError } from '../../core/output.js';
import type { GlobalOptions } from '../../core/types.js';

/**
 * `linkedin sessions` — the CLI face of the multi-account registry.
 *
 * CLI-only, like `login` / `logout` / `status`: account listings are operator
 * information and must not become MCP tools. The payload is credential-free by
 * construction (see `summarizeRegisteredSessions`) — fingerprints and
 * timestamps only, never `li_at`, `JSESSIONID` or the stored jar — so the output
 * is safe to paste into a bug report.
 */
export function registerSessionsCommand(program: Command): void {
  program
    .command('sessions')
    .description('List the accounts captured in the multi-account registry (never prints cookies)')
    .option('--fingerprint <selector>', 'Show one account (fingerprint, unique prefix, or "latest")')
    .option('--purge', 'Delete every registered capture (leaves the active session in config.json)')
    .action(async function (this: Command) {
      const localOpts = this.opts() as Record<string, string | boolean | undefined>;
      const globalOpts = this.optsWithGlobals() as GlobalOptions;
      try {
        const {
          listRegisteredSessions,
          loadRegisteredSession,
          purgeRegisteredSessions,
          summarizeRegisteredSessions,
          sessionFingerprint,
        } = await import('../../core/sessions.js');
        const { loadConfig, getConfigDir } = await import('../../core/config.js');

        if (localOpts.purge) {
          const { removed, dir } = purgeRegisteredSessions();
          output(
            {
              purged: removed,
              registry: dir,
              note: removed
                ? 'Accounts reappear the next time the extension bridge sends a session.'
                : 'Registry was already empty.',
            },
            globalOpts,
          );
          return;
        }

        const known = listRegisteredSessions();
        const config = await loadConfig();
        const activeFingerprint = config?.li_at ? sessionFingerprint(config.li_at) : undefined;

        const selector = typeof localOpts.fingerprint === 'string' ? localOpts.fingerprint : undefined;
        if (selector) {
          const found = loadRegisteredSession(selector);
          if (!found) {
            outputError(
              new Error(
                `No registered session matches '${selector}'.` +
                  (known.length > 0
                    ? ` Known fingerprints: ${known.map((s) => s.fingerprint).join(', ')}`
                    : ' The registry is empty.') +
                  ' Captures arrive via `linkedin extension listen`.',
              ),
              globalOpts,
            );
            return;
          }
          output(summarizeRegisteredSessions([found], activeFingerprint)[0], globalOpts);
          return;
        }

        const sessions = summarizeRegisteredSessions(known, activeFingerprint);
        output(
          {
            count: sessions.length,
            active_fingerprint: activeFingerprint ?? null,
            config_dir: getConfigDir(),
            registry_dir: join(getConfigDir(), 'sessions'),
            sessions,
            note:
              sessions.length > 0
                ? 'Pin one with LINKEDIN_SESSION=<fingerprint|latest>.'
                : 'No accounts registered yet — run `linkedin extension listen`, then let the extension send a session.',
          },
          globalOpts,
        );
      } catch (error) {
        outputError(error, globalOpts);
      }
    });
}
