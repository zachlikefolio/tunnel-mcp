import { describe, it, expect, afterEach } from 'vitest';
import { HostRelay } from '../src/relay/hostRelay.js';
import { MemberClient } from '../src/relay/memberClient.js';
import { SessionLog } from '../src/log/sessionLog.js';
import { generateKey, generateToken } from '../src/protocol/crypto.js';
import { generateTunnelId, parseLink, mintInvite } from '../src/protocol/link.js';
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
  const { token } = relay.mintInvites(1)[0];
  const link = parseLink(mintInvite(`http://127.0.0.1:${port}`, tunnelId, key, token));
  const memberLog = new SessionLog(tunnelId + '-member');
  const member = new MemberClient(link, 'bob', memberLog);
  cleanups.push(() => {
    member.close();
    relay.close();
    hostLog.delete();
    memberLog.delete();
  });
  return { key, relay, member, hostLog, memberLog, port, tunnelId };
}

describe('relay <-> member', () => {
  it('member authenticates, learns the goal + roster, and exchanges encrypted messages', async () => {
    const { key, relay, member } = await setup();
    const joined = await member.connect(0);
    expect(joined.goal).toBe('fix the 401');
    expect(joined.roster.find((r) => r.isHost)?.name).toBe('alice');
    expect(relay.peerConnected).toBe(true);

    // host -> member
    const incoming = new Promise((res) =>
      member.once('message', (m) => {
        if (m.kind === 'chat') res(decrypt(m, key).text);
      }),
    );
    relay.submitLocal(buildChat(relay.hostId, 'whats the error', key));
    expect(await incoming).toBe('whats the error');

    // member -> host
    const seq = await member.say(buildChat(member.selfId!, 'http 401 on /auth', key));
    expect(seq).toBeGreaterThan(0);
  });

  it('rejects a member presenting the wrong key', async () => {
    const { relay } = await setup();
    const port = (relay as any).server.address().port;
    const badLink = parseLink(
      mintInvite(
        `http://127.0.0.1:${port}`,
        (relay as any).opts.tunnelId,
        generateKey(),
        generateToken(),
      ),
    );
    const badMember = new MemberClient(badLink, 'mallory', new SessionLog('bad-member'));
    cleanups.push(() => badMember.close());
    await expect(badMember.connect(0)).rejects.toThrow();
  });

  it('a member say rejects (never hangs) when the relay drops', async () => {
    const { relay, member, key } = await setup();
    await member.connect(0);
    await relay.close(); // host gone — no echo will ever come back
    await expect(member.say(buildChat(member.selfId!, 'hi', key))).rejects.toThrow();
  });
});
