import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SESSIONS_DIR } from '../src/config.js';
import { TunnelSession } from '../src/session.js';
import { newId } from '../src/protocol/messages.js';
import { MemberClient } from '../src/relay/memberClient.js';

const sessions: TunnelSession[] = [];
afterEach(async () => {
  for (const s of sessions) {
    try {
      await s.close();
    } catch {}
  }
  sessions.length = 0;
});

// Fake cloudflared: the "public url" points straight at the local relay port,
// so host and member connect over loopback with no network or real binary.
function fakeDeps(capturePort: { port?: number }, idleMs?: number) {
  return {
    ensureCloudflared: async () => 'fake',
    startCloudflared: async (_bin: string, port: number) => {
      capturePort.port = port;
      return { publicUrl: `http://127.0.0.1:${port}`, stop() {} };
    },
    idleMs,
  };
}

// Drain the pre-join system-message backlog, then block for the host's chat to
// actually arrive over the socket (a single listen(0) would short-circuit on
// the backlog and miss the in-flight chat). The host is 'alice' in these tests.
async function waitForHostChat(s: TunnelSession, deadlineMs = 3000) {
  const stop = Date.now() + deadlineMs;
  let since = 0;
  while (Date.now() < stop) {
    const { messages } = await s.listen(since, stop - Date.now());
    for (const m of messages) since = Math.max(since, m.seq);
    const c = messages.find((m) => m.kind === 'chat' && m.fromName === 'alice');
    if (c) return c;
  }
  throw new Error('timed out waiting for host chat');
}

function memberConnected(s: TunnelSession): boolean {
  return s.status().members.some((m) => !m.isHost && m.connected);
}

