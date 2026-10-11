import { z } from 'zod';
import type { CommandDefinition } from '../../core/types.js';
import { saveSession } from '../../core/config.js';
import { serveSessionFromExtension, type BridgeServerHandle } from '../../core/extension-bridge.js';

const DEFAULT_PORT = 8787;

const inputSchema = z.object({
  port: z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .optional()
    .describe('Localhost port to listen on (default 8787)'),
  seconds: z.coerce
    .number()
    .min(1)
    .optional()
    .describe('Stop automatically after this many seconds (default: run until Ctrl+C)'),
  once: z.boolean().default(false).describe('Stop after the first captured session'),
  validate: z
    .boolean()
    .default(false)
    .describe('Verify each session against /me before accepting it (adds a Voyager call)'),
  dry_run: z
    .boolean()
    .default(false)
    .describe('Receive and report sessions without writing them to config.json'),
});

/**
 * `linkedin extension listen` — a long-lived localhost bridge.
 *
 * `linkedin login --extension` only listens for a single session and exits, so
 * the browser extension's "Send session to CLI" button fails with "CLI not
 * listening on 127.0.0.1:8787" unless that command happens to be running at the
 * exact moment. This command keeps the listener up, persists every session the
 * extension auto-sends, and refreshes the people-search queryId as it rotates.
 *
 * Local-only (binds 127.0.0.1). Blocks until Ctrl+C, `--seconds`, or `--once`.
 */
export const extensionListenCommand: CommandDefinition = {
  name: 'extension_listen',
  group: 'extension',
  subcommand: 'listen',
  description:
    'Keep the extension session bridge listening (long-running) so the browser can push its session + queryId at any time; persists each capture. Stops on Ctrl+C, --seconds, or --once',
  examples: [
    'linkedin extension listen',
    'linkedin extension listen --seconds 300',
    'linkedin extension listen --once --dry-run',
  ],

  inputSchema,

  cliMappings: {
    options: [
      { field: 'port', flags: '-p, --port <n>', description: 'Localhost port (default 8787)' },
      { field: 'seconds', flags: '--seconds <n>', description: 'Stop after N seconds (default: until Ctrl+C)' },
      { field: 'once', flags: '--once', description: 'Stop after the first captured session' },
      { field: 'validate', flags: '--validate', description: 'Verify each session against /me' },
      { field: 'dry_run', flags: '--dry-run', description: 'Report captures without saving them' },
    ],
  },

  handler: async (input) => {
    const opts = input as {
      port?: number;
      seconds?: number;
      once: boolean;
      validate: boolean;
      dry_run: boolean;
    };
    const port = opts.port ?? (Number(process.env.LINKEDIN_BRIDGE_PORT) || DEFAULT_PORT);
    const log = (line: string): void => {
      process.stderr.write(`${line}\n`);
    };

    let received = 0;
    // Resolved once the first capture has been fully handled (drives --once).
    let firstCaptureDone: (() => void) | null = null;
    const firstCapture = new Promise<void>((resolve) => {
      firstCaptureDone = resolve;
    });

    const handle: BridgeServerHandle = await serveSessionFromExtension({
      port,
      validate: opts.validate,
      onStatus: (m) => log(`[bridge] ${m}`),
      onCapture: async (cap) => {
        received += 1;
        const ops = (cap.voyagerOps ?? []).map((op) => op.split('@')[0]);
        const summary =
          `session #${received} · cookies=${cap.cookieHeader.split(';').length} · ` +
          `query_id=${cap.queryId ?? 'not captured'} · ` +
          `voyager_ops=[${ops.join(', ')}]`;
        if (opts.dry_run) {
          log(`[bridge] ${summary} — dry run, not saved`);
        } else {
          // saveSession merges: it replaces the session-coupled fields (dropping
          // a stale jar when the capture carried none) and preserves sticky
          // metadata. This runs on every auto-send (~60s), so a bare overwrite
          // would erase `profile_name`/`profile_urn` from `linkedin login` and a
          // previously learned `query_id`.
          await saveSession({
            li_at: cap.liAt,
            jsessionid: cap.jsessionid,
            cookie_header: cap.cookieHeader,
            ...(cap.queryId ? { query_id: cap.queryId } : {}),
          });
          log(`[bridge] ${summary} — saved to ~/.linkedin-cli/config.json`);

          // Also record the capture in the multi-account registry, keyed by a
          // fingerprint of li_at — several accounts can auto-send
          // concurrently without overwriting each other, and commands can pin
          // one with LINKEDIN_SESSION=<fingerprint|latest>.
          const { saveRegisteredSession } = await import('../../core/sessions.js');
          const registered = saveRegisteredSession({
            liAt: cap.liAt,
            jsessionid: cap.jsessionid,
            cookieHeader: cap.cookieHeader,
            queryId: cap.queryId,
            source: 'browser-extension',
          });
          log(`[bridge] registry: ${registered.fingerprint} (#${registered.captures})`);
        }
        firstCaptureDone?.();
      },
    });

    log(
      `[bridge] Listening on ${handle.url}/session (Ctrl+C to stop). ` +
        'Leave this running; the extension can now send its session at any time.',
    );

    const stopped = await new Promise<string>((resolve) => {
      let secondsTimer: ReturnType<typeof setTimeout> | undefined;

      const stop = (reason: string): void => {
        if (secondsTimer) clearTimeout(secondsTimer);
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
        resolve(reason);
      };
      const onSignal = (): void => stop('signal');

      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);

      if (opts.seconds) {
        secondsTimer = setTimeout(() => stop('timeout'), opts.seconds * 1000);
      }
      if (opts.once) {
        // Wait for the capture to finish, then a beat longer so the extension's
        // POST response is flushed before we close the socket under it.
        void firstCapture.then(() => setTimeout(() => stop('once'), 200));
      }
    });

    await handle.close();
    return {
      status: 'stopped',
      reason: stopped,
      port,
      sessions_received: received,
      saved: !opts.dry_run,
      config: opts.dry_run ? undefined : '~/.linkedin-cli/config.json',
    };
  },
};
