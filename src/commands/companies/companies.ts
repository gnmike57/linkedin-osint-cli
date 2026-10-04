import { z } from 'zod';
import type { CommandDefinition } from '../../core/types.js';

export const companiesViewCommand: CommandDefinition = {
  name: 'companies_view',
  group: 'companies',
  subcommand: 'view',
  description: 'View a company profile by universal name (URL slug)',
  examples: ['linkedin companies view google'],

  inputSchema: z.object({
    company_name: z.string().describe('Company universal name (the URL slug)'),
  }),

  cliMappings: {
    args: [{ field: 'company_name', name: 'company-name', required: true }],
  },

  handler: async (input, client) => {
    return client.get('/organization/companies', {
      decorationId: 'com.linkedin.voyager.deco.organization.web.WebFullCompanyMain-12',
      q: 'universalName',
      universalName: input.company_name,
    });
  },
};

export const companiesFollowCommand: CommandDefinition = {
  name: 'companies_follow',
  group: 'companies',
  subcommand: 'follow',
  description: 'Follow a company',
  examples: ['linkedin companies follow urn:li:company:1035'],

  inputSchema: z.object({
    following_state_urn: z.string().describe('Following state URN'),
  }),

  cliMappings: {
    args: [{ field: 'following_state_urn', name: 'following-state-urn', required: true }],
  },

  handler: async (input, client) => {
    return client.post(
      `/feed/dash/followingStates/${encodeURIComponent(input.following_state_urn)}`,
      {
        patch: {
          $set: {
            following: true,
          },
        },
      },
    );
  },
};

export const companiesUnfollowCommand: CommandDefinition = {
  name: 'companies_unfollow',
  group: 'companies',
  subcommand: 'unfollow',
  description: 'Unfollow a company or entity',
  examples: ['linkedin companies unfollow urn:li:fs_followingInfo:12345'],

  inputSchema: z.object({
    entity_urn: z.string().describe('Entity URN to unfollow'),
  }),

  cliMappings: {
    args: [{ field: 'entity_urn', name: 'entity-urn', required: true }],
  },

  handler: async (input, client) => {
    return client.post('/feed/follows?action=unfollowByEntityUrn', {
      urn: input.entity_urn,
    });
  },
};

export const companiesCommands = [
  companiesViewCommand,
  companiesFollowCommand,
  companiesUnfollowCommand,
];
