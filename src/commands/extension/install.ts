import { z } from 'zod';
import type { CommandDefinition } from '../../core/types.js';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getConfigDir } from '../../core/config.js';

const inputSchema = z.object({
  browser: z
    .enum(['chrome', 'edge'])
    .default('chrome')
    .describe('Browser the "Load unpacked" instructions target'),
  out_dir: z
    .string()
    .optional()
    .describe('Destination directory (default: ~/.linkedin-cli/browser-extension)'),
});

/**
 * Locate the bundled extension source (`assets/browser-extension`). Probes the
 * module-relative layouts first — `src/commands/extension/` (repo runs via
 * tsx) and the single-file dist bundle (npm installs) — then the current
 * working directory, so `linkedin extension install` works from any cwd.
 * Exported for unit tests.
 */
export function resolveExtensionSource(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', '..', '..', 'assets', 'browser-extension'), // src/commands/extension → repo root
    join(here, '..', 'assets', 'browser-extension'), // dist bundle → package root
    join(process.cwd(), 'assets', 'browser-extension'), // run from a checkout root
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'manifest.json'))) return dir;
  }
  return null;
}

export const extensionInstallCommand: CommandDefinition = {
  name: 'extension_install',
  group: 'extension',
  subcommand: 'install',
  description:
    'Copy the bundled browser extension to a stable folder and print the exact "Load unpacked" steps (browsers require unpacked extensions to be loaded manually)',

  examples: [
    'linkedin extension install',
    'linkedin extension install --browser edge',
    'linkedin extension install --out-dir ~/linkedin-ext',
  ],

  inputSchema,

  cliMappings: {
    options: [
      {
        field: 'browser',
        flags: '-b, --browser <chrome|edge>',
        description: 'Browser the instructions target (default: chrome)',
      },
      {
        field: 'out_dir',
        flags: '--out-dir <dir>',
        description: 'Destination directory (default: ~/.linkedin-cli/browser-extension)',
      },
    ],
  },

  handler: async (input) => {
    const { browser, out_dir } = input as { browser?: 'chrome' | 'edge'; out_dir?: string };
    const target = browser ?? 'chrome';

    const source = resolveExtensionSource();
    if (!source) {
      return {
        error:
          'Extension source not found (expected assets/browser-extension next to the installed CLI). ' +
          'Reinstall the package or run from a repo checkout.',
        code: 'NOT_FOUND',
      };
    }

    // Copy to a stable folder outside the repo/package cache: `npx` installs
    // are ephemeral and "Load unpacked" wants a path that keeps existing.
    // Chrome-family browsers cannot load an unpacked extension
    // programmatically, so this never touches the browser's own user-data
    // directory — it just stages the files and prints the exact steps.
    const destination = out_dir ?? join(getConfigDir(), 'browser-extension');

    mkdirSync(destination, { recursive: true });
    const files = readdirSync(source).filter((f) => !f.startsWith('.'));
    const copied: string[] = [];
    for (const file of files) {
      copyFileSync(join(source, file), join(destination, file));
      copied.push(file);
    }

    const extensionsPage = target === 'chrome' ? 'chrome://extensions' : 'edge://extensions';

    return {
      message: `Extension copied to ${destination}. Browsers require unpacked extensions to be loaded manually:`,
      steps: [
        `1. Open ${extensionsPage}`,
        '2. Enable "Developer mode" (top right)',
        '3. Click "Load unpacked"',
        `4. Select this folder: ${destination}`,
        '5. Pin the extension to the toolbar (it lists as "LinkedIn OSINT CLI Session Bridge")',
        '6. Click it and press "Send session to CLI" — or leave it: it auto-sends every ~60s',
        '',
        'Keep the bridge up (recommended — accepts a session any time):',
        '  linkedin extension listen',
        'Capture once and exit: linkedin login --extension',
        'Bridge state:          linkedin extension status',
        'Proxy all API calls through the browser (best fingerprint):',
        '  LINKEDIN_HTTP=extension linkedin profile me --pretty',
      ],
      source,
      destination,
      files_copied: copied,
      file_url: pathToFileURL(destination).toString(),
    };
  },
};