import { z } from 'zod';
import { readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { CommandDefinition, LinkedInClient } from '../../core/types.js';
import { generateTrackingId } from '../../core/client.js';

export const postsCreateCommand: CommandDefinition = {
  name: 'posts_create',
  group: 'posts',
  subcommand: 'create',
  description: 'Create a new LinkedIn post (text, image, or article)',
  examples: [
    'linkedin posts create --text "Hello LinkedIn!"',
    'linkedin posts create --text "Check this out" --image ./photo.jpg',
    'linkedin posts create --text "My thoughts" --visibility connections',
    'linkedin posts create --text "Exciting news" --comments-scope connections',
  ],

  inputSchema: z.object({
    text: z.string().max(3000).describe('Post text content (max 3000 chars)'),
    visibility: z.enum(['anyone', 'connections']).default('anyone').describe('Who can see the post'),
    image: z.string().optional().describe('Path to image file to attach'),
    comments_scope: z.enum(['all', 'connections', 'none']).default('all').describe('Who can comment'),
  }),

  cliMappings: {
    options: [
      { field: 'text', flags: '-t, --text <text>', description: 'Post text (required, max 3000 chars)' },
      { field: 'visibility', flags: '-v, --visibility <scope>', description: 'Visibility: anyone or connections' },
      { field: 'image', flags: '-i, --image <path>', description: 'Path to image file to attach' },
      { field: 'comments_scope', flags: '--comments-scope <scope>', description: 'Who can comment: all, connections, none' },
    ],
  },

  handler: async (input, client) => {
    const commentsScopeMap: Record<string, string> = {
      all: 'ALL',
      connections: 'CONNECTIONS_ONLY',
      none: 'NONE',
    };

    let mediaItems: any[] = [];

    // Upload image if provided
    if (input.image) {
      const mediaUrn = await uploadImage(client, input.image);
      mediaItems.push({
        category: 'IMAGE',
        mediaUrn,
        tapTargets: [],
      });
    }

    const payload = {
      visibleToConnectionsOnly: input.visibility === 'connections',
      externalAudienceProviders: [],
      commentaryV2: {
        text: input.text,
        attributes: [],
      },
      origin: 'FEED',
      allowedCommentersScope: commentsScopeMap[input.comments_scope] ?? 'ALL',
      postState: 'PUBLISHED',
      media: mediaItems,
    };

    return client.post('/contentcreation/normShares', payload);
  },
};

export const postsEditCommand: CommandDefinition = {
  name: 'posts_edit',
  group: 'posts',
  subcommand: 'edit',
  description: 'Edit an existing LinkedIn post',
  examples: ['linkedin posts edit urn:li:share:12345 --text "Updated text"'],

  inputSchema: z.object({
    share_urn: z.string().describe('Share URN (e.g., urn:li:share:12345)'),
    text: z.string().max(3000).describe('New post text'),
  }),

  cliMappings: {
    args: [{ field: 'share_urn', name: 'share-urn', required: true }],
    options: [
      { field: 'text', flags: '-t, --text <text>', description: 'New post text' },
    ],
  },

  handler: async (input, client) => {
    const urnEncoded = encodeURIComponent(input.share_urn);
    return client.post(`/contentcreation/normShares/${urnEncoded}`, {
      patch: {
        $set: {
          commentaryV2: {
            text: input.text,
            attributes: [],
            $type: 'com.linkedin.voyager.common.TextViewModel',
          },
        },
      },
    });
  },
};

export const postsDeleteCommand: CommandDefinition = {
  name: 'posts_delete',
  group: 'posts',
  subcommand: 'delete',
  description: 'Delete a LinkedIn post by share URN',
  examples: ['linkedin posts delete urn:li:share:12345'],

  inputSchema: z.object({
    share_urn: z.string().describe('Share URN to delete'),
  }),

  cliMappings: {
    args: [{ field: 'share_urn', name: 'share-urn', required: true }],
  },

  handler: async (input, client) => {
    const urnEncoded = encodeURIComponent(input.share_urn);
    return client.delete(`/contentcreation/normShares/${urnEncoded}`);
  },
};

async function uploadImage(client: LinkedInClient, filePath: string): Promise<string> {
  // Validate file exists before uploading
  try {
    await access(filePath, constants.R_OK);
  } catch {
    throw new Error(`Image file not found or not readable: ${filePath}`);
  }

  const fileBuffer = await readFile(filePath);
  const fileSize = fileBuffer.byteLength;
  const filename = filePath.split('/').pop() ?? 'image.jpg';

  // Step 1: Get upload URL
  const uploadMeta = await client.post<any>(
    '/voyagerVideoDashMediaUploadMetadata?action=upload',
    {
      mediaUploadType: 'IMAGE_SHARING',
      fileSize,
      filename,
    },
  );

  const uploadUrl = uploadMeta?.data?.value?.singleUploadUrl;
  const mediaUrn = uploadMeta?.data?.value?.urn;

  if (!uploadUrl || !mediaUrn) {
    throw new Error('Failed to get image upload URL from LinkedIn');
  }

  // Step 2: Upload the binary
  const uploadHeaders: Record<string, string> = {
    'content-type': getMimeType(filename),
    'media-type-family': 'STILLIMAGE',
  };

  const uploadResponse = await fetch(uploadUrl, {
    method: 'PUT',
    headers: uploadHeaders,
    body: fileBuffer,
  });

  if (!uploadResponse.ok) {
    throw new Error(`Image upload failed: ${uploadResponse.status}`);
  }

  return mediaUrn;
}

function getMimeType(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop();
  const mimeTypes: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
  };
  return mimeTypes[ext ?? ''] ?? 'image/jpeg';
}

export const postsCommands = [
  postsCreateCommand,
  postsEditCommand,
  postsDeleteCommand,
];
