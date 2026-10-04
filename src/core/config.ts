import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CONFIG_DIR = join(homedir(), '.linkedin-cli');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export interface LinkedInConfig {
  li_at: string;
  jsessionid: string;
  profile_name?: string;
  profile_urn?: string;
}

export async function loadConfig(): Promise<LinkedInConfig | null> {
  try {
    const content = await readFile(CONFIG_FILE, 'utf-8');
    return JSON.parse(content) as LinkedInConfig;
  } catch {
    return null;
  }
}

export async function saveConfig(config: LinkedInConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', {
    mode: 0o600,
  });
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
