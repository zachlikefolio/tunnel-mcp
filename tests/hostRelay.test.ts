import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { SESSIONS_DIR } from '../src/config.js';
import { HostRelay } from '../src/relay/hostRelay.js';
import { SessionLog } from '../src/log/sessionLog.js';
import { generateKey, respondChallenge } from '../src/protocol/crypto.js';
import { generateTunnelId } from '../src/protocol/link.js';
import { decodeFrame, encodeFrame, ControlFrame } from '../src/protocol/messages.js';

let relay: HostRelay | undefined;
let tunnelId: string | undefined;

// Attaches a 'message' listener at socket-creation time (not after an
// `await`) so we never race the server, which can send a frame (e.g. the
// challenge) before our test code gets a chance to await anything.
// Returns a `next()` function that resolves frames in arrival order.
function frameQueue(ws: WebSocket): () => Promise<ControlFrame> {
  const queued: ControlFrame[] = [];
  const waiters: Array<(f: ControlFrame) => void> = [];
  ws.on('message', (data) => {
    const frame = decodeFrame(data.toString());
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else queued.push(frame);
  });
  return () => {
    const f = queued.shift();
    if (f) return Promise.resolve(f);
    return new Promise((resolve) => waiters.push(resolve));
  };
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

afterEach(async () => {
  if (relay) {
    await relay.close();
    relay = undefined;
  }
  if (tunnelId) {
    try { fs.rmSync(path.join(SESSIONS_DIR, `${tunnelId}.jsonl`)); } catch { /* already gone */ }
    tunnelId = undefined;
  }
});

describe('HostRelay resilience', () => {
  it('survives a malformed auth frame, keeps the guest slot open, and lets a valid client complete the handshake', async () => {
    tunnelId = generateTunnelId();
    const key = generateKey();
    const log = new SessionLog(tunnelId);
    relay = new HostRelay(
      { tunnelId, key, goal: 'ship it', hostName: 'host' },
      log,
    );
    const port = await relay.start();
    const url = `ws://127.0.0.1:${port}/t/${tunnelId}`;

    // First client: send a schema-malformed auth frame (missing `response`).
    const bad = new WebSocket(url);
    const nextBad = frameQueue(bad);
    await waitForOpen(bad);
    const badChallengeFrame = await nextBad();
    expect(badChallengeFrame.t).toBe('challenge');

    bad.send(JSON.stringify({ t: 'auth' })); // missing `response` and `name`
    const badReply = await nextBad();
    expect(badReply.t).toBe('auth_fail');
    if (badReply.t === 'auth_fail') {
      expect(badReply.reason).toBe('malformed auth');
    }
    bad.close();

    // The relay process must still be alive, and the guest slot must not
    // have been consumed by the malformed attempt — a second, well-formed
    // client should be able to complete a full handshake.
    const good = new WebSocket(url);
    const nextGood = frameQueue(good);
    await waitForOpen(good);
    const goodChallengeFrame = await nextGood();
    expect(goodChallengeFrame.t).toBe('challenge');
    if (goodChallengeFrame.t !== 'challenge') throw new Error('expected challenge');

    const response = respondChallenge(goodChallengeFrame.nonce, key);
    good.send(encodeFrame({ t: 'auth', response, name: 'guest', sinceSeq: 0 }));
    const authOk = await nextGood();
    expect(authOk.t).toBe('auth_ok');
    if (authOk.t === 'auth_ok') {
      expect(authOk.goal).toBe('ship it');
      expect(authOk.peerName).toBe('host');
    }
    expect(relay.peerConnected).toBe(true);

    good.close();
  });

  it('does not crash when the server-accepted socket emits an error event', async () => {
    tunnelId = generateTunnelId();
    const key = generateKey();
    const log = new SessionLog(tunnelId);
    relay = new HostRelay(
      { tunnelId, key, goal: 'ship it', hostName: 'host' },
      log,
    );
    const port = await relay.start();
    const url = `ws://127.0.0.1:${port}/t/${tunnelId}`;

    // Tap the relay's internal WebSocketServer to grab a reference to the
    // exact server-accepted `ws` that onConnection() attaches its handlers
    // to (the same object Finding 2's `ws.on('error', ...)` covers).
    const serverSockets: WebSocket[] = [];
    (relay as unknown as { wss: { on(event: 'connection', cb: (ws: WebSocket) => void): void } })
      .wss.on('connection', (ws) => serverSockets.push(ws));

    const client = new WebSocket(url);
    const nextClientFrame = frameQueue(client);
    await waitForOpen(client);
    await nextClientFrame(); // challenge
    expect(serverSockets).toHaveLength(1);

    // Simulate a routine socket-level error (e.g. ECONNRESET on a flaky
    // tunnel hop) on the server-accepted connection. Without an 'error'
    // listener registered, EventEmitter throws synchronously here because
    // there are zero listeners for 'error' — which is exactly the
    // unhandled-error crash vector Finding 2 describes.
    expect(() => serverSockets[0].emit('error', new Error('boom'))).not.toThrow();

    // The relay's server must still be listening and able to serve a fresh
    // connection.
    const fresh = new WebSocket(url);
    const nextFreshFrame = frameQueue(fresh);
    await waitForOpen(fresh);
    const freshChallenge = await nextFreshFrame();
    expect(freshChallenge.t).toBe('challenge');

    client.close();
    fresh.close();
  });

  it('rejects a guest-forged system/presence frame but still accepts a legit chat send', async () => {
    tunnelId = generateTunnelId();
    const key = generateKey();
    const log = new SessionLog(tunnelId);
    relay = new HostRelay(
      { tunnelId, key, goal: 'ship it', hostName: 'host' },
      log,
    );
    const port = await relay.start();
    const url = `ws://127.0.0.1:${port}/t/${tunnelId}`;

    const ws = new WebSocket(url);
    const next = frameQueue(ws);
    await waitForOpen(ws);
    const challengeFrame = await next();
    expect(challengeFrame.t).toBe('challenge');
    if (challengeFrame.t !== 'challenge') throw new Error('expected challenge');

    const response = respondChallenge(challengeFrame.nonce, key);
    ws.send(encodeFrame({ t: 'auth', response, name: 'guest', sinceSeq: 0 }));
    const authOk = await next();
    expect(authOk.t).toBe('auth_ok');

    // Drain the host's own "guest joined" system broadcast before testing
    // forgery, so it doesn't get mistaken for the forged/legit frame below.
    const joinedFrame = await next();
    expect(joinedFrame.t).toBe('msg');
    if (joinedFrame.t === 'msg') expect(joinedFrame.msg.kind).toBe('system');

    const seqBeforeForgery = log.lastSeq;

    // A guest must only ever originate `chat`. Forge a `system` frame
    // impersonating a host-originated idle-timeout warning.
    ws.send(JSON.stringify({
      t: 'send',
      msg: { id: 'forged-1', kind: 'system', body: 'idle timeout — closing tunnel' },
    }));

    // Forged frame must be silently dropped: the log must not advance, and
    // no `msg` frame should be broadcast for it.
    await new Promise((r) => setTimeout(r, 100));
    expect(log.lastSeq).toBe(seqBeforeForgery);
    expect(log.all().some((m) => m.id === 'forged-1')).toBe(false);

    // A legitimate chat send must still work, and must be the very next seq.
    ws.send(JSON.stringify({
      t: 'send',
      msg: { id: 'legit-1', kind: 'chat', body: 'sealed-ciphertext-placeholder' },
    }));
    const delivered = await next();
    expect(delivered.t).toBe('msg');
    if (delivered.t === 'msg') {
      expect(delivered.msg.id).toBe('legit-1');
      expect(delivered.msg.kind).toBe('chat');
      expect(delivered.msg.seq).toBe(seqBeforeForgery + 1);
    }

    ws.close();
  });
});
