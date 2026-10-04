import { z } from 'zod';
import type { CommandDefinition } from '../../core/types.js';

export const feedViewCommand: CommandDefinition = {
  name: 'feed_view',
  group: 'feed',
  subcommand: 'view',
  description: 'View your LinkedIn feed (chronological)',
  examples: [
    'linkedin feed view',
    'linkedin feed view --limit 20',
  ],

  inputSchema: z.object({
    limit: z.coerce.number().min(1).max(100).default(10).describe('Number of feed items'),
    start: z.coerce.number().default(0).describe('Pagination offset'),
  }),

  cliMappings: {
    options: [
      { field: 'limit', flags: '-l, --limit <number>', description: 'Number of feed items' },
      { field: 'start', flags: '--start <number>', description: 'Pagination offset' },
    ],
  },

  handler: async (input, client) => {
    return client.get('/feed/updatesV2', {
      count: input.limit,
      start: input.start,
      q: 'chronFeed',
    });
  },
};

export const feedUserCommand: CommandDefinition = {
  name: 'feed_user',
  group: 'feed',
  subcommand: 'user',
  description: 'View feed/activity for a specific user',
  examples: ['linkedin feed user johndoe --limit 20'],

  inputSchema: z.object({
    profile_id: z.string().describe('Public profile ID or URN ID'),
    limit: z.coerce.number().min(1).max(100).default(10).describe('Number of items'),
    start: z.coerce.number().default(0).describe('Pagination offset'),
  }),

  cliMappings: {
    args: [{ field: 'profile_id', name: 'profile-id', required: true }],
    options: [
      { field: 'limit', flags: '-l, --limit <number>', description: 'Number of items' },
      { field: 'start', flags: '--start <number>', description: 'Pagination offset' },
    ],
  },

  handler: async (input, client) => {
    return client.get('/feed/updates', {
      profileId: input.profile_id,
      q: 'memberShareFeed',
      moduleKey: 'member-share',
      count: input.limit,
      start: input.start,
    });
  },
};

export const feedCompanyCommand: CommandDefinition = {
  name: 'feed_company',
  group: 'feed',
  subcommand: 'company',
  description: 'View feed/updates for a company page',
  examples: ['linkedin feed company google --limit 20'],

  inputSchema: z.object({
    company_name: z.string().describe('Company universal name (URL slug)'),
    limit: z.coerce.number().min(1).max(100).default(10).describe('Number of items'),
    start: z.coerce.number().default(0).describe('Pagination offset'),
  }),

  cliMappings: {
    args: [{ field: 'company_name', name: 'company-name', required: true }],
    options: [
      { field: 'limit', flags: '-l, --limit <number>', description: 'Number of items' },
      { field: 'start', flags: '--start <number>', description: 'Pagination offset' },
    ],
  },

  handler: async (input, client) => {
    return client.get('/feed/updates', {
      companyUniversalName: input.company_name,
      q: 'companyFeedByUniversalName',
      moduleKey: 'member-share',
      count: input.limit,
      start: input.start,
    });
  },
};

export const feedCommands = [
  feedViewCommand,
  feedUserCommand,
  feedCompanyCommand,
];
