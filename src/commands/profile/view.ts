import { z } from 'zod';
import type { CommandDefinition } from '../../core/types.js';

export const profileViewCommand: CommandDefinition = {
  name: 'profile_view',
  group: 'profile',
  subcommand: 'view',
  description: 'View a LinkedIn profile by public ID or URN ID',
  examples: [
    'linkedin profile view johndoe',
    'linkedin profile view johndoe --pretty',
  ],

  inputSchema: z.object({
    public_id: z.string().describe('Public profile identifier (the URL slug)'),
  }),

  cliMappings: {
    args: [{ field: 'public_id', name: 'public-id', required: true }],
  },

  handler: async (input, client) => {
    return client.get(`/identity/profiles/${encodeURIComponent(input.public_id)}/profileView`);
  },
};

export const profileMeCommand: CommandDefinition = {
  name: 'profile_me',
  group: 'profile',
  subcommand: 'me',
  description: 'View your own LinkedIn profile',
  examples: ['linkedin profile me'],

  inputSchema: z.object({}),

  cliMappings: {},

  handler: async (_input, client) => {
    return client.get('/me');
  },
};

export const profileContactInfoCommand: CommandDefinition = {
  name: 'profile_contact-info',
  group: 'profile',
  subcommand: 'contact-info',
  description: 'Get contact info (email, phone, websites) for a profile',
  examples: ['linkedin profile contact-info johndoe'],

  inputSchema: z.object({
    public_id: z.string().describe('Public profile identifier'),
  }),

  cliMappings: {
    args: [{ field: 'public_id', name: 'public-id', required: true }],
  },

  handler: async (input, client) => {
    return client.get(
      `/identity/profiles/${encodeURIComponent(input.public_id)}/profileContactInfo`,
    );
  },
};

export const profileSkillsCommand: CommandDefinition = {
  name: 'profile_skills',
  group: 'profile',
  subcommand: 'skills',
  description: 'List skills for a profile',
  examples: ['linkedin profile skills johndoe'],

  inputSchema: z.object({
    public_id: z.string().describe('Public profile identifier'),
    limit: z.coerce.number().min(1).max(100).default(100).describe('Number of skills'),
  }),

  cliMappings: {
    args: [{ field: 'public_id', name: 'public-id', required: true }],
    options: [
      { field: 'limit', flags: '-l, --limit <number>', description: 'Number of skills to return' },
    ],
  },

  handler: async (input, client) => {
    return client.get(`/identity/profiles/${encodeURIComponent(input.public_id)}/skills`, {
      count: input.limit,
      start: 0,
    });
  },
};

export const profileNetworkCommand: CommandDefinition = {
  name: 'profile_network',
  group: 'profile',
  subcommand: 'network',
  description: 'Get network info (connections, followers, distance) for a profile',
  examples: ['linkedin profile network johndoe'],

  inputSchema: z.object({
    public_id: z.string().describe('Public profile identifier'),
  }),

  cliMappings: {
    args: [{ field: 'public_id', name: 'public-id', required: true }],
  },

  handler: async (input, client) => {
    return client.get(`/identity/profiles/${encodeURIComponent(input.public_id)}/networkinfo`);
  },
};

export const profileBadgesCommand: CommandDefinition = {
  name: 'profile_badges',
  group: 'profile',
  subcommand: 'badges',
  description: 'Get member badges (premium, influencer, job seeker) for a profile',
  examples: ['linkedin profile badges johndoe'],

  inputSchema: z.object({
    public_id: z.string().describe('Public profile identifier'),
  }),

  cliMappings: {
    args: [{ field: 'public_id', name: 'public-id', required: true }],
  },

  handler: async (input, client) => {
    return client.get(`/identity/profiles/${encodeURIComponent(input.public_id)}/memberBadges`);
  },
};

export const profilePrivacyCommand: CommandDefinition = {
  name: 'profile_privacy',
  group: 'profile',
  subcommand: 'privacy',
  description: 'Get privacy settings for a profile',
  examples: ['linkedin profile privacy johndoe'],

  inputSchema: z.object({
    public_id: z.string().describe('Public profile identifier'),
  }),

  cliMappings: {
    args: [{ field: 'public_id', name: 'public-id', required: true }],
  },

  handler: async (input, client) => {
    return client.get(`/identity/profiles/${encodeURIComponent(input.public_id)}/privacySettings`);
  },
};

export const profilePostsCommand: CommandDefinition = {
  name: 'profile_posts',
  group: 'profile',
  subcommand: 'posts',
  description: 'List recent posts from a profile',
  examples: [
    'linkedin profile posts johndoe',
    'linkedin profile posts johndoe --limit 50',
  ],

  inputSchema: z.object({
    urn_id: z.string().describe('Profile URN ID (numeric)'),
    limit: z.coerce.number().min(1).max(100).default(10).describe('Number of posts'),
    start: z.coerce.number().default(0).describe('Offset for pagination'),
  }),

  cliMappings: {
    args: [{ field: 'urn_id', name: 'urn-id', required: true }],
    options: [
      { field: 'limit', flags: '-l, --limit <number>', description: 'Number of posts' },
      { field: 'start', flags: '--start <number>', description: 'Pagination offset' },
    ],
  },

  handler: async (input, client) => {
    return client.get('/identity/profileUpdatesV2', {
      count: input.limit,
      start: input.start,
      q: 'memberShareFeed',
      moduleKey: 'member-shares:phone',
      includeLongTermHistory: true,
      profileUrn: `urn:li:fsd_profile:${input.urn_id}`,
    });
  },
};

export const profileDisconnectCommand: CommandDefinition = {
  name: 'profile_disconnect',
  group: 'profile',
  subcommand: 'disconnect',
  description: 'Remove a connection (unfriend) by public ID',
  examples: ['linkedin profile disconnect johndoe'],

  inputSchema: z.object({
    public_id: z.string().describe('Public profile identifier'),
  }),

  cliMappings: {
    args: [{ field: 'public_id', name: 'public-id', required: true }],
  },

  handler: async (input, client) => {
    return client.post(
      `/identity/profiles/${encodeURIComponent(input.public_id)}/profileActions?action=disconnect`,
    );
  },
};

export const profileCommands = [
  profileViewCommand,
  profileMeCommand,
  profileContactInfoCommand,
  profileSkillsCommand,
  profileNetworkCommand,
  profileBadgesCommand,
  profilePrivacyCommand,
  profilePostsCommand,
  profileDisconnectCommand,
];
