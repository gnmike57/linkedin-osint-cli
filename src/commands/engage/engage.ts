import { z } from 'zod';
import type { CommandDefinition } from '../../core/types.js';

const reactionTypes = z.enum(['LIKE', 'PRAISE', 'APPRECIATION', 'EMPATHY', 'INTEREST', 'ENTERTAINMENT']);

export const engageReactCommand: CommandDefinition = {
  name: 'engage_react',
  group: 'engage',
  subcommand: 'react',
  description: 'React to a post (like, celebrate, support, love, insightful, funny)',
  examples: [
    'linkedin engage react 7123456789 --type LIKE',
    'linkedin engage react 7123456789 --type PRAISE',
    'linkedin engage react 7123456789 --type EMPATHY',
  ],

  inputSchema: z.object({
    post_urn: z.string().describe('Post activity URN ID (numeric part)'),
    type: reactionTypes.default('LIKE').describe('Reaction type: LIKE, PRAISE, APPRECIATION, EMPATHY, INTEREST, ENTERTAINMENT'),
  }),

  cliMappings: {
    args: [{ field: 'post_urn', name: 'post-urn', required: true }],
    options: [
      { field: 'type', flags: '-t, --type <type>', description: 'Reaction type (default: LIKE)' },
    ],
  },

  handler: async (input, client) => {
    return client.post(
      `/voyagerSocialDashReactions?threadUrn=urn:li:activity:${input.post_urn}`,
      { reactionType: input.type },
    );
  },
};

export const engageReactionsCommand: CommandDefinition = {
  name: 'engage_reactions',
  group: 'engage',
  subcommand: 'reactions',
  description: 'Get reactions on a post',
  examples: ['linkedin engage reactions 7123456789'],

  inputSchema: z.object({
    post_urn: z.string().describe('Post activity URN ID (numeric part)'),
    limit: z.coerce.number().min(1).max(100).default(10).describe('Number of reactions'),
    start: z.coerce.number().default(0).describe('Pagination offset'),
  }),

  cliMappings: {
    args: [{ field: 'post_urn', name: 'post-urn', required: true }],
    options: [
      { field: 'limit', flags: '-l, --limit <number>', description: 'Number of reactions' },
      { field: 'start', flags: '--start <number>', description: 'Pagination offset' },
    ],
  },

  handler: async (input, client) => {
    return client.get('/feed/reactions', {
      count: input.limit,
      q: 'reactionType',
      sortOrder: 'REV_CHRON',
      start: input.start,
      threadUrn: `urn:li:activity:${input.post_urn}`,
    });
  },
};

export const engageCommentCommand: CommandDefinition = {
  name: 'engage_comment',
  group: 'engage',
  subcommand: 'comment',
  description: 'Comment on a post',
  examples: [
    'linkedin engage comment 7123456789 --text "Great post!"',
  ],

  inputSchema: z.object({
    post_urn: z.string().describe('Post activity URN ID (numeric part)'),
    text: z.string().max(1250).describe('Comment text (max 1250 chars)'),
  }),

  cliMappings: {
    args: [{ field: 'post_urn', name: 'post-urn', required: true }],
    options: [
      { field: 'text', flags: '-t, --text <text>', description: 'Comment text' },
    ],
  },

  handler: async (input, client) => {
    return client.post('/feed/comments?action=create', {
      updateId: `activity:${input.post_urn}`,
      commentaryV2: {
        text: input.text,
        attributes: [],
      },
    });
  },
};

export const engageCommentsListCommand: CommandDefinition = {
  name: 'engage_comments-list',
  group: 'engage',
  subcommand: 'comments-list',
  description: 'List comments on a post',
  examples: ['linkedin engage comments-list 7123456789'],

  inputSchema: z.object({
    post_urn: z.string().describe('Post activity URN ID (numeric part)'),
    limit: z.coerce.number().min(1).max(100).default(10).describe('Number of comments'),
    start: z.coerce.number().default(0).describe('Pagination offset'),
    sort: z.enum(['RELEVANCE', 'REVERSE_CHRONOLOGICAL']).default('RELEVANCE').describe('Sort order'),
  }),

  cliMappings: {
    args: [{ field: 'post_urn', name: 'post-urn', required: true }],
    options: [
      { field: 'limit', flags: '-l, --limit <number>', description: 'Number of comments' },
      { field: 'start', flags: '--start <number>', description: 'Pagination offset' },
      { field: 'sort', flags: '-s, --sort <order>', description: 'Sort: RELEVANCE or REVERSE_CHRONOLOGICAL' },
    ],
  },

  handler: async (input, client) => {
    return client.get('/feed/comments', {
      count: input.limit,
      start: input.start,
      q: 'comments',
      sortOrder: input.sort,
      updateId: `activity:${input.post_urn}`,
    });
  },
};

export const engageShareCommand: CommandDefinition = {
  name: 'engage_share',
  group: 'engage',
  subcommand: 'share',
  description: 'Share/repost a post with optional commentary',
  examples: [
    'linkedin engage share urn:li:share:12345',
    'linkedin engage share urn:li:share:12345 --text "This is worth reading"',
  ],

  inputSchema: z.object({
    share_urn: z.string().describe('Original share URN to repost'),
    text: z.string().max(3000).optional().describe('Optional commentary text'),
  }),

  cliMappings: {
    args: [{ field: 'share_urn', name: 'share-urn', required: true }],
    options: [
      { field: 'text', flags: '-t, --text <text>', description: 'Optional commentary' },
    ],
  },

  handler: async (input, client) => {
    const payload: any = {
      visibleToConnectionsOnly: false,
      externalAudienceProviders: [],
      commentaryV2: {
        text: input.text ?? '',
        attributes: [],
      },
      origin: 'FEED',
      allowedCommentersScope: 'ALL',
      postState: 'PUBLISHED',
      media: [],
      resharedUpdate: input.share_urn,
    };
    return client.post('/contentcreation/normShares', payload);
  },
};

export const engageCommands = [
  engageReactCommand,
  engageReactionsCommand,
  engageCommentCommand,
  engageCommentsListCommand,
  engageShareCommand,
];