describe('TunnelSession (host <-> member, fake cloudflared)', () => {
  it('opens, joins, exchanges a turn, and tears down', async () => {
    const cap: { port?: number } = {};
    const host = new TunnelSession(fakeDeps(cap));
    const member = new TunnelSession();
    sessions.push(host, member);

    const opened = await host.open('fix the 401', 'alice');
    expect(opened.status).toBe('waiting_for_members');
    expect(opened.joinLink).toContain('/t/');

    const joined = await member.join(opened.joinLink!, 'bob');
    expect(joined.goal).toBe('fix the 401');
    expect(joined.self.name).toBe('bob');
    expect(typeof joined.self.id).toBe('string');
    expect(joined.members.find((m) => m.isHost)?.name).toBe('alice');

    // host says -> member listens (wait past the backlog for the actual chat)
    await host.say('whats the error?');
    const chat = await waitForHostChat(member, 3000);
    expect(chat.text).toBe('whats the error?');

    // member says -> host listens
    const sent = await member.say('http 401 on /auth');
    expect(sent.seq).toBeGreaterThan(0);
    const hostHeard = await host.listen(chat.seq, 3000);
    expect(
      hostHeard.messages.some((m) => m.kind === 'chat' && m.text === 'http 401 on /auth'),
    ).toBe(true);

    expect(memberConnected(host)).toBe(true);
    await host.close('done');
  });

  it('listen returns empty on timeout when nothing new arrives', async () => {
    const host = new TunnelSession(fakeDeps({}));
    sessions.push(host);
    await host.open('goal', 'alice');
    const res = await host.listen(999, 300);
    expect(res.messages).toEqual([]);
  });

  it('tears down on idle timeout — the third teardown trigger', async () => {
    const host = new TunnelSession(fakeDeps({}, 150)); // 150ms idle window
    sessions.push(host);
    const { tunnelId } = await host.open('goal', 'alice');
    await new Promise((r) => setTimeout(r, 500));
    expect(host.isOpen).toBe(false);
    expect(fs.existsSync(path.join(SESSIONS_DIR, `${tunnelId}.jsonl`))).toBe(false);
  });

  it('retries cloudflared startup and eventually succeeds', async () => {
    let calls = 0;
    const host = new TunnelSession({
      ensureCloudflared: async () => 'fake',
      startCloudflared: async (_b: string, port: number) => {
        if (++calls < 2) throw new Error('not ready');
        return { publicUrl: `http://127.0.0.1:${port}`, stop() {} };
      },
    });
    sessions.push(host);
    const opened = await host.open('goal', 'alice');
    expect(calls).toBe(2);
    expect(opened.joinLink).toContain('/t/');
  });

  it('a leaked join link cannot be reused — a second member is rejected (single-use)', async () => {
    const host = new TunnelSession(fakeDeps({}));
    const member1 = new TunnelSession();
    const member2 = new TunnelSession();
    sessions.push(host, member1, member2);

    const opened = await host.open('goal', 'alice');
    await member1.join(opened.joinLink!, 'bob'); // consumes the single-use invite token
    await member1.close();

    // Anyone who later obtains the same link presents an already-redeemed token.
    await expect(member2.join(opened.joinLink!, 'mallory')).rejects.toThrow(/already used/i);
  });

  it('open() reports the join-link expiry window (default 10 minutes)', async () => {
    const host = new TunnelSession(fakeDeps({}));
    sessions.push(host);
    const opened = await host.open('goal', 'alice');
    expect(opened.joinLinkExpiresInSec).toBe(600);
  });

  it('open() returns a forwardable invite carrying the join link and setup command', async () => {
    const host = new TunnelSession(fakeDeps({}));
    sessions.push(host);
    const opened = await host.open('fix the 401', 'alice');
    expect(opened.invite).toContain(opened.joinLink);
    expect(opened.invite).toContain('claude mcp add tunnel -- npx -y tunnel-mcp');
    expect(opened.invite).toContain('fix the 401');
  });

  it('open({ invites: n }) mints n invites and omits the single-invite continuity trio', async () => {
    const host = new TunnelSession(fakeDeps({}));
    sessions.push(host);
    const opened = await host.open('team debug', 'alice', { invites: 3 });
    expect(opened.invites).toHaveLength(3);
    expect(opened.joinLink).toBeUndefined();
    expect(opened.invite).toBeUndefined();
    const links = new Set(opened.invites.map((i) => i.joinLink));
    expect(links.size).toBe(3); // distinct tokens per invite
  });

  it('only the host can mint further invites', async () => {
    const host = new TunnelSession(fakeDeps({}));
    const member = new TunnelSession();
    sessions.push(host, member);
    const opened = await host.open('goal', 'alice');
    await member.join(opened.joinLink!, 'bob');
    expect(() => member.invite(1)).toThrow(/only the host can mint invites/);
    expect(host.invite(1)).toHaveLength(1);
  });

  it('a leaked v1 (tokenless) link is rejected with the upgrade message', async () => {
    const member = new TunnelSession();
    sessions.push(member);
    await expect(member.join('wss://x.io/t/abc123#YWJjZGVm', 'bob')).rejects.toThrow(
      /older tunnel-mcp host/,
    );
  });

  it('an expired join link is rejected end-to-end', async () => {
    const host = new TunnelSession({
      ensureCloudflared: async () => 'fake',
      startCloudflared: async (_b: string, port: number) => ({
        publicUrl: `http://127.0.0.1:${port}`,
        stop() {},
      }),
      joinTtlMs: 20, // window lapses before the member joins
    });
    const member = new TunnelSession();
    sessions.push(host, member);

    const opened = await host.open('goal', 'alice');
    await new Promise((r) => setTimeout(r, 60));
    await expect(member.join(opened.joinLink!, 'bob')).rejects.toThrow(/invite expired/i);
  });

  it('the join-link expiry window starts at mint time, not before cloudflared provisioning', async () => {
    const host = new TunnelSession({
      ensureCloudflared: async () => 'fake',
      startCloudflared: async (_b: string, port: number) => {
        await new Promise((r) => setTimeout(r, 200));
        return { publicUrl: `http://127.0.0.1:${port}`, stop() {} };
      },
      joinTtlMs: 100,
    });
    const member = new TunnelSession();
    sessions.push(host, member);

    const opened = await host.open('goal', 'alice');
    const joined = await member.join(opened.joinLink!, 'bob');
    expect(joined.goal).toBe('goal');
  });

  it('listen() and say() throw a clean error after close() instead of crashing', async () => {
    const host = new TunnelSession(fakeDeps({}));
    sessions.push(host);
    await host.open('goal', 'alice');
    await host.close('done');

    await expect(host.listen(0, 50)).rejects.toThrow('no open tunnel');
    await expect(host.say('hello')).rejects.toThrow('no open tunnel');
  });

  it('fails cleanly with a readable error after exhausting retries', async () => {
    let calls = 0;
    const host = new TunnelSession({
      ensureCloudflared: async () => 'fake',
      startCloudflared: async () => {
        calls++;
        throw new Error('boom');
      },
    });
    sessions.push(host);
    await expect(host.open('goal', 'alice')).rejects.toThrow(/after 3 attempts/);
    expect(calls).toBe(3);
    expect(host.isOpen).toBe(false);
  });

  it('decrypt-totality: a forged/malformed chat body from an untrusted member surfaces as [unreadable] instead of throwing or poisoning the batch', async () => {
    const host = new TunnelSession(fakeDeps({}));
    const member = new TunnelSession();
    sessions.push(host, member);

    const opened = await host.open('goal', 'alice');
    await member.join(opened.joinLink!, 'bob');

    // Reach past the public say() straight to the underlying MemberClient.say()
    // so we can send a 'send' frame whose body is NOT valid sealed ciphertext.
    const memberClient = (member as unknown as { member: MemberClient }).member;
    expect(memberClient).toBeInstanceOf(MemberClient);
    const forged = {
      id: newId(),
      seq: -1,
      from: memberClient.selfId ?? 'member',
      kind: 'chat' as const,
      body: 'not-valid-sealed-ciphertext',
      ts: 0,
    };
    const forgedSeq = await memberClient.say(forged);
    expect(forgedSeq).toBeGreaterThan(0);

    await member.say('a perfectly normal message');

    const { messages } = await host.listen(0, 3000);
    const bad = messages.find((m) => m.id === forged.id);
    expect(bad).toBeDefined();
    expect(bad!.kind).toBe('chat');
    expect(bad!.text).toBe('[unreadable]');
    expect(messages.some((m) => m.kind === 'chat' && m.text === 'a perfectly normal message')).toBe(
      true,
    );
  });

  it('status() reports openedAt, role, goal, members, pendingInvites, and an increasing lastSeq', async () => {
    const host = new TunnelSession(fakeDeps({}));
    const member = new TunnelSession();
    sessions.push(host, member);

    const before = Date.now();
    const opened = await host.open('measure status', 'alice');
    const hostStatus = host.status();
    expect(hostStatus.role).toBe('host');
    expect(hostStatus.goal).toBe('measure status');
    expect(hostStatus.openedAt).toBeGreaterThanOrEqual(before);
    expect(hostStatus.members).toEqual([{ name: 'alice', isHost: true, connected: true }]);
    expect(hostStatus.pendingInvites).toBe(1);
    expect(hostStatus.lastSeq).toBeGreaterThan(0); // the open() system message
    const seqAfterOpen = hostStatus.lastSeq;

    const joined = await member.join(opened.joinLink!, 'bob');
    expect(joined.goal).toBe('measure status');
    const memberStatus = member.status();
    expect(memberStatus.role).toBe('member');
    expect(memberStatus.goal).toBe('measure status');
    expect(memberStatus.openedAt).toBeGreaterThanOrEqual(before);
    expect(memberStatus.members.some((m) => m.isHost && m.connected)).toBe(true);
    expect(memberStatus.members.some((m) => !m.isHost && m.name === 'bob' && m.connected)).toBe(
      true,
    );

    await host.say('activity bumps lastSeq');
    await waitForHostChat(member, 3000);
    const afterActivity = host.status();
    expect(afterActivity.lastSeq).toBeGreaterThan(seqAfterOpen);
    expect(memberConnected(host)).toBe(true);
    expect(afterActivity.pendingInvites).toBe(0); // the lone invite was redeemed
  });

  it('a member joining after the host has already said something sees it in the join backlog', async () => {
    const host = new TunnelSession(fakeDeps({}));
    const member = new TunnelSession();
    sessions.push(host, member);

    const opened = await host.open('catch-up test', 'alice');
    const early = await host.say('this happened before you joined');

    await member.join(opened.joinLink!, 'bob');

    const backlog = await member.listen(0, 500);
    const seen = backlog.messages.find(
      (m) => m.kind === 'chat' && m.text === 'this happened before you joined',
    );
    expect(seen).toBeDefined();
    expect(seen!.seq).toBe(early.seq);
  });

  it('host share() reads a file, offers it, and reports the audience', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const host = new TunnelSession(fakeDeps({}));
    sessions.push(host);
    await host.open('share test', 'Host');

    const file = path.join(os.tmpdir(), `tunnel-share-${Date.now()}.txt`);
    await fs.writeFile(file, 'hello artifact world');
    const res = await host.share(file);
    expect(res.artifactId).toMatch(/^[0-9a-f]{16}$/);
    expect(res.name).toBe(path.basename(file));
    expect(res.size).toBe(20);
    expect(res.kind).toBe('text');
    expect(res.offeredTo).toBe(0); // no other members yet
    expect(res.olderMembers).toBe(0);

    const { messages } = await host.listen(0, 500);
    expect(messages.some((m) => m.kind === 'artifact')).toBe(true);
    await fs.rm(file, { force: true });
  });

  it('share() rejects an empty file before uploading', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const host = new TunnelSession(fakeDeps({}));
    sessions.push(host);
    await host.open('g', 'Host');
    const file = path.join(os.tmpdir(), `tunnel-empty-${Date.now()}.txt`);
    await fs.writeFile(file, '');
    await expect(host.share(file)).rejects.toThrow('cannot share an empty file');
    await fs.rm(file, { force: true });
  });
});
