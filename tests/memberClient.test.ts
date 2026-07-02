import { describe, it, expect, afterEach } from 'vitest';
import { HostRelay } from '../src/relay/hostRelay.js';
import { MemberClient } from '../src/relay/memberClient.js';
import { SessionLog } from '../src/log/sessionLog.js';
import { generateKey, generateToken } from '../src/protocol/crypto.js';
import { generateTunnelId, parseLink, mintInvite } from '../src/protocol/link.js';
import { buildChat, buildSystem, decrypt, RosterEntry } from '../src/protocol/messages.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

async function setup(goal = 'debug the flaky test') {
  const key = generateKey();
  const tunnelId = generateTunnelId();
  const hostLog = new SessionLog(tunnelId);
  const relay = new HostRelay({ tunnelId, key, goal, hostName: 'alice' }, hostLog);
  const port = await relay.start();
  const base = `http://127.0.0.1:${port}`;

  const mkMember = (name: string): MemberClient => {
    const { token } = relay.mintInvites(1)[0];
    const link = parseLink(mintInvite(base, tunnelId, key, token));
    const memberLog = new SessionLog(generateTunnelId());
    const member = new MemberClient(link, name, memberLog);
    cleanups.push(() => {
      member.close();
      memberLog.delete();
    });
    return member;
  };

  const memberLog = new SessionLog(generateTunnelId());
  const { token } = relay.mintInvites(1)[0];
  const link = parseLink(mintInvite(base, tunnelId, key, token));
  const member = new MemberClient(link, 'bob', memberLog);
  cleanups.push(() => {
    member.close();
    relay.close();
    hostLog.delete();
    memberLog.delete();
  });
  return { key, relay, member, memberLog, hostId: relay.hostId, base, tunnelId, port, mkMember };
}

