import { describe, expect, it, vi, afterEach } from 'vitest';
import { allCommands } from '../src/commands';
import { buildCatalog } from '../src/interactive/catalog.js';
import {
  resolveShellMode,
  handleInput,
  createShellPrompts,
  renderShellHeader,
} from '../src/interactive/shell.js';
import type { ShellSession } from '../src/interactive/shell.js';

function makeSession(lines: string[] = []): { session: ShellSession; out: string[] } {
  const out: string[] = [];
  const scripted = [...lines];
  const nextLine = async (): Promise<string | null> =>
    scripted.length > 0 ? scripted.shift()! : null;
  const write = (text: string): void => out.push(text);
  const session: ShellSession = {
    version: '0.0.0-test',
    catalog: buildCatalog(allCommands),
    commands: allCommands,
    byGroup: new Map(),
    memory: new Map(),
    tty: false,
    write,
    history: [],
    prompts: createShellPrompts({ write, nextLine, tty: false }),
    nextLine,
    execSession: (args) => out.push(`EXEC:${args.join(' ')}`),
  };
  for (const command of allCommands) {
    if (!session.byGroup.has(command.group)) session.byGroup.set(command.group, []);
    session.byGroup.get(command.group)!.push(command);
  }
  return { session, out };
}

describe('shell fallback ladder (§7)', () => {
  it('defaults to the full shell', () => {
    expect(resolveShellMode({} as NodeJS.ProcessEnv)).toBe('shell');
  });
  it('LINKEDIN_UI=classic keeps the old palette', () => {
    expect(resolveShellMode({ LINKEDIN_UI: 'classic' } as NodeJS.ProcessEnv)).toBe('classic');
  });
  it('LINKEDIN_SHELL=plain forces the non-TTY grammar', () => {
    expect(resolveShellMode({ LINKEDIN_SHELL: 'plain' } as NodeJS.ProcessEnv)).toBe('plain');
  });
  it('classic wins over plain', () => {
    expect(
      resolveShellMode({ LINKEDIN_UI: 'classic', LINKEDIN_SHELL: 'plain' } as NodeJS.ProcessEnv),
    ).toBe('classic');
  });
});

describe('shell header (§4.2)', () => {
  it('renders version, tool count and session state without network calls', () => {
    const saved = renderShellHeader('9.9.9', 56, true);
    expect(saved).toContain('v9.9.9');
    expect(saved).toContain('56 tools');
    expect(saved).toContain('session: saved');
    expect(saved).toContain('"help" or plain English');
    const none = renderShellHeader('9.9.9', 56, false);
    expect(none).toContain('session: none — type "login"');
    expect(none).toContain('╔');
  });
});

describe('shell builtins (§4.3)', () => {
  it('help lists builtins and groups', async () => {
    const { session, out } = makeSession();
    expect(await handleInput(session, 'help')).toBe('continue');
    const text = out.join('\n');
    expect(text).toContain('browse [group]');
    expect(text).toContain('osint');
    expect(text).toContain('exact form');
  });

  it('help <group> lists that group and help <cmd> prints detail', async () => {
    const { session, out } = makeSession();
    await handleInput(session, 'help profile');
    expect(out.join('\n')).toContain('contact-info');
    await handleInput(session, 'help profile view');
    expect(out.join('\n')).toContain('View a LinkedIn profile');
  });

  it('history prints session entries', async () => {
    const { session, out } = makeSession();
    session.history.push('feed view', 'osint stats --file a.json');
    await handleInput(session, 'history');
    const text = out.join('\n');
    expect(text).toContain('1');
    expect(text).toContain('osint stats --file a.json');
  });

  it('exit and quit end the session', async () => {
    const a = makeSession();
    expect(await handleInput(a.session, 'exit')).toBe('exit');
    const b = makeSession();
    expect(await handleInput(b.session, 'quit')).toBe('exit');
  });

  it('clear in plain mode prints a separator', async () => {
    const { session, out } = makeSession();
    await handleInput(session, 'clear');
    expect(out.join('\n')).toContain('─');
  });

  it('status/login/logout re-exec the CLI session commands', async () => {
    const { session, out } = makeSession();
    await handleInput(session, 'status');
    await handleInput(session, 'login');
    await handleInput(session, 'logout');
    expect(out.join('\n')).toContain('EXEC:status --verify');
    expect(out.join('\n')).toContain('EXEC:login');
    expect(out.join('\n')).toContain('EXEC:logout');
  });
});

