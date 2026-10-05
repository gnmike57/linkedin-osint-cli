#!/usr/bin/env node
/*
 * End-to-end smoke test for the interactive shell.
 *
 * Drives `linkedin shell` with piped sessions (LINKEDIN_SHELL=plain — the
 * non-TTY grammar) over the built dist/ artifacts and asserts that:
 *   1. exact commands execute after a confirm-first staging Enter,
 *   2. plain-English phrases resolve to the same command,
 *   3. staged field overrides land in the executed input,
 *   4. ambiguous phrases list numbered candidates and a pick works,
 *   5. EOF exits cleanly with a goodbye.
 *
 * Usage: npm run smoke:shell   (requires `npm run build` first)
 */

import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'dist', 'index.js');
const tmpDir = join(root, 'smoke-shell-tmp');

if (!existsSync(entry)) {
  console.error('dist/index.js not found — run `npm run build` first.');
  process.exit(1);
}

const TITLE = 'Senior Cyber Security Manager';

// Exact command → staging Enter runs it; then exit.
const EXACT_SESSION = [`osint classify --title "${TITLE}"`, '', 'exit'];

// NLP phrase → same command, same JSON.
const NL_SESSION = [`classify the title "${TITLE}"`, '', 'exit'];

// Staged override: out-dir lands in the executed input.
const STAGE_SESSION = [`osint classify --title "${TITLE}"`, 'out-dir ./smoke-shell-tmp', '', 'exit'];

// Ambiguous phrase → numbered candidates → pick → staging → cancel.
const AMBIG_SESSION = ['text', '1', 'q', 'exit'];

// EOF right after help exits cleanly.
const EOF_SESSION = ['help'];

function runSession(lines) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, 'shell'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Force the non-TTY grammar so scripted sessions are deterministic.
      env: { ...process.env, LINKEDIN_SHELL: 'plain' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.stdin.write(lines.join('\n') + '\n');
    child.stdin.end();

    const timeout = setTimeout(() => {
      child.kill();
      resolve({ code: null, stdout, stderr, hung: true });
    }, 20_000);

    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr, hung: false });
    });
  });
}

function report(title, checks) {
  console.log(`\n--- ${title} ---`);
  let failed = 0;
  for (const [label, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
    if (!ok) failed++;
  }
  return failed;
}

const results = [];
const baseChecks = (outcome, interpretCommand) => [
  ['exit code 0', outcome.code === 0],
  ['no unsettled top-level await', !/unsettled top-level await/i.test(outcome.stderr)],
  ['shell header rendered', outcome.stdout.includes('interactive shell')],
  [`interpreted as ${interpretCommand}`, outcome.stdout.includes(`linkedin ${interpretCommand}`)],
  ['scriptable line printed', outcome.stdout.includes('≡ scriptable:')],
  ['command executed (JSON output)', outcome.stdout.includes('"division":"Cyber Security"')],
  ['timing line shown', outcome.stdout.includes('done in')],
  ['clean goodbye', outcome.stdout.includes('goodbye')],
];

const exact = await runSession(EXACT_SESSION);
results.push(['exact command path', exact, baseChecks(exact, 'osint classify --title')]);

const nlp = await runSession(NL_SESSION);
results.push(['plain-English path', nlp, baseChecks(nlp, 'osint classify --title')]);

const stage = await runSession(STAGE_SESSION);
results.push([
  'staged override path',
  stage,
  [
    ...baseChecks(stage, 'osint classify --title'),
    ['staged out-dir override landed', stage.stdout.includes('--out-dir ./smoke-shell-tmp')],
  ],
]);

const ambiguous = await runSession(AMBIG_SESSION);
results.push([
  'ambiguity path',
  ambiguous,
  [
    ['exit code 0', ambiguous.code === 0],
    ['no unsettled top-level await', !/unsettled top-level await/i.test(ambiguous.stderr)],
    ['candidates listed', ambiguous.stdout.includes('could mean several things')],
    ['numbered pick offered', ambiguous.stdout.includes('select 1-')],
    ['pick resolves to send-new', ambiguous.stdout.includes('linkedin messaging send-new')],
    ['unfilled required shown', ambiguous.stdout.includes('unfilled required: --recipients')],
    ['q cancels back to prompt', ambiguous.stdout.includes('goodbye')],
  ],
]);

const eofSession = await runSession(EOF_SESSION);
results.push([
  'EOF exits cleanly',
  eofSession,
  [
    ['exit code 0', eofSession.code === 0],
    ['no unsettled top-level await', !/unsettled top-level await/i.test(eofSession.stderr)],
    ['help rendered', eofSession.stdout.includes('builtins:')],
    ['clean goodbye', eofSession.stdout.includes('goodbye')],
  ],
]);

let failed = 0;
for (const [name, outcome, checks] of results) {
  failed += report(name, checks);
  if (outcome.hung) {
    console.error('FAIL: scenario hung (no exit within 20s).');
    failed++;
  }
}

rmSync(tmpDir, { recursive: true, force: true });

if (failed > 0) {
  for (const [name, outcome] of results) {
    console.error(`\n--- ${name} stdout ---\n${outcome.stdout}\n--- ${name} stderr ---\n${outcome.stderr}`);
  }
  process.exit(1);
}
console.log('\ninteractive shell smoke test: OK');