describe('MemberClient', () => {
  it('connect() resolves {goal, selfId, roster} and records pre-existing host messages', async () => {
    const { key, relay, member, memberLog, hostId } = await setup('ship the fix');

    const m1 = relay.submitLocal(buildSystem(hostId, 'session started'));
    const m2 = relay.submitLocal(buildChat(hostId, 'whats broken', key));

    const joined = await member.connect(0);
    expect(joined.goal).toBe('ship the fix');
    expect(typeof joined.selfId).toBe('string');
    expect(joined.roster.some((r) => r.isHost && r.name === 'alice')).toBe(true);
    expect(joined.roster.some((r) => !r.isHost && r.name === 'bob' && r.id === joined.selfId)).toBe(
      true,
    );
    expect(member.selfId).toBe(joined.selfId);

    const ids = memberLog.since(0).map((m) => m.id);
    const i1 = ids.indexOf(m1.id);
    const i2 = ids.indexOf(m2.id);
    expect(i1).toBeGreaterThanOrEqual(0);
    expect(i2).toBeGreaterThan(i1);

    const chatMsg = memberLog.all().find((m) => m.id === m2.id)!;
    expect(decrypt(chatMsg, key).text).toBe('whats broken');
  });

  it('roster() is exposed after connect()', async () => {
    const { member } = await setup();
    await member.connect(0);
    const roster = member.roster();
    expect(roster).toHaveLength(2);
    expect(roster.find((r) => r.isHost)?.name).toBe('alice');
    expect(roster.find((r) => !r.isHost)?.name).toBe('bob');
  });

  it('a roster frame (a second member joining) updates roster() and emits "roster"', async () => {
    const { member, mkMember } = await setup();
    await member.connect(0);
    expect(member.roster()).toHaveLength(2);

    const rosterEvent = new Promise<RosterEntry[]>((resolve) => member.once('roster', resolve));
    const second = mkMember('carol');
    await second.connect(0);

    const members = await rosterEvent;
    expect(members.map((r) => r.name).sort()).toEqual(['alice', 'bob', 'carol']);
    expect(
      member
        .roster()
        .map((r) => r.name)
        .sort(),
    ).toEqual(['alice', 'bob', 'carol']);
  });

  it('say() resolves with the host-assigned seq and the sent chat is retrievable/decryptable', async () => {
    const { key, member, memberLog } = await setup();
    await member.connect(0);

    const outgoing = buildChat(member.selfId!, 'the 401 is on /auth', key);
    const seq = await member.say(outgoing);
    expect(seq).toBeGreaterThan(0);

    const recorded = memberLog.all().find((m) => m.id === outgoing.id);
    expect(recorded).toBeDefined();
    expect(recorded!.seq).toBe(seq);
    expect(recorded!.from).toBe(member.selfId);
    expect(decrypt(recorded!, key).text).toBe('the 401 is on /auth');
  });

  it('say() rejects with "not connected" before connect() has been called', async () => {
    const { key, member } = await setup();
    await expect(member.say(buildChat('member', 'too early', key))).rejects.toThrow(
      'not connected',
    );
  });

  it('connect(sinceSeq) only backfills messages with seq strictly greater than sinceSeq', async () => {
    const { key, relay, member, memberLog, hostId } = await setup();

    const m1 = relay.submitLocal(buildChat(hostId, 'first', key));
    const m2 = relay.submitLocal(buildChat(hostId, 'second', key));
    const m3 = relay.submitLocal(buildChat(hostId, 'third', key));
    expect(m1.seq).toBeLessThan(m2.seq);
    expect(m2.seq).toBeLessThan(m3.seq);

    await member.connect(m1.seq);

    const backlog = memberLog.since(0);
    const ids = backlog.map((m) => m.id);
    expect(ids).not.toContain(m1.id);
    const i2 = ids.indexOf(m2.id);
    const i3 = ids.indexOf(m3.id);
    expect(i2).toBeGreaterThanOrEqual(0);
    expect(i3).toBeGreaterThan(i2);
    expect(backlog.every((m) => m.seq > m1.seq)).toBe(true);
  });

  it('rejects within the handshake bound instead of hanging when the URL is a TCP black hole', async () => {
    const net = await import('node:net');
    const server = net.createServer(() => {
      /* accept the TCP connection, never speak HTTP */
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    cleanups.push(() => server.close());

    const link = parseLink(
      mintInvite(`http://127.0.0.1:${port}`, generateTunnelId(), generateKey(), generateToken()),
    );
    const memberLog = new SessionLog(generateTunnelId());
    const member = new MemberClient(link, 'bob', memberLog, {
      handshakeTimeoutMs: 150,
      connectDeadlineMs: 5000,
    });
    cleanups.push(() => {
      member.close();
      memberLog.delete();
    });

    const start = Date.now();
    await expect(member.connect(0)).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(3000);
  });

  it('rejects on the overall connect deadline when the server upgrades but never sends a challenge', async () => {
    const { WebSocketServer } = await import('ws');
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    const port = (wss.address() as { port: number }).port;
    wss.on('connection', () => {
      /* accept the WS, never send a challenge */
    });
    cleanups.push(() => wss.close());

    const link = parseLink(
      mintInvite(`http://127.0.0.1:${port}`, generateTunnelId(), generateKey(), generateToken()),
    );
    const memberLog = new SessionLog(generateTunnelId());
    const member = new MemberClient(link, 'bob', memberLog, {
      handshakeTimeoutMs: 2000,
      connectDeadlineMs: 200,
    });
    cleanups.push(() => {
      member.close();
      memberLog.delete();
    });

    await expect(member.connect(0)).rejects.toThrow(/timed out establishing tunnel/);
  });

  it('a custom lookup returning an IP still sends Host = hostname (Cloudflare routing intact)', async () => {
    const { WebSocketServer } = await import('ws');
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    const port = (wss.address() as { port: number }).port;
    const gotHost = new Promise<string>((resolve) => {
      wss.on('connection', (_ws, req) => resolve(req.headers.host ?? ''));
    });
    cleanups.push(() => wss.close());

    const link = parseLink(
      mintInvite(
        `http://fake-tunnel.trycloudflare.com:${port}`,
        generateTunnelId(),
        generateKey(),
        generateToken(),
      ),
    );
    const memberLog = new SessionLog(generateTunnelId());
    const member = new MemberClient(link, 'bob', memberLog, {
      lookup: (
        _h: string,
        o: { all?: boolean } | undefined,
        cb: (e: null, a: unknown, f?: number) => void,
      ) =>
        o && o.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4),
      connectDeadlineMs: 2000,
      handshakeTimeoutMs: 2000,
    });
    cleanups.push(() => {
      member.close();
      memberLog.delete();
    });
    member.connect(0).catch(() => {}); // never auths (no challenge) — we only need the Host header

    expect(await gotHost).toBe(`fake-tunnel.trycloudflare.com:${port}`);
  });

  it('does not crash on a malformed auth_ok (missing roster) from an untrusted host', async () => {
    const { WebSocketServer } = await import('ws');
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    const port = (wss.address() as { port: number }).port;
    // Send a structurally-invalid auth_ok with no `roster` / `backlog`.
    // Without the handler guard, `frame.roster.map(...)` throws uncaught.
    wss.on('connection', (sock) =>
      sock.send(JSON.stringify({ t: 'auth_ok', goal: 'x', selfId: 'y' })),
    );
    cleanups.push(() => wss.close());

    const link = parseLink(
      mintInvite(`http://127.0.0.1:${port}`, generateTunnelId(), generateKey(), generateToken()),
    );
    const memberLog = new SessionLog(generateTunnelId());
    const member = new MemberClient(link, 'bob', memberLog, {
      handshakeTimeoutMs: 2000,
      connectDeadlineMs: 250,
    });
    cleanups.push(() => {
      member.close();
      memberLog.delete();
    });

    await expect(member.connect(0)).rejects.toThrow(/timed out establishing tunnel/);
  });

  it('emits a "message" event for a host-sent chat', async () => {
    const { key, relay, member, hostId } = await setup();
    await member.connect(0);

    const received = new Promise<{ kind: string; from: string; text: string }>((resolve) => {
      const onMsg = (m: { kind: string; from: string }) => {
        if (m.kind !== 'chat') return;
        member.off('message', onMsg);
        resolve({ kind: m.kind, from: m.from, text: decrypt(m as never, key).text });
      };
      member.on('message', onMsg);
    });

    relay.submitLocal(buildChat(hostId, 'look at the logs', key));
    await expect(received).resolves.toEqual({
      kind: 'chat',
      from: hostId,
      text: 'look at the logs',
    });
  });
});