describe('shell exact commands (§4.3 rule 2)', () => {
  it('flags are parsed and unknown flags error with the help text', async () => {
    const { session, out } = makeSession();
    expect(await handleInput(session, 'profile view johndoe --nope')).toBe('continue');
    const text = out.join('\n');
    expect(text).toContain("unknown option '--nope'");
    expect(text).toContain('View a LinkedIn profile');
  });

  it('missing required params are filled by the guided prompts', async () => {
    const { session, out } = makeSession(['johndoe', 'raw']);
    await handleInput(session, 'profile view');
    const text = out.join('\n');
    expect(text).toContain('public_id (required)');
    expect(text).toContain('linkedin profile view johndoe');
  });

  it('unknown subcommand lists the available ones', async () => {
    const { session, out } = makeSession();
    await handleInput(session, 'profile nope');
    expect(out.join('\n')).toContain("unknown subcommand 'nope' for 'profile'");
  });

  it('staging shows the assembled command line and raw prints it verbatim', async () => {
    const { session, out } = makeSession(['raw']);
    await handleInput(session, 'profile view johndoe');
    const text = out.join('\n');
    expect(text).toContain('interpreted as');
    expect(text).toContain('linkedin profile view johndoe');
    expect(text).toContain('⏎ run');
  });

  it('staging q cancels back to the prompt', async () => {
    const { session } = makeSession(['q']);
    expect(await handleInput(session, 'profile view johndoe')).toBe('continue');
  });

  it('a staged field override lands in the command line', async () => {
    const { session, out } = makeSession(['out-dir ./tmp-smoke', 'raw']);
    await handleInput(session, 'osint classify --title "Senior Cyber Security Manager"');
    const text = out.join('\n');
    expect(text).toContain('--out-dir ./tmp-smoke');
  });

  it('an invalid field name prints the field list, not an error crash', async () => {
    const { session, out } = makeSession(['nope 5', 'q']);
    await handleInput(session, 'profile view johndoe');
    expect(out.join('\n')).toContain("unknown field 'nope'");
  });

  it('EOF mid-staging ends the session gracefully', async () => {
    const { session } = makeSession([]);
    expect(await handleInput(session, 'profile view johndoe')).toBe('exit');
  });
});

describe('shell NLP path (§4.3 rule 3)', () => {
  it('plain English resolves to the same interpreted command', async () => {
    const { session, out } = makeSession(['q']);
    await handleInput(session, 'find people software engineer');
    const text = out.join('\n');
    expect(text).toContain('linkedin search people --keywords "software engineer"');
  });

  it('refusals reply with not-sure plus nearest commands', async () => {
    const { session, out } = makeSession();
    await handleInput(session, 'flurb the wibble');
    const text = out.join('\n');
    expect(text).toContain('not sure what you mean');
    expect(text).toContain('nearest commands');
  });

  it('ambiguity lists numbered candidates and the pick is remembered', async () => {
    const { session, out } = makeSession(['1', 'q']);
    await handleInput(session, 'text');
    const text = out.join('\n');
    expect(text).toContain('could mean several things');
    expect(text).toContain('messaging send-new');
    expect(session.memory.get('text')).toBe('messaging_send-new');
    expect(text).toContain('linkedin messaging send-new');
  });

  it('a remembered phrase resolves without re-asking', async () => {
    const { session, out } = makeSession(['q']);
    session.memory.set('text', 'messaging_send-new');
    await handleInput(session, 'text');
    const text = out.join('\n');
    expect(text).toContain('linkedin messaging send-new');
    expect(text).not.toContain('could mean several things');
  });

  it('offline execution runs the handler and prints the scriptable line', async () => {
    const { session, out } = makeSession(['']);
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    try {
      const verdict = await handleInput(session, 'osint classify --title "Senior Cyber Security Manager"');
      expect(verdict).toBe('continue');
      expect(out.join('\n')).toContain('≡ scriptable:');
      expect(out.join('\n')).toContain('done in');
      expect(logs.join('\n')).toContain('"division":"Cyber Security"');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('shell staging extras', () => {
  it('enum overrides validate against the allowed values', async () => {
    const { session, out } = makeSession(['format yaml', 'q']);
    await handleInput(session, 'osint employees acme-corp');
    const text = out.join('\n');
    expect(text).toContain("allowed: json, csv");
  });

  it('boolean overrides accept bare flags and true/false', async () => {
    const { session, out } = makeSession(['verbose', 'raw']);
    await handleInput(session, 'osint stats --files a.json');
    expect(out.join('\n')).toContain('--verbose');
  });

  it('write commands require an explicit yes (default n)', async () => {
    const { session, out } = makeSession(['', 'n']);
    // posts create maps to a write command: staging → Enter → confirm(n) cancels
    const verdict = await handleInput(session, 'new post "hello world"');
    expect(verdict).toBe('continue');
    const text = out.join('\n');
    expect(text).toContain('⚠ write command');
    expect(text).toContain('cancelled.');
  });
});
