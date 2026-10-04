import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { allCommands } from '../commands/index.js';
import { resolveAuth } from '../core/auth.js';
import { createClient } from '../core/client.js';

export async function startMcpServer(): Promise<void> {
  const auth = await resolveAuth();
  const client = createClient(auth);

  const server = new McpServer({
    name: 'linkedin',
    version: '0.1.0',
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
