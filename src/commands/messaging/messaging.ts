import { z } from 'zod';
import type { CommandDefinition } from '../../core/types.js';
import { generateTrackingId } from '../../core/client.js';

export const messagingConversationsCommand: CommandDefinition = {
  name: 'messaging_conversations',
  group: 'messaging',
  subcommand: 'conversations',
  description: 'List your messaging conversations',
  examples: ['linkedin messaging conversations'],

  inputSchema: z.object({}),

  cliMappings: {},

  handler: async (_input, client) => {
    return client.get('/messaging/conversations', {
      keyVersion: 'LEGACY_INBOX',
    });
  },
};

export const messagingConversationWithCommand: CommandDefinition = {
  name: 'messaging_conversation-with',
  group: 'messaging',
  subcommand: 'conversation-with',
  description: 'Get conversation with a specific person by their URN ID',
  examples: ['linkedin messaging conversation-with ACoAABxxxxxxx'],

  inputSchema: z.object({
    profile_urn: z.string().describe('Profile URN ID of the recipient'),
  }),

  cliMappings: {
    args: [{ field: 'profile_urn', name: 'profile-urn', required: true }],
  },

  handler: async (input, client) => {
    return client.get('/messaging/conversations', {
      keyVersion: 'LEGACY_INBOX',
      q: 'participants',
      recipients: `List(${input.profile_urn})`,
    });
  },
};

export const messagingMessagesCommand: CommandDefinition = {
  name: 'messaging_messages',
  group: 'messaging',
  subcommand: 'messages',
  description: 'Get messages from a specific conversation',
  examples: ['linkedin messaging messages CONVERSATION_URN_ID'],

  inputSchema: z.object({
    conversation_id: z.string().describe('Conversation URN ID'),
    before: z.coerce.number().optional().describe('Timestamp (ms) — get messages before this time'),
  }),

  cliMappings: {
    args: [{ field: 'conversation_id', name: 'conversation-id', required: true }],
    options: [
      { field: 'before', flags: '--before <timestamp>', description: 'Get messages before this timestamp (ms)' },
    ],
  },

  handler: async (input, client) => {
    const query: Record<string, any> = { keyVersion: 'LEGACY_INBOX' };
    if (input.before) {
      query.createdBefore = input.before;
    }
    return client.get(`/messaging/conversations/${input.conversation_id}/events`, query);
  },
};

export const messagingSendCommand: CommandDefinition = {
  name: 'messaging_send',
  group: 'messaging',
  subcommand: 'send',
  description: 'Send a message in an existing conversation',
  examples: ['linkedin messaging send CONVERSATION_URN_ID --text "Hello!"'],

  inputSchema: z.object({
    conversation_id: z.string().describe('Conversation URN ID'),
    text: z.string().describe('Message text'),
  }),

  cliMappings: {
    args: [{ field: 'conversation_id', name: 'conversation-id', required: true }],
    options: [
      { field: 'text', flags: '-t, --text <text>', description: 'Message text' },
    ],
  },

  handler: async (input, client) => {
    return client.post(
      `/messaging/conversations/${input.conversation_id}/events?action=create`,
      {
        eventCreate: {
          originToken: crypto.randomUUID(),
          value: {
            'com.linkedin.voyager.messaging.create.MessageCreate': {
              attributedBody: {
                text: input.text,
                attributes: [],
              },
              attachments: [],
            },
          },
          trackingId: generateTrackingId(),
        },
        dedupeByClientGeneratedToken: false,
      },
    );
  },
};

export const messagingSendNewCommand: CommandDefinition = {
  name: 'messaging_send-new',
  group: 'messaging',
  subcommand: 'send-new',
  description: 'Send a message to one or more people (creates a new conversation)',
  examples: [
    'linkedin messaging send-new --recipients ACoAABxxxxxxx --text "Hello!"',
    'linkedin messaging send-new --recipients ACoAABxxxxxxx,ACoAAByyyyyyy --text "Group message"',
  ],

  inputSchema: z.object({
    recipients: z.string().describe('Comma-separated profile URN IDs'),
    text: z.string().describe('Message text'),
  }),

  cliMappings: {
    options: [
      { field: 'recipients', flags: '-r, --recipients <urns>', description: 'Comma-separated profile URN IDs' },
      { field: 'text', flags: '-t, --text <text>', description: 'Message text' },
    ],
  },

  handler: async (input, client) => {
    const recipientList = input.recipients.split(',').map((r: string) => r.trim());

    return client.post('/messaging/conversations?action=create', {
      keyVersion: 'LEGACY_INBOX',
      conversationCreate: {
        eventCreate: {
          originToken: crypto.randomUUID(),
          value: {
            'com.linkedin.voyager.messaging.create.MessageCreate': {
              attributedBody: {
                text: input.text,
                attributes: [],
              },
              attachments: [],
            },
          },
          trackingId: generateTrackingId(),
        },
        recipients: recipientList,
        subtype: 'MEMBER_TO_MEMBER',
      },
    });
  },
};

export const messagingMarkReadCommand: CommandDefinition = {
  name: 'messaging_mark-read',
  group: 'messaging',
  subcommand: 'mark-read',
  description: 'Mark a conversation as read',
  examples: ['linkedin messaging mark-read CONVERSATION_URN_ID'],

  inputSchema: z.object({
    conversation_id: z.string().describe('Conversation URN ID'),
  }),

  cliMappings: {
    args: [{ field: 'conversation_id', name: 'conversation-id', required: true }],
  },

  handler: async (input, client) => {
    return client.post(`/messaging/conversations/${input.conversation_id}`, {
      patch: {
        $set: {
          read: true,
        },
      },
    });
  },
};

export const messagingCommands = [
  messagingConversationsCommand,
  messagingConversationWithCommand,
  messagingMessagesCommand,
  messagingSendCommand,
  messagingSendNewCommand,
  messagingMarkReadCommand,
];
