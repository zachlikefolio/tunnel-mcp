import { installSkill, readVersion } from './skillInstall.js';

export type ParsedArgs =
  | { mode: 'serve' }
  | { mode: 'help' }
  | { mode: 'version' }
  | { mode: 'install-skill'; dir?: string; force: boolean }
  | { mode: 'error'; message: string };

export function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) return { mode: 'serve' };
  const [cmd, ...rest] = argv;
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') return { mode: 'help' };
  if (cmd === '--version' || cmd === '-v') return { mode: 'version' };
  if (cmd === 'install-skill') {
    let dir: string | undefined;
    let force = false;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--force' || a === '-f') force = true;
      else if (a === '--dir') {
        const next = rest[++i];
        // Guard against `--dir --force` (eats the flag) and a trailing `--dir`.
        if (next === undefined || next.startsWith('-')) {
          return { mode: 'error', message: '--dir requires a path' };
        }
        dir = next;
      } else if (a.startsWith('--dir=')) {
        dir = a.slice('--dir='.length);
        if (dir === '') return { mode: 'error', message: '--dir requires a path' };
      } else return { mode: 'error', message: `unknown option for install-skill: ${a}` };
    }
    return { mode: 'install-skill', dir, force };
  }
  return { mode: 'error', message: `unknown command: ${cmd}` };
}

export function helpText(version: string = readVersion()): string {
  return [
    `tunnel-mcp v${version}`,
    `An MCP server that lets two developers' Claude agents talk directly through an`,
    `ephemeral, end-to-end-encrypted tunnel.`,
    ``,
    `This is a stdio MCP server, NOT an interactive CLI. With no arguments it starts`,
    `the server and waits for an MCP client to connect over stdin/stdout, so running`,
    `it by hand in a terminal will look like it "does nothing" — that's expected.`,
    `You add it to an MCP client instead:`,
    ``,
    `  claude mcp add tunnel -- npx -y tunnel-mcp          # Claude Code (this project)`,
    `  claude mcp add -s user tunnel -- npx -y tunnel-mcp  # ...available everywhere`,
    ``,
    `Commands:`,
    `  (no args)        Start the MCP server on stdio (for an MCP client to launch)`,
    `  install-skill    Install the tunnel-etiquette skill into your skills directory`,
    `  --help, -h       Show this help and exit`,
    `  --version, -v    Print the version and exit`,
    ``,
    `install-skill options:`,
    `  --dir <path>     Target skills directory (default: ~/.claude/skills or`,
    `                   $TUNNEL_SKILLS_DIR)`,
    `  --force, -f      Overwrite an existing install`,
    ``,
    `Environment:`,
    `  TUNNEL_SKILLS_DIR                 Override the skills directory`,
    `  TUNNEL_SKIP_SKILL_INSTALL=1       Skip the automatic skill install on npm install`,
    `  TUNNEL_SKIP_REACHABILITY_CHECK=1  Open a tunnel even if this machine can't reach`,
    `                                    *.trycloudflare.com (your guest still must)`,
    ``,
    `Docs: https://github.com/zachlikefolio/tunnel-mcp`,
  ].join('\n');
}

/** Runs the `install-skill` command. Returns a process exit code. */
export function runInstallSkill(
  args: { dir?: string; force: boolean },
  out: (msg: string) => void,
): number {
  try {
    const res = installSkill({ skillsDir: args.dir, overwrite: args.force });
    if (res.installed) {
      out(
        `Installed the tunnel-etiquette skill to ${res.target}${res.updated ? ' (overwrote the existing copy)' : ''}.`,
      );
    } else {
      out(
        `The tunnel-etiquette skill is already present at ${res.target}. Re-run with --force to overwrite it.`,
      );
    }
    return 0;
  } catch (e) {
    out(`Failed to install the skill: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
