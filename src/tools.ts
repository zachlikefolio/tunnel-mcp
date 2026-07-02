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
        'Open a room as host. Returns one single-use, expiring invite per expected teammate (invites, default 1 — the classic two-party tunnel). Each invites[i].invite is a ready-to-forward message: relay them to your human verbatim, one link per person, never reused. Treat every link as a secret.',
      inputSchema: { goal: z.string(), invites: z.number().int().min(1).max(15).optional() },
    },
    async ({ goal, invites }) =>
      ok(await session.open(goal, opts.displayName, { invites: invites ?? 1 })),
  );

  register(
    server,
    'tunnel_invite',
    {
      description:
        'Host-only: mint additional single-use, expiring invites mid-session (add a teammate, or re-admit someone who disconnected — their old link stays dead). Relay each invite text verbatim to your human.',
      inputSchema: { count: z.number().int().min(1).max(15).optional() },
    },
    async ({ count }) => ok(session.invite(count ?? 1)),
  );

  register(
    server,
    'tunnel_join',
    {
      description:
        "Join another developer's tunnel by its link. The result lists the current members (roster).",
      inputSchema: { joinLink: z.string() },
    },
    async ({ joinLink }) => ok(await session.join(joinLink, opts.displayName)),
  );

  register(
    server,
    'tunnel_say',
    { description: 'Send a chat message to the room.', inputSchema: { text: z.string() } },
    async ({ text }) => ok(await session.say(text)),
  );

  register(
    server,
    'tunnel_listen',
    {
      description:
        'Block until the next message arrives (or timeout). Pass the highest seq you have already seen.',
      inputSchema: { sinceSeq: z.number().default(0), timeoutMs: z.number().optional() },
    },
    async ({ sinceSeq, timeoutMs }) =>
      ok(await session.listen(sinceSeq ?? 0, timeoutMs ?? DEFAULT_LISTEN_TIMEOUT_MS)),
  );

  register(
    server,
    'tunnel_status',
    {
      description:
        'Inspect the current session: role, goal, members roster (name/isHost/connected), pending unconsumed invites, and lastSeq.',
      inputSchema: {},
    },
    async () => ok(session.status()),
  );

  register(
    server,
    'tunnel_close',
    {
      description:
        'Host: closes the room for everyone and destroys the relay + log. Member: leaves the room. Provide an optional summary.',
      inputSchema: { summary: z.string().optional() },
    },
    async ({ summary }) => ok(await session.close(summary)),
  );
}
