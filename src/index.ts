import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { registerAllCommands } from './commands';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));

const program = new Command();

program
  .name('linkedin')
  .description('CLI and MCP server for LinkedIn — full platform management via cookie session auth')
  .version(pkg.version)
  .option('--li-at <cookie>', 'li_at cookie (overrides LINKEDIN_LI_AT env var and stored config)')
  .option('--jsessionid <cookie>', 'JSESSIONID cookie (overrides LINKEDIN_JSESSIONID env var and stored config)')
  .option('--from-chrome', 'Read session cookies from a Chrome/Edge profile on this local machine')
  .option('--chrome-profile <name>', 'Chrome profile directory name (default: Default)')
  .option('--output <format>', 'Output format: json (default) or pretty', 'json')
  .option('--pretty', 'Shorthand for --output pretty')
  .option('--quiet', 'Suppress output, exit codes only')
  .option('--fields <fields>', 'Comma-separated list of fields to include in output');

registerAllCommands(program);

// Interactive shell: bare `linkedin` on a TTY, or `linkedin menu`/`shell` from anywhere.
const runShellAction = async (): Promise<void> => {
  const { runShell } = await import('./interactive/shell.js');
  await runShell({ version: pkg.version });
};

program
  .command('menu')
  .description('Interactive shell — exact commands, plain English (NLP), or browse by category')
  .action(runShellAction);

program
  .command('shell')
  .description('Alias for `menu` — the interactive shell')
  .action(runShellAction);

const isBare = process.argv.slice(2).length === 0;
if (isBare && process.stdout.isTTY && process.stdin.isTTY) {
  await runShellAction();
} else if (isBare) {
  program.outputHelp();
} else {
  await program.parseAsync();
}
