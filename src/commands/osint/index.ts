/**
 * OSINT command group — every command here is registered in BOTH the CLI and
 * the MCP server automatically (single CommandDefinition source of truth).
 */

import type { CommandDefinition } from '../../core/types.js';
import { osintDiscoverCommand } from './discover.js';
import { osintEmployeesCommand } from './employees.js';
import { osintNamesCommand } from './names.js';
import { osintClassifyCommand } from './classify.js';
import { osintAiScoreCommand, osintAiClassifyCommand } from './ai.js';
import { osintOrgchartCommand } from './orgchart.js';
import { osintMatrixCommand } from './matrix.js';
import { osintStatsCommand } from './stats.js';
import { osintScanCommand } from './scan.js';
import { osintEmailLookupCommand } from './email-lookup.js';
import { osintDeepDiveCommand } from './deep-dive.js';
import { osintFunnelCommand } from './funnel.js';

export const osintCommands: CommandDefinition[] = [
  osintDiscoverCommand,
  osintEmployeesCommand,
  osintNamesCommand,
  osintClassifyCommand,
  osintAiScoreCommand,
  osintAiClassifyCommand,
  osintOrgchartCommand,
  osintMatrixCommand,
  osintStatsCommand,
  osintScanCommand,
  osintEmailLookupCommand,
  osintDeepDiveCommand,
  osintFunnelCommand,
];
