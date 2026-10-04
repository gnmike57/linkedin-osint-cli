import { z } from 'zod';
import type { CommandDefinition } from '../../core/types.js';

export const analyticsProfileViewsCommand: CommandDefinition = {
  name: 'analytics_profile-views',
  group: 'analytics',
  subcommand: 'profile-views',
  description: 'Get "who viewed my profile" summary and count',
  examples: ['linkedin analytics profile-views'],

  inputSchema: z.object({}),

  cliMappings: {},

  handler: async (_input, client) => {
    return client.get('/identity/wvmpCards');
  },
};

export const analyticsCommands = [
  analyticsProfileViewsCommand,
];
