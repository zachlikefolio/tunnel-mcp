import { describe, it, expect, afterEach } from 'vitest';
import { HostRelay } from '../src/relay/hostRelay.js';
import { GuestClient } from '../src/relay/guestClient.js';
import { SessionLog } from '../src/log/sessionLog.js';
import { generateKey } from '../src/protocol/crypto.js';
import { generateTunnelId, parseLink, mintLink } from '../src/protocol/link.js';
import { buildChat, decrypt } from '../src/protocol/messages.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

async function setup(goal = 'fix the 401') {
  const key = generateKey();
  const tunnelId = generateTunnelId();
  const hostLog = new SessionLog(tunnelId);
  const relay = new HostRelay({ tunnelId, key, goal, hostName: 'alice' }, hostLog);
  const port = await relay.start();
  const link = parseLink(mintLink(`http://127.0.0.1:${port}`, tunnelId, key));
  const guestLog = new SessionLog(tunnelId + '-guest');
  const guest = new GuestClient(link, 'bob', guestLog);
  cleanups.push(() => {
    guest.close();
    relay.close();
    hostLog.delete();
    guestLog.delete();
  });
  return { key, relay, guest, hostLog, guestLog };
}

describe('relay <-> guest', () => {
  it('guest authenticates, learns the goal, and exchanges encrypted messages', async () => {
    const { key, relay, guest } = await setup();
    const joined = await guest.connect(0);
    expect(joined.goal).toBe('fix the 401');
    expect(joined.peerName).toBe('alice');
    expect(relay.peerConnected).toBe(true);

    // host -> guest
    const incoming = new Promise((res) =>
      guest.once('message', (m) => {
        if (m.kind === 'chat') res(decrypt(m, key).text);
      }),
    );
    relay.submitLocal(buildChat('host', 'whats the error', key));
    expect(await incoming).toBe('whats the error');

    // guest -> host
    const seq = await guest.say(buildChat('guest', 'http 401 on /auth', key));
    expect(seq).toBeGreaterThan(0);
  });

  it('rejects a guest presenting the wrong key', async () => {
    const { relay } = await setup();
    const port = (relay as any).server.address().port;
    const badLink = parseLink(
      mintLink(`http://127.0.0.1:${port}`, (relay as any).opts.tunnelId, generateKey()),
    );
    const badGuest = new GuestClient(badLink, 'mallory', new SessionLog('bad-guest'));
    cleanups.push(() => badGuest.close());
    await expect(badGuest.connect(0)).rejects.toThrow();
  });

  it('a guest say rejects (never hangs) when the relay drops', async () => {
    const { relay, guest, key } = await setup();
    await guest.connect(0);
    await relay.close(); // host gone — no echo will ever come back
    await expect(guest.say(buildChat('guest', 'hi', key))).rejects.toThrow();
  });
});
