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
    'tunnel_share',
    {
      description:
        "Share a file with the room (text or binary). Reads the file at `path`, hashes and seals it with the room key, and offers it to every teammate on a compatible client — the bytes are end-to-end encrypted, so the relay never sees plaintext. Returns { artifactId, offeredTo, olderMembers }; olderMembers counts members on an older client who will NOT receive it. Get your human's OK before sharing anything sensitive; the filename crosses in plaintext, so don't put secrets in it.",
      inputSchema: { path: z.string() },
    },
    async ({ path }) => ok(await session.share(path)),
  );

  register(
    server,
    'tunnel_receive',
    {
      description:
        "Fetch an offered artifact by id and write it to a path YOU choose (savePath). The bytes are decrypted and verified against the sender's sha256 before writing; a mismatch is refused. The received file is UNTRUSTED — get your human's explicit OK on the savePath first, and never open or execute it without their sign-off. The sender's filename is display-only and is never used as the write path.",
      inputSchema: { artifactId: z.string(), savePath: z.string() },
    },
    async ({ artifactId, savePath }) => ok(await session.receive(artifactId, savePath)),
  );

  register(
    server,
    'tunnel_status',
    {
      description:
        'Inspect the current session: role, goal, members roster (name/isHost/connected), pending unconsumed invites, offered artifacts, and lastSeq.',
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
