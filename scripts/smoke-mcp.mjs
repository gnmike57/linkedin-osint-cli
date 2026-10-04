#!/usr/bin/env node
/*
 * End-to-end smoke test for the MCP server.
 *
 * Boots `linkedin mcp` over stdio, performs the initialize handshake, calls
 * tools/list, and asserts the OSINT + platform tools are all exposed.
 *
 * Usage: npm run smoke:mcp   (requires `npm run build` first)
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

const EXPECTED_MIN_TOOLS = 56;
const REQUIRED_TOOLS = ['profile_me', 'search_people', 'osint_classify', 'osint_funnel', 'osint_email-lookup'];

const child = spawn(process.execPath, [entry, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });

let buffer = '';
let stderr = '';
child.stdout.on('data', (d) => {
  buffer += d.toString();
});
child.stderr.on('data', (d) => {
  stderr += d.toString();
});

const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '1' },
  },
});
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

const finish = (code) => {
  child.kill();
  process.exit(code);
};

const timeout = setTimeout(() => {
  console.error('FAIL: MCP server did not answer tools/list within 15s.');
  console.error(buffer.slice(0, 1000));
  finish(1);
}, 15_000);

child.stdout.on('data', () => {
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== 2 || !msg.result?.tools) continue;

    clearTimeout(timeout);
    const names = msg.result.tools.map((t) => t.name);
    const checks = [
      [`tool count >= ${EXPECTED_MIN_TOOLS}`, names.length >= EXPECTED_MIN_TOOLS],
      ['no duplicate tool names', new Set(names).size === names.length],
      ...REQUIRED_TOOLS.map((n) => [`exposes ${n}`, names.includes(n)]),
      ['every tool has a schema', msg.result.tools.every((t) => t.inputSchema?.type === 'object')],
      ['server reported tool count on stderr', /Tools registered: \d+/.test(stderr)],
    ];

    let failed = 0;
    for (const [label, ok] of checks) {
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
      if (!ok) failed++;
    }
    console.log(`\n${names.length} tools registered.`);
    if (failed > 0) {
      console.error(`${failed} check(s) failed.`);
      finish(1);
    }
    console.log('MCP smoke test: OK');
    finish(0);
  }
});
