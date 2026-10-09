import type { CommandDefinition } from '../../core/types.js';
import { extensionInstallCommand } from './install.js';
import { extensionListenCommand } from './listen.js';
import { extensionStatusCommand } from './status.js';

export const extensionCommands: CommandDefinition[] = [
  extensionInstallCommand,
  extensionListenCommand,
  extensionStatusCommand,
];