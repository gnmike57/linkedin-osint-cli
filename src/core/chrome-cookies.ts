import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';

/**
 * Reads LinkedIn cookies from Chromium-based browsers' local cookie stores
 * (Chrome, Edge) and decrypts them. Local-harness only (the machine that owns
 * the browser profile). Do not use from a cloud agent or remote runner.
 * Supports macOS, Linux, and Windows. Chrome can be running — the SQLite DB
 * is copied to a temp location first so we don't fight the browser's lock.
 *
 * Windows uses the DPAPI-protected master key from the browser's "Local
 * State" file (unlocked via PowerShell) and AES-256-GCM cookie decryption.
 * v11/v20 app-bound encrypted cookies (Chrome 127+ app-bound rollout) cannot
 * be decrypted from another process and are skipped.
 *
 * Cookie values are never written to the process log or thrown error messages.
 */

export interface ChromeCookieResult {
  liAt: string;
  jsessionid: string;
  /** Full cookie header with all linkedin.com cookies (browser-shaped jar). */
  cookieHeader: string;
  /** Raw decoded cookies, keyed by name. */
  cookies: Record<string, string>;
  /** Path to the Chrome profile used. */
  profilePath: string;
}

export function chromeUserDataDirs(): string[] {
  if (process.env.LINKEDIN_CHROME_USER_DATA_DIR) {
    return [process.env.LINKEDIN_CHROME_USER_DATA_DIR];
  }

  const home = homedir();
  if (process.platform === 'darwin') {
    return [join(home, 'Library/Application Support/Google/Chrome')];
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    return [
      join(local, 'Google', 'Chrome', 'User Data'),
      join(local, 'Microsoft', 'Edge', 'User Data'),
    ];
  }
  if (process.platform === 'linux') {
    return [join(home, '.config/google-chrome'), join(home, '.config/chromium')];
  }
  throw new Error(`Chromium cookie reader does not support platform ${process.platform}.`);
}

function chromeProfileDir(profile: string): { profilePath: string; userDataDir: string } {
  const dirs = chromeUserDataDirs();
  for (const dir of dirs) {
    const candidate = join(dir, profile);
    if (existsSync(candidate)) {
      return { profilePath: candidate, userDataDir: dir };
    }
  }
  // Edge's first profile is usually named "Default" too, but fall back to
  // scanning for any profile that exists when the requested one doesn't.
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const fallback of ['Default', 'Profile 1']) {
      const candidate = join(dir, fallback);
      if (existsSync(candidate)) {
        return { profilePath: candidate, userDataDir: dir };
      }
    }
  }
  throw new Error(
    `Chrome profile "${profile}" not found. Looked in:\n  ${dirs.map((d) => join(d, profile)).join('\n  ')}`,
  );
}

function chromeCookieDb(
  profile: string,
): { dbPath: string; profilePath: string; userDataDir: string } {
  const { profilePath, userDataDir } = chromeProfileDir(profile);
  // Chrome ≥ 96 stores cookies under Network/Cookies; older Chrome keeps Cookies at the profile root.
  const candidates = [join(profilePath, 'Network', 'Cookies'), join(profilePath, 'Cookies')];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `Chrome cookie database not found for profile "${profile}". Looked in:\n  ${candidates.join('\n  ')}`,
    );
  }
  return { dbPath: found, profilePath, userDataDir };
}

/** True when a readable Chromium cookie database exists on this machine. */
export function chromiumCookieStoreAvailable(profile = 'Default'): boolean {
  try {
    chromeCookieDb(profile);
    return true;
  } catch {
    return false;
  }
}

function getMacChromeSafeStoragePassword(): string {
  const result = spawnSync(
    'security',
    ['find-generic-password', '-w', '-s', 'Chrome Safe Storage'],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(
      `Could not read "Chrome Safe Storage" from macOS Keychain. ` +
        `You'll need to click "Always Allow" in the Keychain prompt the first time.`,
    );
  }
  return result.stdout.trim();
}

/**
 * Unprotects a DPAPI blob (CurrentUser scope) using PowerShell. Node has no
 * DPAPI binding; PowerShell's ProtectedData class is present on every
 * supported Windows install. The blob travels base64-encoded over stdin so
 * no key material appears in process command lines.
 */
