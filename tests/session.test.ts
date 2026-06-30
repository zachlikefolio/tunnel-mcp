import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SESSIONS_DIR } from '../src/config.js';
import { TunnelSession } from '../src/session.js';

const sessions: TunnelSession[] = [];
afterEach(async () => { for (const s of sessions) { try { await s.close(); } catch {} } sessions.length = 0; });

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
    expect(hostHeard.messages.some((m) => m.kind === 'chat' && m.text === 'http 401 on /auth')).toBe(true);

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

  it('fails cleanly with a readable error after exhausting retries', async () => {
    let calls = 0;
    const host = new TunnelSession({
      ensureCloudflared: async () => 'fake',
      startCloudflared: async () => { calls++; throw new Error('boom'); },
    });
    sessions.push(host);
    await expect(host.open('goal', 'alice')).rejects.toThrow(/after 3 attempts/);
    expect(calls).toBe(3);
    expect(host.isOpen).toBe(false);
  });
});
