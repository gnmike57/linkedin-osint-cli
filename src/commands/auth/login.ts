import { spawn } from 'node:child_process';
import { Command } from 'commander';
import { saveConfig } from '../../core/config.js';
import { createClient } from '../../core/client.js';
import { output, outputError } from '../../core/output.js';
import { resolveAuth, wantsFromChrome } from '../../core/auth.js';
import { chromiumCookieStoreAvailable, linkedInCookiesAreAppBound } from '../../core/chrome-cookies.js';
import type { GlobalOptions, LinkedInAuth } from '../../core/types.js';

const LINKEDIN_LOGIN_URL = 'https://www.linkedin.com/login';
const BROWSER_POLL_INTERVAL_MS = 3_000;
const LOCAL_POLL_BUDGET_MS = 60_000;

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll the local Chromium cookie store until a LinkedIn session appears.
 * Bounded by `budgetMs` so a v20-encrypted or locked store cannot stall the
 * flow. Returns undefined on timeout; callers should fall back to CDP capture.
 */
async function pollLocalCookieStore(
  chromeProfile: string | undefined,
  budgetMs: number,
): Promise<LinkedInAuth | undefined> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      const auth = await resolveAuth({ fromChrome: true, chromeProfile });
      process.stderr.write('Session cookies captured from the browser.\n');
      return auth;
    } catch {
      await sleep(BROWSER_POLL_INTERVAL_MS);
    }
  }
  return undefined;
}

/**
 * CDP capture fallback: open a dedicated Chromium window (throwaway profile)
 * and read cookies live while the user signs in. Works regardless of cookie
 * encryption; the temporary profile is deleted afterwards.
 */
async function captureViaCdp(): Promise<LinkedInAuth | undefined> {
  try {
    const { captureLinkedInCookiesViaCdp } = await import('../../core/cdp-cookies.js');
    const cdp = await captureLinkedInCookiesViaCdp();
    process.stderr.write('Session cookies captured from the browser.\n');
    return {
      liAt: cdp.liAt,
      jsessionid: cdp.jsessionid,
      cookieHeader: cdp.cookieHeader,
      cookies: cdp.cookies,
    } as LinkedInAuth;
  } catch {
    return undefined;
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
    .option('--browser', 'Open LinkedIn login in your default browser and capture the session automatically')
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

        if (localOpts.browser && !(liAt && jsessionid)) {
          // Browser-assisted login: capture the session from the browser.
          // LinkedIn has no consumer OAuth2, so capturing the browser session
          // is the supported way to authenticate this CLI.
          const appBound = await linkedInCookiesAreAppBound().catch(() => false);
          if (chromiumCookieStoreAvailable(chromeProfile) && !appBound) {
            openInBrowser(LINKEDIN_LOGIN_URL);
            process.stderr.write(
              'Opened linkedin.com/login in your default browser. ' +
                'Sign in there and leave it open — this will capture the session automatically...\n',
            );
            chromeAuth = await pollLocalCookieStore(chromeProfile, LOCAL_POLL_BUDGET_MS);
            if (!chromeAuth) {
              process.stderr.write(
                'The local cookie store did not yield a session. Opening a dedicated login window...\n',
              );
              chromeAuth = await captureViaCdp();
            }
          } else {
            process.stderr.write(
              'Your browser encrypts its cookies so other programs cannot read them. ' +
                'Opening a dedicated login window — sign in there and your session will be captured automatically.\n',
            );
            chromeAuth = await captureViaCdp();
          }
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
          // Strict --from-chrome (no browser fallback): read once, throw on failure.
          chromeAuth = await resolveAuth({ fromChrome: true, chromeProfile });
          liAt = chromeAuth.liAt;
          jsessionid = chromeAuth.jsessionid;
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
        await saveConfig({
          li_at: liAt,
          jsessionid,
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

            // Update config with profile info
            await saveConfig({
              li_at: liAt,
              jsessionid,
              profile_name: profileName,
              profile_urn: profileUrn,
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
        await deleteConfig();
        output({ message: 'Logged out. Session cookies removed.' }, globalOpts);
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
