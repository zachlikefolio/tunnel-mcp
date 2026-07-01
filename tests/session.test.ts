import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SESSIONS_DIR } from '../src/config.js';
import { TunnelSession } from '../src/session.js';
import { newId } from '../src/protocol/messages.js';
import { GuestClient } from '../src/relay/guestClient.js';

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
// so host and guest connect over loopback with no network or real binary.
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
// the backlog and miss the in-flight chat).
async function waitForHostChat(s: TunnelSession, deadlineMs = 3000) {
  const stop = Date.now() + deadlineMs;
  let since = 0;
  while (Date.now() < stop) {
    const { messages } = await s.listen(since, stop - Date.now());
    for (const m of messages) since = Math.max(since, m.seq);
    const c = messages.find((m) => m.kind === 'chat' && m.from === 'host');
    if (c) return c;
  }
  throw new Error('timed out waiting for host chat');
}

describe('TunnelSession (host <-> guest, fake cloudflared)', () => {
  it('opens, joins, exchanges a turn, and tears down', async () => {
    const cap: { port?: number } = {};
    const host = new TunnelSession(fakeDeps(cap));
    const guest = new TunnelSession();
    sessions.push(host, guest);

    const opened = await host.open('fix the 401', 'alice');
    expect(opened.joinLink).toContain('/t/');

    const joined = await guest.join(opened.joinLink, 'bob');
    expect(joined.goal).toBe('fix the 401');
    expect(joined.peer).toBe('alice');

    // host says -> guest listens (wait past the backlog for the actual chat)
    await host.say('whats the error?');
    const chat = await waitForHostChat(guest, 3000);
    expect(chat.text).toBe('whats the error?');

    // guest says -> host listens
    const sent = await guest.say('http 401 on /auth');
    expect(sent.seq).toBeGreaterThan(0);
    const hostHeard = await host.listen(chat.seq, 3000);
    expect(
      hostHeard.messages.some((m) => m.kind === 'chat' && m.text === 'http 401 on /auth'),
    ).toBe(true);

    expect(host.status().peerConnected).toBe(true);
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

  it('a leaked join link cannot be reused — a second guest is rejected (single-use)', async () => {
    const host = new TunnelSession(fakeDeps({}));
    const guest1 = new TunnelSession();
    const guest2 = new TunnelSession();
    sessions.push(host, guest1, guest2);

    const opened = await host.open('goal', 'alice');
    await guest1.join(opened.joinLink, 'bob'); // consumes the single-use link
    await guest1.close();

    // Wait for the host relay to observe guest1's disconnect (slot free again).
    const deadline = Date.now() + 2000;
    while (host.status().peerConnected && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // Anyone who later obtains the same link cannot join.
    await expect(guest2.join(opened.joinLink, 'mallory')).rejects.toThrow(/already used/i);
  });

  it('open() reports the join-link expiry window (default 10 minutes)', async () => {
    const host = new TunnelSession(fakeDeps({}));
    sessions.push(host);
    const opened = await host.open('goal', 'alice');
    expect(opened.joinLinkExpiresInSec).toBe(600);
  });

  it('an expired join link is rejected end-to-end', async () => {
    const host = new TunnelSession({
      ensureCloudflared: async () => 'fake',
      startCloudflared: async (_b: string, port: number) => ({
        publicUrl: `http://127.0.0.1:${port}`,
        stop() {},
      }),
      joinTtlMs: 20, // window lapses before the guest joins
    });
    const guest = new TunnelSession();
    sessions.push(host, guest);

    const opened = await host.open('goal', 'alice');
    await new Promise((r) => setTimeout(r, 60));
    await expect(guest.join(opened.joinLink, 'bob')).rejects.toThrow(/expired/i);
  });

  it('listen() and say() throw a clean error after close() instead of crashing', async () => {
    const host = new TunnelSession(fakeDeps({}));
    sessions.push(host);
    await host.open('goal', 'alice');
    await host.close('done');

    // close() clears role/source but historically left log/key set, so a
    // post-close listen() fell through to `(this.source as
    // EventEmitter).on(...)` with source === undefined and threw a raw
    // TypeError instead of a clean domain error.
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

  it('decrypt-totality: a forged/malformed chat body from the untrusted guest surfaces as [unreadable] instead of throwing or poisoning the batch', async () => {
    const host = new TunnelSession(fakeDeps({}));
    const guest = new TunnelSession();
    sessions.push(host, guest);

    const opened = await host.open('goal', 'alice');
    await guest.join(opened.joinLink, 'bob');

    // Reach past the public API's buildChat() (which always produces valid
    // ciphertext) straight to the guest's underlying GuestClient.say(), so we
    // can send a 'send' frame whose body is NOT valid sealed ciphertext. The
    // relay's frame-shape check only requires kind === 'chat' and a string
    // body, so this forged frame is accepted and relayed to the host exactly
    // like a malicious/buggy peer's payload would be.
    const guestClient = (guest as unknown as { guest: GuestClient }).guest;
    expect(guestClient).toBeInstanceOf(GuestClient);
    const forged = {
      id: newId(),
      seq: -1,
      from: 'guest' as const,
      kind: 'chat' as const,
      body: 'not-valid-sealed-ciphertext',
      ts: 0,
    };
    const forgedSeq = await guestClient.say(forged);
    expect(forgedSeq).toBeGreaterThan(0);

    // Also send a legitimate chat right after so we can prove the batch as a
    // whole is unaffected by the bad message.
    await guest.say('a perfectly normal message');

    const { messages } = await host.listen(0, 3000);
    const bad = messages.find((m) => m.id === forged.id);
    expect(bad).toBeDefined();
    expect(bad!.kind).toBe('chat');
    expect(bad!.text).toBe('[unreadable]');
    expect(messages.some((m) => m.kind === 'chat' && m.text === 'a perfectly normal message')).toBe(
      true,
    );
  });

  it('status() reports openedAt, role, goal, and an increasing lastSeq as activity occurs', async () => {
    const host = new TunnelSession(fakeDeps({}));
    const guest = new TunnelSession();
    sessions.push(host, guest);

    const before = Date.now();
    const opened = await host.open('measure status', 'alice');
    const hostStatus = host.status();
    expect(hostStatus.role).toBe('host');
    expect(hostStatus.goal).toBe('measure status');
    expect(hostStatus.openedAt).toBeGreaterThanOrEqual(before);
    expect(hostStatus.peerConnected).toBe(false);
    expect(hostStatus.lastSeq).toBeGreaterThan(0); // the open() system message
    const seqAfterOpen = hostStatus.lastSeq;

    const joined = await guest.join(opened.joinLink, 'bob');
    expect(joined.goal).toBe('measure status');
    const guestStatus = guest.status();
    expect(guestStatus.role).toBe('guest');
    expect(guestStatus.goal).toBe('measure status');
    expect(guestStatus.openedAt).toBeGreaterThanOrEqual(before);
    expect(guestStatus.peerConnected).toBe(true);

    await host.say('activity bumps lastSeq');
    await waitForHostChat(guest, 3000);
    const afterActivity = host.status();
    expect(afterActivity.lastSeq).toBeGreaterThan(seqAfterOpen);
    expect(afterActivity.peerConnected).toBe(true);
  });

  it('a guest joining after the host has already said something sees it in the join backlog', async () => {
    const host = new TunnelSession(fakeDeps({}));
    const guest = new TunnelSession();
    sessions.push(host, guest);

    const opened = await host.open('catch-up test', 'alice');
    const early = await host.say('this happened before you joined');

    await guest.join(opened.joinLink, 'bob');

    // The backlog is delivered synchronously during auth_ok and recorded into
    // the guest's local log before join() resolves, so listen(0) must return
    // it immediately without waiting on a live 'message' event.
    const backlog = await guest.listen(0, 500);
    const seen = backlog.messages.find(
      (m) => m.kind === 'chat' && m.text === 'this happened before you joined',
    );
    expect(seen).toBeDefined();
    expect(seen!.seq).toBe(early.seq);
  });
});
