import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allCommands, createLazyClient } from '../commands/index.js';
import type { CommandDefinition } from '../core/types.js';

// Resolve the server version from package.json so it never drifts again.
// Layout differs between src/ (../../package.json) and the tsup bundle
// (dist/index.js → ../package.json) — probe both.
function resolvePackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../../package.json', '../package.json']) {
    const candidate = join(here, rel);
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, 'utf-8')) as { version?: string };
        if (parsed.version) return parsed.version;
      } catch {
        /* try next candidate */
      }
    }
  }
  return '0.0.0';
}
const packageVersion = resolvePackageVersion();

/**
 * MCP tool name → command definition. Exported so tests can assert tool
 * registration without booting stdio transport.
 */
export const commandToTool: Map<string, CommandDefinition> = new Map(
  allCommands.map((cmd) => [cmd.name, cmd]),
);

export async function startMcpServer(): Promise<void> {
  // Auth is resolved lazily on the first network-touching tool call so the
  // fully-offline OSINT tools (osint_classify / osint_names / osint_matrix /
  // osint_stats / osint_scan) work without cookies.
  const client = createLazyClient({});

  const server = new McpServer({
    name: 'linkedin',
    version: packageVersion,
  });

  // Register every CommandDefinition as an MCP tool
  for (const cmdDef of allCommands) {
    const shape = cmdDef.inputSchema.shape;

    server.registerTool(
      cmdDef.name,
      {
        description: cmdDef.description,
        inputSchema: shape,
      },
      async (args: Record<string, unknown>) => {
        try {
          const result = await cmdDef.handler(args as any, client);
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (error: any) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error: error.message ?? String(error),
                  code: error.code ?? 'UNKNOWN_ERROR',
                }),
              },
            ],
            isError: true,
          };
        }
      },
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(`LinkedIn MCP server started. Tools registered: ${allCommands.length}`);
}
