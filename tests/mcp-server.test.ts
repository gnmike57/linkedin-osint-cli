import { describe, expect, it } from 'vitest';

describe('mcp server module', () => {
  it('imports without a LinkedIn session (offline osint tools stay usable)', async () => {
    const mod = await import('../src/mcp/server.js');
    expect(mod.commandToTool).toBeInstanceOf(Map);
    expect(mod.commandToTool.size).toBeGreaterThan(10);
  });
});
