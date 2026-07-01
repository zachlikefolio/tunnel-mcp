import { execSync } from 'node:child_process';
import os from 'node:os';
import { z } from 'zod';
import { TunnelSession } from './session.js';
import { DEFAULT_LISTEN_TIMEOUT_MS } from './config.js';

type AnyServer = {
  registerTool?: (name: string, schema: any, cb: (args: any) => Promise<any>) => void;
  tool?: (name: string, schema: any, cb: (args: any) => Promise<any>) => void;
};

export function defaultDisplayName(): string {
  try {
    const n = execSync('git config user.name', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    if (n) return n;
  } catch {
    /* not a git repo */
  }
  return os.userInfo().username || 'anonymous';
}

function ok(result: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
}

function register(server: AnyServer, name: string, schema: any, cb: (args: any) => Promise<any>) {
  if (server.registerTool) server.registerTool(name, schema, cb);
  else if (server.tool) server.tool(name, schema, cb);
  else throw new Error('unsupported MCP server shape');
}

export function registerTools(
  server: AnyServer,
  session: TunnelSession,
  opts: { displayName: string },
): void {
  register(
    server,
    'tunnel_open',
    {
      description:
        'Open a tunnel as host and get a join link to share. The link is a secret — share it over a trusted channel. It is single-use (works for exactly one guest) and expires (see joinLinkExpiresInSec in the result), so tell the human to share it promptly. If the result includes a reachabilityWarning, relay it to the human: this host could not confirm it can reach the link, so the guest should verify they can open it.',
      inputSchema: { goal: z.string() },
    },
    async ({ goal }) => ok(await session.open(goal, opts.displayName)),
  );

  register(
    server,
    'tunnel_join',
    {
      description: "Join another developer's tunnel by its link.",
      inputSchema: { joinLink: z.string() },
    },
    async ({ joinLink }) => ok(await session.join(joinLink, opts.displayName)),
  );

  register(
    server,
    'tunnel_say',
    { description: 'Send a chat message to the peer agent.', inputSchema: { text: z.string() } },
    async ({ text }) => ok(await session.say(text)),
  );

  register(
    server,
    'tunnel_listen',
    {
      description:
        'Block until the peer replies (or timeout). Pass the highest seq you have already seen.',
      inputSchema: { sinceSeq: z.number().default(0), timeoutMs: z.number().optional() },
    },
    async ({ sinceSeq, timeoutMs }) =>
      ok(await session.listen(sinceSeq ?? 0, timeoutMs ?? DEFAULT_LISTEN_TIMEOUT_MS)),
  );

  register(
    server,
    'tunnel_status',
    { description: 'Inspect the current tunnel.', inputSchema: {} },
    async () => ok(session.status()),
  );

  register(
    server,
    'tunnel_close',
    {
      description: 'Close the tunnel (host tears down; guest leaves).',
      inputSchema: { summary: z.string().optional() },
    },
    async ({ summary }) => ok(await session.close(summary)),
  );
}
