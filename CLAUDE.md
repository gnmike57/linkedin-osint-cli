# linkedin-cli

CLI and MCP server for LinkedIn — full platform management via cookie session auth (Voyager API).

## Architecture

**Single source of truth**: Every LinkedIn API endpoint is one `CommandDefinition` object that powers both the CLI (Commander.js) and MCP server simultaneously.

```
src/
├── index.ts              # CLI entry (Commander.js)
├── mcp.ts                # MCP server entry (stdio)
├── core/
│   ├── types.ts          # CommandDefinition, LinkedInClient interfaces
│   ├── client.ts         # HTTP client (Voyager API, cookie auth, retry)
│   ├── handler.ts        # executeCommand() — builds requests from definitions
│   ├── auth.ts           # resolveAuth() — flag > env > config file
│   ├── config.ts         # ~/.linkedin-cli/config.json manager
│   ├── errors.ts         # Typed error classes
│   └── output.ts         # JSON formatting, --fields, --quiet
├── commands/
│   ├── index.ts          # allCommands registry + registerAllCommands()
│   ├── auth/login.ts     # login, logout, status (special commands)
│   ├── mcp/index.ts      # MCP start command
│   ├── profile/view.ts   # 9 profile commands
│   ├── posts/create.ts   # 3 post commands (create, edit, delete)
│   ├── feed/feed.ts      # 3 feed commands (view, user, company)
│   ├── engage/engage.ts  # 5 engagement commands (react, comment, share)
│   ├── connections/      # 7 connection commands
│   ├── messaging/        # 6 messaging commands
│   ├── search/search.ts  # 4 search commands (people, companies, jobs, posts)
│   ├── companies/        # 3 company commands
│   ├── jobs/jobs.ts      # 2 job commands
│   └── analytics/        # 1 analytics command
└── mcp/
    └── server.ts         # MCP server registration loop
```

## Authentication

Cookie-based auth via LinkedIn's Voyager API. Two cookies required:
- `li_at` — main session token
- `JSESSIONID` — session ID (used for CSRF token)

**Resolution order**: `--li-at`/`--jsessionid` flags → `LINKEDIN_LI_AT`/`LINKEDIN_JSESSIONID` env vars → `~/.linkedin-cli/config.json`

## Tech Stack

- TypeScript (ESM, strict), Commander.js, Zod v4, MCP SDK
- tsup for bundling (two entry points: CLI + MCP)
- Node.js 18+

## Adding a New Command

1. Add a `CommandDefinition` to the appropriate `src/commands/{group}/` file
2. Export it from the group's command array
3. The command is auto-registered in both CLI and MCP — no other changes needed

## API Base URL

All Voyager API calls go to `https://www.linkedin.com/voyager/api`. The client handles:
- Cookie/CSRF headers automatically
- Retry with exponential backoff (429, 5xx)
- Challenge detection (CAPTCHA/verification pages)
- Minimum 1s gap between requests

## Important Conventions

- All output is JSON to stdout (compact by default, `--pretty` for indented)
- Errors go to stderr as JSON `{error, code}`
- No interactive prompts in API commands — only `login` uses @inquirer/prompts
- Path parameters use `{field}` template syntax in endpoint paths
- CLI flags are kebab-case, input fields are snake_case
