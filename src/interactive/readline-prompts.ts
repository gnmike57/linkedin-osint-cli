/*
 * Built-in fallback prompts (zero dependencies, node:readline).
 *
 * Used when @inquirer/prompts cannot be imported — restricted registries,
 * broken installs, minimal environments. Same interface as the subset of
 * @inquirer/prompts the launcher uses, so the console always launches.
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { c, DOT } from './colors.js';

export interface FallbackChoice<T> {
  name: string;
  value: T;
  description?: string;
}

export interface FallbackPrompts {
  input(opts: { message: string; default?: string }): Promise<string>;
  confirm(opts: { message: string; default?: boolean }): Promise<boolean>;
  select<T>(opts: {
    message: string;
    choices: Array<FallbackChoice<T>>;
    pageSize?: number;
  }): Promise<T>;
  search<T>(opts: {
    message: string;
    source: (term: string | undefined) => Promise<Array<FallbackChoice<T>>>;
    pageSize?: number;
  }): Promise<T>;
}

/** Parse a 1-based numeric selection. Returns null when out of range. */
export function parseSelection(answer: string, count: number): number | null {
  const trimmed = answer.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (n < 1 || n > count) return null;
  return n - 1;
}

export function exitPromptError(): Error {
  const err = new Error('cancelled');
  err.name = 'ExitPromptError';
  return err;
}

export async function createFallbackPrompts(options: { input?: NodeJS.ReadableStream } = {}): Promise<FallbackPrompts> {
  const input = options.input ?? stdin;
  const rl = createInterface({ input, output: stdout, terminal: Boolean(stdin.isTTY) });

  /*
   * Line queue: readline emits every buffered line as soon as a chunk
   * arrives. With piped/file input the whole payload lands in one burst, so
   * a naive rl.question() drops every line that arrives before the next
   * question is asked. Queue lines and hand them out in order instead.
   */
  const pendingLines: string[] = [];
  const waiters: Array<(line: string | null) => void> = [];
  let ended = false;

  rl.on('line', (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else pendingLines.push(line);
  });
  rl.on('close', () => {
    ended = true;
    while (waiters.length > 0) waiters.shift()!(null);
  });

  const nextLine = async (): Promise<string | null> => {
    if (pendingLines.length > 0) return pendingLines.shift()!;
    if (ended) return null;
    return await new Promise<string | null>((resolve) => waiters.push(resolve));
  };

  /** Ask one question; never hangs (EOF → ExitPromptError). */
  const ask = async (message: string): Promise<string> => {
    stdout.write(`${message} `);
    const line = await nextLine();
    if (line === null) {
      rl.close();
      throw exitPromptError();
    }
    // Non-TTY input isn't echoed by the terminal — echo for readability.
    if (!(input as { isTTY?: boolean }).isTTY) stdout.write(`${line}\n`);
    return line;
  };

  const selectFrom = async <T>(message: string, choices: Array<FallbackChoice<T>>): Promise<T> => {
    if (choices.length === 0) throw exitPromptError();
    console.log(`\n${c.bold(message)}`);
    choices.forEach((choice, i) => {
      console.log(`  ${c.cyan(String(i + 1).padStart(2))}) ${choice.name}`);
      if (choice.description) console.log(`      ${c.dim(choice.description)}`);
    });
    for (let attempts = 0; attempts < 5; attempts++) {
      const answer = await ask(`\n${c.cyan('select 1-' + choices.length)} ${DOT}`);
      const idx = parseSelection(answer, choices.length);
      if (idx !== null) return choices[idx].value;
      console.log(c.red(`  invalid selection: ${answer.trim() || '(empty)'}`));
    }
    rl.close();
    throw exitPromptError();
  };

  return {
    async input({ message, default: def }) {
      const suffix = def ? c.dim(` [${def}]`) : '';
      const answer = await ask(`${message}${suffix}`);
      return answer.trim() === '' && def !== undefined ? def : answer.trim();
    },
    async confirm({ message, default: def }) {
      const hint = def ? 'Y/n' : 'y/N';
      const answer = (await ask(`${message} ${c.dim(`(${hint})`)}`)).trim().toLowerCase();
      if (answer === '') return def ?? false;
      return answer === 'y' || answer === 'yes';
    },
    select: (opts) => selectFrom(opts.message, opts.choices),
    async search({ message, source }) {
      const term = await ask(`${message} ${c.dim('(filter, blank = all)')}`);
      const choices = await source(term.trim() === '' ? undefined : term.trim());
      return selectFrom('matches:', choices);
    },
  };
}
