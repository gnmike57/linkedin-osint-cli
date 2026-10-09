import { spawn } from 'node:child_process';
import { Command } from 'commander';
import { saveSession } from '../../core/config.js';
import { createClient } from '../../core/client.js';
import { output, outputError } from '../../core/output.js';
import { resolveAuth, wantsFromChrome } from '../../core/auth.js';
import type { GlobalOptions, LinkedInAuth } from '../../core/types.js';

/** Open a URL in the user's default browser. Never waits for the browser. */
export function openInBrowser(url: string): void {
  const cmd =
    process.platform === 'win32'
      ? { bin: 'cmd', args: ['/c', 'start', '', url] }
      : process.platform === 'darwin'
        ? { bin: 'open', args: [url] }
        : { bin: 'xdg-open', args: [url] };
  const child = spawn(cmd.bin, cmd.args, { stdio: 'ignore', detached: true });
  child.on('error', () => {
    /* swallowed: the fallback cookie-paste flow still works */
  });
  child.unref();
}

/**
 * CDP capture fallback: open a dedicated Chromium window (throwaway profile)
 * and read cookies live while the user signs in. Works regardless of cookie
 * encryption; the temporary profile is deleted afterwards.
 */
async function captureViaCdp(options: { headless?: boolean } = {}): Promise<LinkedInAuth | undefined> {
  try {
    const { captureLinkedInCookiesViaCdp } = await import('../../core/cdp-cookies.js');
    const cdp = await captureLinkedInCookiesViaCdp({ headless: options.headless });
    process.stderr.write('Session cookies captured from the browser.\n');
    return {
      liAt: cdp.liAt,
      jsessionid: cdp.jsessionid,
      cookieHeader: cdp.cookieHeader,
      cookies: cdp.cookies,
    } as LinkedInAuth;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Browser session capture failed: ${reason}\n`);
    return undefined;
  }
}

/**
 * True when this machine's Chromium stores LinkedIn cookies app-bound
 * (v11/v20) — unreadable by any external process. Used to route `--from-chrome`
 * to live CDP capture instead of failing with an opaque decryption error.
 */
async function isAppBoundChromeStore(): Promise<boolean> {
  try {
    const { linkedInCookiesAreAppBound } = await import('../../core/chrome-cookies.js');
    return await linkedInCookiesAreAppBound();
  } catch {
    return false;
  }
}

function sessionInvalidReason(err: { code?: string; statusCode?: number; message?: string }): string | null {
  if (err?.code === 'AUTH_ERROR' || err?.statusCode === 401) {
    return 'Session cookies expired. Run: linkedin login';
  }
  if (err?.code === 'CHALLENGE_ERROR') {
    return err.message ?? 'LinkedIn requires a CAPTCHA or verification challenge. Try refreshing your cookie session.';
  }
  return null;
}

export function registerLoginCommand(program: Command): void {
  program
    .command('login')
    .description('Store your LinkedIn session cookies (li_at + JSESSIONID) for CLI use')
    .option('--li-at <cookie>', 'li_at cookie value (from browser DevTools)')
    .option('--jsessionid <cookie>', 'JSESSIONID cookie value (from browser DevTools)')
    .option('--from-chrome', 'Read cookies from a Chrome/Edge profile on this local machine')
    .option('--chrome-profile <name>', 'Chrome profile directory name (default: Default)')
    .option('--browser', 'Open a dedicated browser window (tool-owned profile) and capture the session automatically — sign in once, reused on later runs')
    .option('--extension', 'Capture the session from the companion Chrome extension (no re-login; load assets/browser-extension first)')
    .option('--port <n>', 'Localhost port for --extension (default: 8787)', '8787')
    .option('--headless', 'With --browser/--from-chrome: run the capture browser headless (only works if that profile is already signed in)')
    .option('--skip-validation', 'Save cookies without verifying them against LinkedIn')
    .action(async function (this: Command) {
      const localOpts = this.opts() as Record<string, string | boolean | undefined>;
      const globalOpts = this.optsWithGlobals() as GlobalOptions & Record<string, string | boolean | undefined>;

      try {
        let liAt = (localOpts.liAt ?? globalOpts.liAt) as string | undefined;
        let jsessionid = (localOpts.jsessionid ?? globalOpts.jsessionid) as string | undefined;
        const skipValidation = localOpts.skipValidation as boolean | undefined;
        const chromeProfile = (localOpts.chromeProfile ?? globalOpts.chromeProfile) as string | undefined;
        let chromeAuth: LinkedInAuth | undefined;

        if (localOpts.extension) {
          // Capture from the companion browser extension over a localhost socket
          // — works with app-bound cookies and needs no re-login.
          const { captureSessionFromExtension } = await import('../../core/extension-bridge.js');
          const port = localOpts.port ? Number(localOpts.port) : undefined;
          const cap = await captureSessionFromExtension({ port, validate: !skipValidation });
          await saveSession({
            li_at: cap.liAt,
            jsessionid: cap.jsessionid,
            cookie_header: cap.cookieHeader,
            ...(cap.queryId ? { query_id: cap.queryId } : {}),
          });
          output(
            {
              message: 'Login successful (session captured from the browser extension)',
              cookies: cap.cookieHeader.split(';').length,
              query_id: cap.queryId,
              config: '~/.linkedin-cli/config.json',
              validated: !skipValidation,
            },
            globalOpts,
          );
          return;
        }

        if (localOpts.browser && !(liAt && jsessionid)) {
          // Browser-assisted login: LinkedIn has no consumer OAuth2, so
          // capturing the browser session is the supported way to
          // authenticate this CLI.
          //
          // If a valid session is already stored, do nothing — never disturb
          // an existing login.
          const { loadConfig } = await import('../../core/config.js');
          const existing = await loadConfig().catch(() => null);
          if (existing?.li_at && existing?.jsessionid) {
            try {
              const client = createClient({
                liAt: existing.li_at,
                jsessionid: existing.jsessionid,
                ...(existing.cookie_header ? { cookieHeader: existing.cookie_header } : {}),
              });
              const me = await client.get<any>('/me');
              const name = [me?.firstName, me?.lastName].filter(Boolean).join(' ');
              output(
                {
                  logged_in: true,
                  source: 'config',
                  session_valid: true,
                  profile: name || existing.profile_name || 'Unknown',
                  message:
                    `Already signed in${name ? ` as ${name}` : ''}. Nothing to do. ` +
                    "Run 'linkedin logout' first to switch accounts.",
                },
                globalOpts,
              );
              return;
            } catch {
              // Stored session is stale or unverifiable — re-login below.
            }
          }
          // Capture over CDP on the tool-owned *persistent* profile: sign in
          // once, and every later run reuses it silently (and headless).
          process.stderr.write(
            'Opening the dedicated login window (tool-owned profile) — ' +
              'sign in once; the session is captured and reused on later runs.\n',
          );
          chromeAuth = await captureViaCdp({ headless: Boolean(localOpts.headless) });
          if (!chromeAuth) {
            process.stderr.write(
              'Could not capture the session automatically. Falling back to manual cookie paste.\n',
            );
          }
        }

        if (chromeAuth) {
          liAt = chromeAuth.liAt;
          jsessionid = chromeAuth.jsessionid;
        } else if (
          wantsFromChrome({
            fromChrome: Boolean(localOpts.fromChrome ?? globalOpts.fromChrome),
            chromeProfile,
          })
        ) {
          // Chrome 127+ stores LinkedIn cookies app-bound (v11/v20), which no
          // external process can decrypt. Detect that and route to live CDP
          // capture instead of failing with an opaque decryption error.
          if (await isAppBoundChromeStore()) {
            process.stderr.write(
              'Chrome stores LinkedIn cookies app-bound (v11/v20) — direct read is ' +
                'impossible. Switching to live browser capture (tool-owned profile).\n',
            );
            chromeAuth = await captureViaCdp({ headless: Boolean(localOpts.headless) });
            if (!chromeAuth) {
              throw new Error(
                'Chrome cookies are app-bound and live capture did not complete. ' +
                  'Run: linkedin login --browser',
              );
            }
            liAt = chromeAuth.liAt;
            jsessionid = chromeAuth.jsessionid;
          } else {
            // Readable cookies — read once, throw on failure.
            chromeAuth = await resolveAuth({ fromChrome: true, chromeProfile });
            liAt = chromeAuth.liAt;
            jsessionid = chromeAuth.jsessionid;
          }
        }
        // --browser with a failed capture falls through to the paste prompt.
        const strictChrome = Boolean(localOpts.fromChrome ?? globalOpts.fromChrome);

        // Interactive mode if cookies not provided as flags and not reading Chrome.
        // --browser that failed to capture falls through to this paste prompt.
        if ((!strictChrome && !chromeAuth) && (!liAt || !jsessionid)) {
          const { password: promptPassword } = await import('@inquirer/prompts');

          if (!liAt) {
            liAt = await promptPassword({
              message: 'Paste your li_at cookie value (from browser DevTools → Application → Cookies → linkedin.com):',
              mask: '*',
            });
          }
          if (!jsessionid) {
            jsessionid = await promptPassword({
              message: 'Paste your JSESSIONID cookie value (include the quotes if present):',
              mask: '*',
            });
          }
          liAt = liAt.trim();
          jsessionid = jsessionid.trim();
        }

        if (!liAt || !jsessionid) {
          throw new Error('Both li_at and JSESSIONID cookies are required');
        }

        // Clean up JSESSIONID (remove surrounding quotes if present)
        jsessionid = jsessionid.replace(/^"/, '').replace(/"$/, '');

        // Save cookies FIRST — before any validation. Never print cookie values.
        // Persist the full captured jar (when available): LinkedIn invalidates
        // sessions that present only li_at + JSESSIONID on later calls, and a jar
        // from a DIFFERENT session must not survive — saveSession drops it.
        await saveSession({
          li_at: liAt,
          jsessionid,
          ...(chromeAuth?.cookieHeader ? { cookie_header: chromeAuth.cookieHeader } : {}),
        });

        // Optionally validate by fetching /me
        if (!skipValidation) {
          try {
            const client = createClient(
              chromeAuth ?? { liAt, jsessionid },
            );
            const me = await client.get<any>('/me');
            const profileName = [me?.firstName, me?.lastName].filter(Boolean).join(' ') || 'Unknown';
            const profileUrn = me?.entityUrn ?? me?.publicIdentifier ?? '';

            // Update config with profile info. Sticky metadata (query_id) and a
            // previously stored jar survive; the jar is only replaced when this
            // login actually captured one.
            await saveSession({
              li_at: liAt,
              jsessionid,
              profile_name: profileName,
              profile_urn: profileUrn,
              ...(chromeAuth?.cookieHeader ? { cookie_header: chromeAuth.cookieHeader } : {}),
            });

            output({
              message: chromeAuth
                ? 'Login successful (cookies imported from Chrome)'
                : 'Login successful',
              profile: profileName,
              urn: profileUrn,
              config: '~/.linkedin-cli/config.json',
              validated: true,
            }, globalOpts);
          } catch (validationErr: any) {
            // Cookies saved but validation failed — warn, don't fail
            output({
              message: 'Cookies saved but validation failed — they may still work',
              warning: validationErr?.message ?? String(validationErr),
              hint: 'Default Node fetch is often fingerprinted. On this local machine, retry with LINKEDIN_HTTP=curl-impersonate or --from-chrome.',
              config: '~/.linkedin-cli/config.json',
              validated: false,
            }, globalOpts);
          }
        } else {
          output({
            message: 'Cookies saved (validation skipped)',
            config: '~/.linkedin-cli/config.json',
            validated: false,
          }, globalOpts);
        }
      } catch (error) {
        outputError(error, globalOpts);
      }
    });
}

export function registerLogoutCommand(program: Command): void {
  program
    .command('logout')
    .description('Remove stored LinkedIn session cookies')
    .action(async () => {
      const globalOpts = program.optsWithGlobals() as GlobalOptions;
      try {
        const { deleteConfig } = await import('../../core/config.js');
        const { isBridgeListening } = await import('../../core/extension-bridge.js');
        await deleteConfig();

        // A long-running `extension listen` would save the browser session
        // straight back on its next auto-send (~60s), silently re-logging the
        // operator in. Say so instead of letting logout appear to work.
        const bridgeUp = await isBridgeListening();
        output(
          {
            message: 'Logged out. Session cookies removed.',
            ...(bridgeUp
              ? {
                  warning:
                    'A session bridge is still listening on 127.0.0.1:8787 — an ' +
                    'always-on `linkedin extension listen` will save the browser ' +
                    'session again within ~60s. Stop it first for the logout to stick.',
                }
              : {}),
          },
          globalOpts,
        );
      } catch (error) {
        outputError(error, globalOpts);
      }
    });
}

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Check current login status (reads config only, use --verify to check session live)')
    .option('--verify', 'Make an API call to verify the session is still valid')
    .action(async function (this: Command) {
      const localOpts = this.opts() as Record<string, boolean | undefined>;
      const globalOpts = this.optsWithGlobals() as GlobalOptions;
      try {
        const { loadConfig } = await import('../../core/config.js');
        const config = await loadConfig();
        const fromChrome = wantsFromChrome({
          fromChrome: globalOpts.fromChrome,
          chromeProfile: globalOpts.chromeProfile,
        });
        const hasManual = Boolean(
          (globalOpts.liAt && globalOpts.jsessionid) ||
            (process.env.LINKEDIN_LI_AT && process.env.LINKEDIN_JSESSIONID) ||
            (config?.li_at && config?.jsessionid),
        );

        if (!fromChrome && !hasManual) {
          output({ logged_in: false, message: 'No session cookies stored. Run: linkedin login' }, globalOpts);
          return;
        }

        const source = fromChrome ? 'chrome' : globalOpts.liAt || process.env.LINKEDIN_LI_AT ? 'env-or-flag' : 'config';

        // Default: just show what's stored, no API call
        if (!localOpts.verify) {
          output({
            logged_in: true,
            source,
            profile: config?.profile_name || 'Unknown',
            urn: config?.profile_urn || '',
            config: '~/.linkedin-cli/config.json',
            note: 'Use --verify to check if session is still valid',
          }, globalOpts);
          return;
        }

        // --verify: make a live API call. Use resolveAuth so --from-chrome /
        // LINKEDIN_FROM_CHROME / env vars are honored, not just the config file.
        const auth = await resolveAuth({
          liAt: globalOpts.liAt,
          jsessionid: globalOpts.jsessionid,
          fromChrome: globalOpts.fromChrome,
          chromeProfile: globalOpts.chromeProfile,
        });
        const client = createClient(auth);
        try {
          const me = await client.get<any>('/me');
          const name = [me?.firstName, me?.lastName].filter(Boolean).join(' ');
          output({
            logged_in: true,
            source,
            profile: name || config?.profile_name || 'Unknown',
            urn: me?.entityUrn || config?.profile_urn,
            session_valid: true,
          }, globalOpts);
        } catch (err: any) {
          const authMessage = sessionInvalidReason(err);
          if (authMessage) {
            output({
              logged_in: true,
              source,
              profile: config?.profile_name || 'Unknown',
              session_valid: false,
              message: authMessage,
            }, globalOpts);
          } else {
            output({
              logged_in: true,
              source,
              profile: config?.profile_name || 'Unknown',
              session_valid: 'unknown',
              message: `Could not verify session: ${err?.message ?? err}`,
            }, globalOpts);
          }
        }
      } catch (error) {
        outputError(error, globalOpts);
      }
    });
}
