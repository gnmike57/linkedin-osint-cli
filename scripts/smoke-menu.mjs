#!/usr/bin/env node
/*
 * End-to-end smoke test for the interactive console.
 *
 * Drives `linkedin menu` with a piped session (the built-in readline
 * fallback path, since @inquirer/prompts is optional) and asserts that:
 *   1. the process exits 0 with no unsettled top-level await,
 *   2. the palette renders and the search filter narrows to one command,
 *   3. guided prompts are collected and echoed as a scriptable command line,
 *   4. the selected command actually executes and prints JSON,
 *   5. the session ends with a goodbye.
 *
 * Usage: npm run smoke:menu   (requires `npm run build` first)
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'dist', 'index.js');

if (!existsSync(entry)) {
  console.error('dist/index.js not found — run `npm run build` first.');
  process.exit(1);
}

// Scenario 1 — search path: filter, choice, then the classify prompts
// (--title, --file, --use-ai, --out-dir), then filter + choice to exit.
const SEARCH_SESSION = ['osint classify', '1', 'Senior Cyber Security Manager', '', 'n', '', 'exit', '1'];

// Scenario 2 — browse path: blank filter → Browse by category → OSINT toolkit
// (11) → classify (5) → prompts → EOF (which must unwind cleanly).
const BROWSE_SESSION = ['', '1', '11', '5', 'Senior Cyber Security Manager', '', 'n', ''];

function runScenario(lines) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, 'menu'], { stdio: ['pipe', 'pipe', 'pipe'] });
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

const search = await runScenario(SEARCH_SESSION);
results.push([
  'search path',
  search,
  [
    ['exit code 0', search.code === 0],
    ['no unsettled top-level await', !/unsettled top-level await/i.test(search.stderr)],
    ['banner rendered', search.stdout.includes('interactive console')],
    ['palette filtered to osint classify', /OSINT toolkit › classify/.test(search.stdout)],
    ['guided prompts collected', search.stdout.includes('--title Single title to classify')],
    ['scriptable command echoed', search.stdout.includes('linkedin osint classify --title')],
    ['command executed (JSON output)', search.stdout.includes('"division":"Cyber Security"')],
    ['clean goodbye', search.stdout.includes('goodbye')],
  ],
]);

const browse = await runScenario(BROWSE_SESSION);
results.push([
  'browse path',
  browse,
  [
    ['exit code 0', browse.code === 0],
    ['no unsettled top-level await', !/unsettled top-level await/i.test(browse.stderr)],
    ['palette shows browse entry', browse.stdout.includes('Browse by category')],
    ['category list rendered', browse.stdout.includes('Pick a category')],
    ['OSINT category listed', browse.stdout.includes('OSINT toolkit (13)')],
    ['group menu has a Back entry', browse.stdout.includes('Back')],
    ['command executed (JSON output)', browse.stdout.includes('"division":"Cyber Security"')],
    ['EOF unwinds cleanly', browse.stdout.includes('goodbye')],
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

if (failed > 0) {
  for (const [name, outcome] of results) {
    console.error(`\n--- ${name} stdout ---\n${outcome.stdout}\n--- ${name} stderr ---\n${outcome.stderr}`);
  }
  process.exit(1);
}
console.log('\ninteractive console smoke test: OK');

