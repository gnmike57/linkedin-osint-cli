import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Honor XDG_CONFIG_HOME on Linux/macOS; fall back to ~/.linkedin-cli.
const CONFIG_DIR = process.env.XDG_CONFIG_HOME
  ? join(process.env.XDG_CONFIG_HOME, 'linkedin-cli')
  : join(homedir(), '.linkedin-cli');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

/**
 * Persisted session state.
 *
 * The fields fall into two groups, and the split matters because a stored
 * `cookie_header` **wins over** `li_at`/`JSESSIONID` at request time (see
 * `client.cookieHeaderFor`). A jar left behind by an earlier session therefore
 * makes every call keep using the OLD credentials while the CLI reports a fresh
 * login — a silent, very confusing auth failure.
 *
 *  - **Session-coupled** — `li_at`, `jsessionid`, `cookie_header`. Replace them
 *    together. A jar belongs to exactly one session, so if a new session arrives
 *    without one, the stored jar must be DROPPED, never carried over.
 *  - **Sticky metadata** — `profile_name`, `profile_urn`, `query_id`. These
 *    outlive a session (the queryId is a LinkedIn deploy artifact, not an
 *    account property) and must survive refreshes unless a new value is given.
 *
 * Persist sessions with {@link saveSession}, which enforces that split.
 * {@link saveConfig} is the raw whole-file write and is deliberately not called
 * from command code (a test enforces that).
 */
export interface LinkedInConfig {
  li_at: string;
  jsessionid: string;
  profile_name?: string;
  profile_urn?: string;
  /**
   * Full Cookie header captured with the session (CDP or Chrome import).
   * LinkedIn's anti-abuse invalidates sessions that send only li_at +
   * JSESSIONID, so the whole jar is persisted and replayed verbatim.
   */
  cookie_header?: string;
  /**
   * Current people-search GraphQL queryId captured from the browser (rotates
   * per LinkedIn deploy). Used as the default for `osint employees` so it keeps
   * working after a rotation without a code change.
   */
  query_id?: string;
}

/** A session update: the credentials, plus an optional jar and metadata. */
export interface LinkedInSessionPatch {
  li_at: string;
  jsessionid: string;
  /** Full Cookie header for THIS session. Omit when none was captured. */
  cookie_header?: string;
  profile_name?: string;
  profile_urn?: string;
  query_id?: string;
}

/** Normalize a possibly-quoted cookie value (`JSESSIONID="ajax:1"`). */
function unquote(value: string): string {
  return value.replace(/^"/, '').replace(/"$/, '');
}

/** Every key we persist — anything else in the file is ignored. */
const CONFIG_KEYS = [
  'li_at',
  'jsessionid',
  'profile_name',
  'profile_urn',
  'cookie_header',
  'query_id',
] as const;

export async function loadConfig(): Promise<LinkedInConfig | null> {
  let content: string;
  try {
    content = await readFile(CONFIG_FILE, 'utf-8');
  } catch {
    return null; // no config yet
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null; // corrupt file — treat as "not logged in" rather than crashing
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  // Copy only known string fields. A hand-edited or partially written file can
  // then neither poison callers with objects/numbers nor throw halfway through
  // (this used to die on `parsed.jsessionid.replace(...)`, and the catch then
  // swallowed it — reporting "no session" for a config holding a valid li_at).
  const out: Partial<Record<(typeof CONFIG_KEYS)[number], string>> = {};
  for (const key of CONFIG_KEYS) {
    const value = (parsed as Record<string, unknown>)[key];
    if (typeof value === 'string') out[key] = value;
  }

  // Both credentials are required; every caller treats a partial config as "no
  // session" anyway, so make that explicit instead of handing back a half one.
  if (!out.li_at || !out.jsessionid) return null;

  return { ...out, jsessionid: unquote(out.jsessionid) } as LinkedInConfig;
}

/**
 * Raw whole-file write. Replaces the config, so every field the caller omits is
 * lost — use {@link saveSession} from command code. Kept separate (and public)
 * so tests and {@link saveSession} have one primitive to build on.
 *
 * The write is atomic (temp file + rename): the extension bridge saves the
 * session every ~60s while other CLI processes read it, and a reader must never
 * observe a half-written file (it would look like "not logged in"), nor a crash
 * truncate the stored session.
 */
export async function saveConfig(config: LinkedInConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  const serialized = JSON.stringify(config, null, 2) + '\n';
  const tmp = `${CONFIG_FILE}.tmp`;
  await writeFile(tmp, serialized, { mode: 0o600 });
  try {
    await rename(tmp, CONFIG_FILE);
  } catch {
    // Some Windows setups refuse to replace a file another process holds open.
    // Fall back to an in-place write so the session is never lost.
    await writeFile(CONFIG_FILE, serialized, { mode: 0o600 });
    await rm(tmp, { force: true }).catch(() => {});
  }
  // `mode` above only applies when the file is CREATED, so a config written
  // before that option existed (or hand-edited) would keep its old, possibly
  // world-readable permissions. The file holds the full cookie jar — enforce it.
  await chmod(CONFIG_FILE, 0o600).catch(() => {
    /* best effort: Windows and some filesystems have no POSIX modes */
  });
}

/**
 * Persist a session update. Replaces the session-coupled fields (dropping a
 * stale jar when the new session has none) and preserves sticky metadata.
 * This is the only writer command code should call.
 */
export async function saveSession(session: LinkedInSessionPatch): Promise<void> {
  const existing = await loadConfig();
  const next: LinkedInConfig = {
    ...(existing ?? {}),
    li_at: session.li_at,
    jsessionid: unquote(session.jsessionid),
  };

  // Session-coupled: an absent jar must CLEAR the stored one, because a jar from
  // another session would otherwise override the fresh credentials on every
  // request.
  if (session.cookie_header) next.cookie_header = session.cookie_header;
  else delete next.cookie_header;

  // Sticky: preserved unless the caller supplies a non-empty value.
  if (session.profile_name) next.profile_name = session.profile_name;
  if (session.profile_urn) next.profile_urn = session.profile_urn;
  if (session.query_id) next.query_id = session.query_id;

  await saveConfig(next);
}

export async function deleteConfig(): Promise<void> {
  try {
    await rm(CONFIG_FILE);
  } catch {
    // File doesn't exist, that's fine
  }
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}