export function dpapiUnprotectBase64(base64Blob: string): Buffer {
  const script =
    'Add-Type -AssemblyName System.Security; ' +
    '$blob=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); ' +
    '[Convert]::ToBase64String(' +
    '[System.Security.Cryptography.ProtectedData]::Unprotect(' +
    '$blob, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser))';
  let out: string;
  try {
    out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { input: base64Blob, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
  } catch {
    throw new Error(
      'Could not run PowerShell to unlock the browser cookie master key (DPAPI).',
    );
  }
  const key = Buffer.from(out.trim(), 'base64');
  if (key.length === 0) {
    throw new Error('DPAPI returned an empty master key for this browser profile.');
  }
  return key;
}

/**
 * Reads the AES-256 cookie master key for a Chromium browser on Windows:
 * `Local State` → os_crypt.encrypted_key (base64) → strip "DPAPI" prefix →
 * DPAPI Unprotect (CurrentUser).
 */
export function getWindowsChromiumCookieKey(userDataDir: string): Buffer {
  const localStatePath = join(userDataDir, 'Local State');
  if (!existsSync(localStatePath)) {
    throw new Error(`Browser "Local State" file not found at ${localStatePath}.`);
  }
  let encryptedKeyB64: string;
  try {
    const state = JSON.parse(readFileSync(localStatePath, 'utf8'));
    encryptedKeyB64 = state?.os_crypt?.encrypted_key as string;
  } catch {
    throw new Error(`Could not parse browser "Local State" file at ${localStatePath}.`);
  }
  if (!encryptedKeyB64) {
    throw new Error(`No os_crypt.encrypted_key found in ${localStatePath}.`);
  }
  const raw = Buffer.from(encryptedKeyB64, 'base64');
  if (raw.subarray(0, 5).toString('ascii') !== 'DPAPI') {
    throw new Error('Unexpected browser master key format (missing DPAPI prefix).');
  }
  return dpapiUnprotectBase64(raw.subarray(5).toString('base64'));
}

export function deriveChromeCookieKey(password: string, iterations: number): Buffer {
  return pbkdf2Sync(password, 'saltysalt', iterations, 16, 'sha1');
}

function isLikelyCookieByte(b: number): boolean {
  // Printable ASCII range used by cookies (RFC 6265 cookie-octet)
  return b >= 0x20 && b <= 0x7e;
}

export function decryptChromeCookieValue(encrypted: Buffer, key: Buffer): string {
  if (encrypted.length === 0) return '';
  const prefix = encrypted.subarray(0, 3).toString('utf8');

  if (prefix !== 'v10' && prefix !== 'v11') {
    // Legacy unencrypted cookie — return raw bytes as utf8.
    return encrypted.toString('utf8');
  }

  if (key.length === 32) {
    // Windows Chromium (v10): AES-256-GCM with a 12-byte nonce after the
    // prefix. v11 is app-bound encrypted (Chrome 127+); its key can't be
    // derived from Local State, so we refuse rather than return garbage.
    if (prefix !== 'v10') {
      throw new Error(`Unsupported encrypted cookie format "${prefix}" for a 32-byte key.`);
    }
    const nonce = encrypted.subarray(3, 15);
    const ciphertext = encrypted.subarray(15);
    const gcm = createDecipheriv('aes-256-gcm', key, nonce);
    gcm.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
    const gcmPlain = Buffer.concat([gcm.update(ciphertext.subarray(0, ciphertext.length - 16)), gcm.final()]);
    return stripHostKeyHash(gcmPlain).toString('utf8');
  }

  const ciphertext = encrypted.subarray(3);
  const iv = Buffer.alloc(16, 0x20); // 16 space chars
  const decipher = createDecipheriv('aes-128-cbc', key, iv);
  const cbcPlain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return stripHostKeyHash(cbcPlain).toString('utf8');
}

function stripHostKeyHash(plaintext: Buffer): Buffer {
  // Chrome ≥ 130 (M130) prepends a 32-byte SHA-256 of the host_key to the cookie
  // plaintext before encrypting. Detect by scanning the leading 32 bytes for
  // non-printable density — a SHA-256 has ~24-25 non-printable bytes on average,
  // while a real cookie value is essentially all printable ASCII.
  if (plaintext.length > 32) {
    let nonPrintable = 0;
    for (let i = 0; i < 32; i++) {
      if (!isLikelyCookieByte(plaintext[i])) nonPrintable++;
    }
    if (nonPrintable >= 4) {
      plaintext = plaintext.subarray(32);
    }
  }
  return plaintext;
}

const COOKIE_QUERY = `SELECT name, hex(encrypted_value) AS enc, host_key
       FROM cookies
       WHERE host_key = 'linkedin.com' OR host_key LIKE '%.linkedin.com'
       ORDER BY rowid;`;

/** Query the copied cookie DB via node:sqlite (Node ≥ 22.13), no CLI needed. */
async function querySqliteNode(dbPath: string): Promise<string> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db.prepare(COOKIE_QUERY).all() as Array<{ name: string; enc: string; host_key: string }>;
    return rows.map((r) => `${r.name}\t${r.enc}\t${r.host_key}`).join('\n');
  } finally {
    db.close();
  }
}

