import { z } from 'zod';
import type { CommandDefinition } from '../../core/types.js';
import { waitForExtensionPing } from '../../core/transport.js';

const inputSchema = z.object({});

export const extensionStatusCommand: CommandDefinition = {
  name: 'extension_status',
  group: 'extension',
  subcommand: 'status',
  description: 'Check if the browser extension bridge is connected and ready',

  examples: ['linkedin extension status'],

  inputSchema,

  cliMappings: {
    options: [],
  },

  handler: async () => {
    // Briefly listen for the service worker's ping so a one-shot process can
    // genuinely observe the bridge (call-time env knob; 0 = state read only).
    const waitMs = Number(process.env.LINKEDIN_EXTENSION_PING_WAIT_MS ?? '3000');
    const connected = await waitForExtensionPing(waitMs);

    if (connected) {
      return {
        connected: true,
        status: 'connected',
        message: 'Extension bridge is active and ready to proxy requests',
        proxyPort: Number(process.env.LINKEDIN_EXTENSION_PROXY_PORT) || 8788,
      };
    }

    return {
      connected: false,
      status: 'disconnected',
      message: 'Extension bridge not detected. Is the extension installed and browser running?',
      troubleshooting: [
        '1. Ensure Chrome/Edge is running',
        '2. Install extension: linkedin extension install',
        '3. Open chrome://extensions, enable Developer Mode, load unpacked from assets/browser-extension',
        '4. Click extension icon and press "Send session to CLI"',
        '5. Keep the bridge listening with: linkedin extension listen',
      ],
      proxyPort: Number(process.env.LINKEDIN_EXTENSION_PROXY_PORT) || 8788,
    };
  },
};