import type { CommandDefinition, LinkedInClient } from './types.js';

export async function executeCommand(
  cmdDef: CommandDefinition,
  input: Record<string, any>,
  client: LinkedInClient,
): Promise<unknown> {
  if (!cmdDef.endpoint) {
    throw new Error(`Command ${cmdDef.name} has no endpoint — must use a custom handler`);
  }

  let path = cmdDef.endpoint.path;
  const query: Record<string, any> = {};
  const body: Record<string, any> = {};

  const mappings = cmdDef.fieldMappings ?? {};

  for (const [field, location] of Object.entries(mappings)) {
    const value = input[field];
    if (value === undefined) continue;

    switch (location) {
      case 'path':
        path = path.replace(`{${field}}`, encodeURIComponent(String(value)));
        break;
      case 'query':
        query[field] = value;
        break;
      case 'body':
        body[field] = value;
        break;
    }
  }

  return client.request({
    method: cmdDef.endpoint.method,
    path,
    query: Object.keys(query).length > 0 ? query : undefined,
    body: Object.keys(body).length > 0 ? body : undefined,
  });
}
