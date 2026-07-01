#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TunnelSession } from './session.js';
import { registerTools, defaultDisplayName } from './tools.js';
import { parseArgs, helpText, runInstallSkill } from './cli.js';
import { readVersion, isSkillInstalled } from './skillInstall.js';

// Write a one-shot command's output, then exit only once it has flushed — a bare
// write()+exit() can truncate output piped to another process.
function writeThenExit(stream: NodeJS.WriteStream, text: string, code: number): void {
  stream.write(text.endsWith('\n') ? text : text + '\n', () => process.exit(code));
}

async function main(): Promise<void> {
  const version = readVersion();
  const parsed = parseArgs(process.argv.slice(2));

  // One-shot commands print and exit without ever opening the JSON-RPC channel.
  if (parsed.mode === 'help') return writeThenExit(process.stdout, helpText(version), 0);
  if (parsed.mode === 'version') return writeThenExit(process.stdout, version, 0);
  if (parsed.mode === 'error') {
    return writeThenExit(
      process.stderr,
      `tunnel-mcp: ${parsed.message}\n\n${helpText(version)}`,
      2,
    );
  }
  if (parsed.mode === 'install-skill') {
    const lines: string[] = [];
    const code = runInstallSkill({ dir: parsed.dir, force: parsed.force }, (m) => lines.push(m));
    // Success → stdout; failure → stderr.
    return writeThenExit(code === 0 ? process.stdout : process.stderr, lines.join('\n'), code);
  }

  // Serve. stdout is reserved for the JSON-RPC transport, so all human-facing
  // output goes to stderr (MCP clients capture it into their logs).
  const session = new TunnelSession();
  const server = new McpServer({ name: 'tunnel', version });
  registerTools(server as any, session, { displayName: defaultDisplayName() });

  let closing = false;
  async function teardown() {
    if (closing) return;
    closing = true;
    try {
      await session.close('process exit');
    } catch {
      /* best effort */
    }
    process.exit(0);
  }
  process.on('SIGINT', teardown);
  process.on('SIGTERM', teardown);

  const transport = new StdioServerTransport();
  // The host holds an HTTP/WS listener + a cloudflared child, so the event loop
  // never drains and `beforeExit` would never fire. Drive teardown off the stdio
  // pipe closing instead, which is how an MCP client actually ends the server.
  transport.onclose = () => {
    void teardown();
  };
  process.stdin.on('end', () => {
    void teardown();
  });
  process.stdin.on('close', () => {
    void teardown();
  });

  // Startup banner so a human who runs this by hand isn't staring at a silent,
  // seemingly-hung process (this is a server, not an interactive CLI).
  process.stderr.write(
    `tunnel-mcp v${version} ready on stdio — this is an MCP server, not an interactive CLI. ` +
      `Add it to an MCP client (run \`tunnel-mcp --help\`).\n`,
  );
  if (!isSkillInstalled()) {
    process.stderr.write(
      `tip: run \`npx tunnel-mcp install-skill\` to install the tunnel-etiquette skill ` +
        `(teaches agents to treat the peer as untrusted input).\n`,
    );
  }

  await server.connect(transport);
}

void main();
