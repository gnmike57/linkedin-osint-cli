import { loadConfig, saveSession } from './config.js';
import { AuthError } from './errors.js';
import type { AuthFlags, LinkedInAuth } from './types.js';
import { loadLinkedInCookiesFromChrome } from './chrome-cookies.js';

export function wantsFromChrome(flags?: AuthFlags): boolean {
  return (
    flags?.fromChrome === true ||
    process.env.LINKEDIN_FROM_CHROME === '1' ||
    process.env.LINKEDIN_FROM_CHROME === 'true'
  );
}

export async function resolveAuth(flags?: AuthFlags): Promise<LinkedInAuth> {
  // Explicit multi-account pin: LINKEDIN_SESSION=<fingerprint|latest> selects a
  // session from the registry (~/.linkedin-cli/sessions/). Highest priority —
  // it is the most specific instruction about WHICH account to act as.
  const selector = process.env.LINKEDIN_SESSION;
  if (selector) {
    const { loadRegisteredSession, registeredSessionToAuth } = await import('./sessions.js');
    const session = loadRegisteredSession(selector);
    if (!session) {
      throw new AuthError(
        `No registered session matches LINKEDIN_SESSION='${selector}'. ` +
          'Captures arrive automatically via `linkedin extension listen`.',
      );
    }
    return registeredSessionToAuth(session);
  }

  // Priority: --from-chrome / LINKEDIN_FROM_CHROME > CLI flags > env vars > config file
  if (wantsFromChrome(flags)) {
    const profile = flags?.chromeProfile ?? process.env.LINKEDIN_CHROME_PROFILE ?? 'Default';
    try {
      const result = await loadLinkedInCookiesFromChrome(profile);
      return {
        liAt: result.liAt,
        jsessionid: result.jsessionid,
        cookieHeader: result.cookieHeader,
      };
    } catch (err) {
      throw new AuthError(`Could not load LinkedIn cookies from Chrome: ${(err as Error).message}`);
    }
  }

  const config = await loadConfig();

  const liAt = flags?.liAt ?? process.env.LINKEDIN_LI_AT ?? config?.li_at;
  const jsessionid = flags?.jsessionid ?? process.env.LINKEDIN_JSESSIONID ?? config?.jsessionid;

  if (!liAt) {
    throw new AuthError(
      'No li_at cookie found. Set LINKEDIN_LI_AT, use --li-at, run `linkedin login`, or use --from-chrome.',
    );
  }

  if (!jsessionid) {
    throw new AuthError(
      'No JSESSIONID cookie found. Set LINKEDIN_JSESSIONID, use --jsessionid, run `linkedin login`, or use --from-chrome.',
    );
  }

  // Prefer the stored full jar over a thin li_at+JSESSIONID header —
  // LinkedIn invalidates sessions that present only the two auth cookies.
  // Only replay it when the cookies themselves came from the config; an
  // explicit --li-at / env override must not be mixed with a stale jar.
  const usingStoredCookies =
    !flags?.liAt && !process.env.LINKEDIN_LI_AT &&
    !flags?.jsessionid && !process.env.LINKEDIN_JSESSIONID;
  const storedJar =
    usingStoredCookies && config?.cookie_header && config.cookie_header.includes('li_at=')
      ? config.cookie_header
      : undefined;

  return { liAt, jsessionid, cookieHeader: storedJar };
}

/**
 * Re-capture the session from the tool-owned persistent browser profile and
 * persist it. Used to transparently recover from a mid-run auth failure (a 401)
 * without forcing the user to re-run `linkedin login`. Returns null when no live
 * session is available, so the caller can surface the usual login hint.
 *
 * Skipped under the test runner so unit tests never spawn a browser.
 */
export async function refreshSessionFromBrowser(): Promise<LinkedInAuth | null> {
  if (process.env.VITEST) return null;
  // Diagnostics/scrapes that route through the extension proxy don't want the
  // CDP sign-in fallback spinning up (it can block for minutes on a profile
  // that isn't signed in) — the browser itself already holds the live session.
  if (process.env.LINKEDIN_NO_REFRESH === '1') return null;
  try {
    const { captureLinkedInCookiesViaCdp } = await import('./cdp-cookies.js');
    const cdp = await captureLinkedInCookiesViaCdp({ headless: true });
    // saveSession keeps sticky metadata (profile_*, query_id) and replaces the
    // jar only when this capture produced one — a jar from the pre-refresh
    // session must not survive, since it would override the new credentials.
    await saveSession({
      li_at: cdp.liAt,
      jsessionid: cdp.jsessionid,
      ...(cdp.cookieHeader ? { cookie_header: cdp.cookieHeader } : {}),
    });
    return { liAt: cdp.liAt, jsessionid: cdp.jsessionid, cookieHeader: cdp.cookieHeader };
  } catch {
    return null;
  }
}
