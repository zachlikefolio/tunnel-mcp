import { describe, it, expect, afterEach } from 'vitest';
import { HostRelay } from '../src/relay/hostRelay.js';
import { GuestClient } from '../src/relay/guestClient.js';
import { SessionLog } from '../src/log/sessionLog.js';
import { generateKey } from '../src/protocol/crypto.js';
import { generateTunnelId, parseLink, mintLink } from '../src/protocol/link.js';
import { buildChat, buildSystem, decrypt } from '../src/protocol/messages.js';

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
  const link = parseLink(mintLink(`http://127.0.0.1:${port}`, tunnelId, key));
  // Independent tunnelId for the guest's own on-disk log so concurrent test
  // files (and the other test cases in this file) can never collide.
  const guestLogId = generateTunnelId();
  const guestLog = new SessionLog(guestLogId);
  const guest = new GuestClient(link, 'bob', guestLog);
  cleanups.push(() => {
    guest.close();
    relay.close();
    hostLog.delete();
    guestLog.delete();
  });
  return { key, relay, guest, hostLog, guestLog };
}

describe('GuestClient', () => {
  it('connect() resolves {goal, peerName} and records pre-existing host messages into the guest log', async () => {
    const { key, relay, guest, guestLog } = await setup('ship the fix');

    // Host produces backlog before the guest ever connects.
    const m1 = relay.submitLocal(buildSystem('host', 'session started'));
    const m2 = relay.submitLocal(buildChat('host', 'whats broken', key));

    const joined = await guest.connect(0);
    expect(joined).toEqual({ goal: 'ship the fix', peerName: 'alice' });

    // The guest log also picks up the host's post-auth "bob joined" system
    // message (a separate 'msg' frame sent right after auth_ok), so assert
    // the pre-existing backlog is present and in order rather than exact.
    const ids = guestLog.since(0).map((m) => m.id);
    const i1 = ids.indexOf(m1.id);
    const i2 = ids.indexOf(m2.id);
    expect(i1).toBeGreaterThanOrEqual(0);
    expect(i2).toBeGreaterThan(i1);

    const chatMsg = guestLog.all().find((m) => m.id === m2.id)!;
    expect(decrypt(chatMsg, key).text).toBe('whats broken');
  });

  it('say() resolves with the host-assigned seq and the sent chat is retrievable/decryptable', async () => {
    const { key, guest, guestLog } = await setup();
    await guest.connect(0);

    const outgoing = buildChat('guest', 'the 401 is on /auth', key);
    const seq = await guest.say(outgoing);
    expect(seq).toBeGreaterThan(0);

    const recorded = guestLog.all().find((m) => m.id === outgoing.id);
    expect(recorded).toBeDefined();
    expect(recorded!.seq).toBe(seq);
    expect(recorded!.from).toBe('guest');
    expect(decrypt(recorded!, key).text).toBe('the 401 is on /auth');
  });

  it('say() rejects with "not connected" before connect() has been called', async () => {
    const { key, guest } = await setup();
    await expect(guest.say(buildChat('guest', 'too early', key))).rejects.toThrow('not connected');
  });

  it('connect(sinceSeq) only backfills messages with seq strictly greater than sinceSeq', async () => {
    const { key, relay, guest, guestLog } = await setup();

    const m1 = relay.submitLocal(buildChat('host', 'first', key));
    const m2 = relay.submitLocal(buildChat('host', 'second', key));
    const m3 = relay.submitLocal(buildChat('host', 'third', key));
    expect(m1.seq).toBeLessThan(m2.seq);
    expect(m2.seq).toBeLessThan(m3.seq);

    await guest.connect(m1.seq);

    // Every message the guest log now holds must postdate m1 (the catch-up
    // boundary); m1 itself must never be backfilled. The host also emits a
    // "bob joined" system message right after auth, so don't assume the
    // backlog is exactly [m2, m3].
    const backlog = guestLog.since(0);
    const ids = backlog.map((m) => m.id);
    expect(ids).not.toContain(m1.id);
    const i2 = ids.indexOf(m2.id);
    const i3 = ids.indexOf(m3.id);
    expect(i2).toBeGreaterThanOrEqual(0);
    expect(i3).toBeGreaterThan(i2);
    expect(backlog.every((m) => m.seq > m1.seq)).toBe(true);
  });

  it('emits a "message" event for a host-sent chat', async () => {
    const { key, relay, guest } = await setup();
    await guest.connect(0);

    // The host broadcasts a "bob joined" system message right after auth_ok,
    // which can arrive before the chat — wait for the chat specifically rather
    // than grabbing the first 'message' event.
    const received = new Promise<{ kind: string; from: string; text: string }>((resolve) => {
      const onMsg = (m: { kind: string; from: string }) => {
        if (m.kind !== 'chat') return;
        guest.off('message', onMsg);
        resolve({ kind: m.kind, from: m.from, text: decrypt(m as never, key).text });
      };
      guest.on('message', onMsg);
    });

    relay.submitLocal(buildChat('host', 'look at the logs', key));
    await expect(received).resolves.toEqual({
      kind: 'chat',
      from: 'host',
      text: 'look at the logs',
    });
  });
});
