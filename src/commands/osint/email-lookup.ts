/**
 * `linkedin osint email-lookup` — deanonymize emails to LinkedIn profiles via
 * Outlook/Delve (port of linkedin-osint-master/outlook_http_client.py).
 * Requires a Microsoft Bearer token (LINKEDIN_MS_TOKEN env or --token-file).
 */

import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import type { CommandDefinition } from '../../core/types.js';
import {
  lookupDelveEmails,
  normalizeEmails,
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
} from '../../osint/delve.js';
import { fileTimestamp, writeOutputFile } from './util.js';

const inputSchema = z.object({
  file: z.string().optional().describe('File with one email per line (or "name,email" CSV lines)'),
  email: z.string().optional().describe('Single email to look up'),
  token_file: z.string().optional().describe('File containing the Microsoft Bearer token'),
  skip_email: z.string().optional().describe('Resume from this email (inclusive)'),
  max_failures: z.coerce.number().min(1).default(DEFAULT_MAX_CONSECUTIVE_FAILURES).describe('Abort after N consecutive misses'),
  out_dir: z.string().default('output').describe('Output directory'),
});

export const osintEmailLookupCommand: CommandDefinition = {
  name: 'osint_email-lookup',
  group: 'osint',
  subcommand: 'email-lookup',
  description:
    'Find LinkedIn profiles for email addresses via Outlook/Delve (needs a Microsoft session token; batch with circuit breaker)',
  examples: [
    'linkedin osint email-lookup --file emails.txt',
    'linkedin osint email-lookup --email person@example.com --token-file ms-token.txt',
    'linkedin osint email-lookup --file emails.txt --skip-email person@example.com',
  ],

  inputSchema,

  cliMappings: {
    options: [
      { field: 'file', flags: '-f, --file <path>', description: 'Email list file (one per line or name,email)' },
      { field: 'email', flags: '-e, --email <email>', description: 'Single email to look up' },
      { field: 'token_file', flags: '--token-file <path>', description: 'File containing the Microsoft Bearer token' },
      { field: 'skip_email', flags: '--skip-email <email>', description: 'Resume from this email (inclusive)' },
      { field: 'max_failures', flags: '--max-failures <n>', description: 'Abort after N consecutive misses (default 10)' },
      { field: 'out_dir', flags: '-o, --out-dir <dir>', description: 'Output directory (default: output)' },
    ],
  },

  handler: async (input) => {
    const inputAny = input as any as {
      file?: string;
      email?: string;
      token_file?: string;
      skip_email?: string;
      max_failures: number;
      out_dir: string;
    };

    // Resolve the Microsoft token: env > token file
    let token = (process.env.LINKEDIN_MS_TOKEN ?? '').trim();
    if (!token && inputAny.token_file) {
      token = (await readFile(inputAny.token_file, 'utf-8')).trim();
    }
    if (!token) {
      return {
        error:
          'No Microsoft token. Set LINKEDIN_MS_TOKEN or pass --token-file. ' +
          'See legacy/python/linkedin-osint-master/README.md for how to extract it.',
        code: 'MISSING_MS_TOKEN',
      };
    }

    // Resolve the email list
    let emails: string[] = [];
    if (inputAny.file) {
      const content = await readFile(inputAny.file, 'utf-8');
      emails = normalizeEmails(content.split(/\r?\n/));
    } else if (inputAny.email) {
      emails = [inputAny.email];
    } else {
      return { error: 'Provide --file or --email.', code: 'VALIDATION_ERROR' };
    }

    const batch = await lookupDelveEmails(emails, token, {
      maxConsecutiveFailures: inputAny.max_failures,
      skipEmail: inputAny.skip_email,
    });

    const found = batch.results.filter((r) => r.found);
    const file = await writeOutputFile(
      inputAny.out_dir,
      `email_lookup_${fileTimestamp()}.json`,
      JSON.stringify(
        {
          generated_at: new Date().toISOString(),
          queried: batch.results.length,
          found: found.length,
          aborted: batch.aborted,
          consecutive_failures: batch.consecutiveFailures,
          results: batch.results,
        },
        null,
        2,
      ) + '\n',
    );

    return {
      queried: batch.results.length,
      found: found.length,
      aborted: batch.aborted,
      file,
      results: batch.results,
    };
  },
};