async function querySqlite(dbPath: string): Promise<string> {
  try {
    return execFileSync('sqlite3', ['-separator', '\t', dbPath, COOKIE_QUERY], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err) {
    const isMissing =
      (err as NodeJS.ErrnoException).code === 'ENOENT' ||
      (err as Error).message?.includes('ENOENT');
    if (!isMissing) {
      throw new Error('sqlite3 query failed while reading the Chrome cookie database.');
    }
    // sqlite3 CLI not installed (common on Windows) — fall back to node:sqlite.
    try {
      return await querySqliteNode(dbPath);
    } catch {
      throw new Error(
        `The "sqlite3" command-line tool is not installed and the built-in node:sqlite ` +
          `driver failed. Install sqlite3 (e.g. "winget install Google.SQLite") or run on Node ≥ 22.13.`,
      );
    }
  }
}

export async function loadLinkedInCookiesFromChrome(
  profile = 'Default',
): Promise<ChromeCookieResult> {
  const { dbPath, profilePath, userDataDir } = chromeCookieDb(profile);

  // Chrome holds an exclusive lock while running. Copy the DB plus its WAL/SHM
  // sidecar files (Chrome runs in WAL mode — recent writes live in the -wal file).
  const tmpDir = mkdtempSync(join(tmpdir(), 'linkedin-cli-chrome-'));
  const tmpDb = join(tmpDir, 'Cookies');

  let rows: string;
  try {
    copyFileSync(dbPath, tmpDb);
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${dbPath}${suffix}`;
      if (existsSync(sidecar)) copyFileSync(sidecar, `${tmpDb}${suffix}`);
    }

    // Match linkedin.com itself and its subdomains only — a bare
    // LIKE '%linkedin.com' would also scoop up cookies from lookalike
    // hosts such as "evil-linkedin.com", and those values would end up
    // inside the cookie jar we send to LinkedIn.
    rows = await querySqlite(tmpDb);
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  let key: Buffer;
  if (process.platform === 'win32') {
    key = getWindowsChromiumCookieKey(userDataDir);
  } else if (process.platform === 'darwin') {
    key = deriveChromeCookieKey(getMacChromeSafeStoragePassword(), 1003);
  } else {
    // Linux default when no keyring is configured.
    key = deriveChromeCookieKey('peanuts', 1);
  }

  const cookies: Record<string, string> = {};
  for (const line of rows.split('\n')) {
    if (!line.trim()) continue;
    const [name, hexValue] = line.split('\t');
    if (!name || !hexValue) continue;
    try {
      const buf = Buffer.from(hexValue, 'hex');
      const value = decryptChromeCookieValue(buf, key);
      if (value) cookies[name] = value;
    } catch {
      // Skip cookies we can't decrypt (e.g. v20 app-bound on newer Chrome).
    }
  }

  const liAt = cookies['li_at'];
  const jsessionid = cookies['JSESSIONID'];
  if (!liAt) {
    throw new Error(
      `li_at cookie not found for profile "${profile}". Are you logged into LinkedIn in this Chrome profile?`,
    );
  }
  if (!jsessionid) {
    throw new Error(`JSESSIONID cookie not found for profile "${profile}".`);
  }

  const cookieHeader = Object.entries(cookies)
    .map(([n, v]) => `${n}=${v}`)
    .join('; ');

  return {
    liAt,
    jsessionid,
    cookieHeader,
    cookies,
    profilePath,
  };
}
