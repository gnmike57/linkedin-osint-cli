import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Regression gate for the "partial object handed to a whole-file writer" bug
 * family.
 *
 * `saveConfig` REPLACES `config.json`, so a caller that builds a fresh object
 * loses every field it does not mention. That is how `linkedin login` silently
 * dropped `profile_name`/`profile_urn`/`query_id`, and how the 60-second
 * extension bridge dropped a learned `query_id`. `saveSession` implements the
 * correct field semantics (session-coupled fields replaced together, sticky
 * metadata preserved) and must be the only writer used by command code.
 *
 * If this test fails, do NOT add an exemption — switch the new call site to
 * `saveSession`.
 */
describe('config write policy', () => {
  /** Strip comments so prose about saveConfig cannot trip the scan. */
  function stripComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '') // block comments (incl. JSDoc)
      .replace(/^\s*\/\/.*$/gm, ''); // whole-line comments
  }

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...sourceFiles(full));
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  it('no module outside core/config.ts replaces the config file wholesale', () => {
    const offenders = sourceFiles('src')
      .filter((file) => !file.endsWith(`config.ts`))
      .filter((file) => /\bsaveConfig\s*\(/.test(stripComments(readFileSync(file, 'utf-8'))))
      .map((file) => relative('src', file).replace(/\\/g, '/'));

    expect(offenders).toEqual([]);
  });

  it('routes session writes through saveSession', () => {
    for (const file of [
      'src/commands/auth/login.ts',
      'src/core/auth.ts',
      'src/commands/extension/listen.ts',
    ]) {
      const source = stripComments(readFileSync(file, 'utf-8'));
      expect(source, `${file} should write sessions via saveSession`).toMatch(/\bsaveSession\s*\(/);
      expect(source, `${file} must not call saveConfig`).not.toMatch(/\bsaveConfig\s*\(/);
    }
  });
});
