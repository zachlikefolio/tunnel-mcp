import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { SESSIONS_DIR } from '../src/config.js';
import { HostRelay } from '../src/relay/hostRelay.js';
import { SessionLog } from '../src/log/sessionLog.js';
import { generateKey, respondChallenge } from '../src/protocol/crypto.js';
import { generateTunnelId } from '../src/protocol/link.js';
import { decodeFrame, encodeFrame, ControlFrame, buildSystem } from '../src/protocol/messages.js';

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
    try {
      fs.rmSync(path.join(SESSIONS_DIR, `${tunnelId}.jsonl`));
    } catch {
      /* already gone */
    }
    tunnelId = undefined;
  }
});

describe('HostRelay resilience', () => {
  it('survives a malformed auth frame, keeps the guest slot open, and lets a valid client complete the handshake', async () => {
    tunnelId = generateTunnelId();
    const key = generateKey();
    const log = new SessionLog(tunnelId);
    relay = new HostRelay({ tunnelId, key, goal: 'ship it', hostName: 'host' }, log);
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
    relay = new HostRelay({ tunnelId, key, goal: 'ship it', hostName: 'host' }, log);
    const port = await relay.start();
    const url = `ws://127.0.0.1:${port}/t/${tunnelId}`;

    // Tap the relay's internal WebSocketServer to grab a reference to the
    // exact server-accepted `ws` that onConnection() attaches its handlers
    // to (the same object Finding 2's `ws.on('error', ...)` covers).
    const serverSockets: WebSocket[] = [];
    (
      relay as unknown as { wss: { on(event: 'connection', cb: (ws: WebSocket) => void): void } }
    ).wss.on('connection', (ws) => serverSockets.push(ws));

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
    relay = new HostRelay({ tunnelId, key, goal: 'ship it', hostName: 'host' }, log);
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
    ws.send(
      JSON.stringify({
        t: 'send',
        msg: { id: 'forged-1', kind: 'system', body: 'idle timeout — closing tunnel' },
      }),
    );

    // Forged frame must be silently dropped: the log must not advance, and
    // no `msg` frame should be broadcast for it.
    await new Promise((r) => setTimeout(r, 100));
    expect(log.lastSeq).toBe(seqBeforeForgery);
    expect(log.all().some((m) => m.id === 'forged-1')).toBe(false);

    // A legitimate chat send must still work, and must be the very next seq.
    ws.send(
      JSON.stringify({
        t: 'send',
        msg: { id: 'legit-1', kind: 'chat', body: 'sealed-ciphertext-placeholder' },
      }),
    );
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

describe('HostRelay contract', () => {
  it('suppresses the "guest left" system message during teardown', async () => {
    tunnelId = generateTunnelId();
    const key = generateKey();
    const log = new SessionLog(tunnelId);
    relay = new HostRelay({ tunnelId, key, goal: 'ship it', hostName: 'host' }, log);
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
    const joined = await next(); // drain the "guest joined" system broadcast
    expect(joined.t).toBe('msg');

    expect(relay.peerConnected).toBe(true);
    const seqBeforeTeardown = log.lastSeq;

    // close() terminates the guest socket directly, which fires the
    // socket's 'close' handler on the server side. The !tearingDown guard
    // there must suppress the "left" system message this time (unlike an
    // ordinary disconnect, which does append one — see the ordinary-close
    // behavior implied by the guard itself).
    await relay.close();
    relay = undefined; // already closed here; avoid a double-close in afterEach

    // Give the terminated socket's 'close' callback a moment to run, in
    // case it fires asynchronously after the close() promise resolves.
    await new Promise((r) => setTimeout(r, 50));

    expect(log.lastSeq).toBe(seqBeforeTeardown);
    expect(log.all().some((m) => m.body.includes('left'))).toBe(false);
  });

  it('rejects a second concurrent guest with auth_fail "tunnel full" while the first stays connected', async () => {
    tunnelId = generateTunnelId();
    const key = generateKey();
    const log = new SessionLog(tunnelId);
    relay = new HostRelay({ tunnelId, key, goal: 'ship it', hostName: 'host' }, log);
    const port = await relay.start();
    const url = `ws://127.0.0.1:${port}/t/${tunnelId}`;

    const first = new WebSocket(url);
    const nextFirst = frameQueue(first);
    await waitForOpen(first);
    const firstChallenge = await nextFirst();
    expect(firstChallenge.t).toBe('challenge');
    if (firstChallenge.t !== 'challenge') throw new Error('expected challenge');
    first.send(
      encodeFrame({
        t: 'auth',
        response: respondChallenge(firstChallenge.nonce, key),
        name: 'first-guest',
        sinceSeq: 0,
      }),
    );
    const firstAuthOk = await nextFirst();
    expect(firstAuthOk.t).toBe('auth_ok');
    await nextFirst(); // drain "first-guest joined"
    expect(relay.peerConnected).toBe(true);

    const second = new WebSocket(url);
    const nextSecond = frameQueue(second);
    await waitForOpen(second);
    const secondChallenge = await nextSecond();
    expect(secondChallenge.t).toBe('challenge');
    if (secondChallenge.t !== 'challenge') throw new Error('expected challenge');
    second.send(
      encodeFrame({
        t: 'auth',
        response: respondChallenge(secondChallenge.nonce, key),
        name: 'second-guest',
        sinceSeq: 0,
      }),
    );
    const secondReply = await nextSecond();
    expect(secondReply.t).toBe('auth_fail');
    if (secondReply.t === 'auth_fail') expect(secondReply.reason).toBe('tunnel full');

    // The single-guest lock must not have disturbed the first guest's slot.
    expect(relay.peerConnected).toBe(true);

    first.close();
    second.close();
  });

  it('makes the join link single-use — a second join after the first guest disconnects is rejected as already used', async () => {
    tunnelId = generateTunnelId();
    const key = generateKey();
    const log = new SessionLog(tunnelId);
    relay = new HostRelay({ tunnelId, key, goal: 'ship it', hostName: 'host' }, log);
    const port = await relay.start();
    const url = `ws://127.0.0.1:${port}/t/${tunnelId}`;

    // First guest authenticates (consuming the single-use link), then leaves.
    const first = new WebSocket(url);
    const nextFirst = frameQueue(first);
    await waitForOpen(first);
    const firstChallenge = await nextFirst();
    if (firstChallenge.t !== 'challenge') throw new Error('expected challenge');
    first.send(
      encodeFrame({
        t: 'auth',
        response: respondChallenge(firstChallenge.nonce, key),
        name: 'g1',
        sinceSeq: 0,
      }),
    );
    expect((await nextFirst()).t).toBe('auth_ok');
    first.close();

    // Wait until the relay has observed the disconnect: the slot is free again,
    // but the link has already been consumed.
    const deadline = Date.now() + 2000;
    while (relay.peerConnected && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(relay.peerConnected).toBe(false);

    // A brand-new client presenting the SAME valid key must still be rejected —
    // the leaked link can no longer be used, even though nobody is connected.
    const second = new WebSocket(url);
    const nextSecond = frameQueue(second);
    await waitForOpen(second);
    const secondChallenge = await nextSecond();
    if (secondChallenge.t !== 'challenge') throw new Error('expected challenge');
    second.send(
      encodeFrame({
        t: 'auth',
        response: respondChallenge(secondChallenge.nonce, key),
        name: 'g2',
        sinceSeq: 0,
      }),
    );
    const reply = await nextSecond();
    expect(reply.t).toBe('auth_fail');
    if (reply.t === 'auth_fail') expect(reply.reason).toBe('join link already used');

    first.close();
    second.close();
  });

  it('rejects a join after the join link has expired (TTL elapsed)', async () => {
    tunnelId = generateTunnelId();
    const key = generateKey();
    const log = new SessionLog(tunnelId);
    // Tiny join-link TTL so the window lapses before the guest even connects.
    relay = new HostRelay({ tunnelId, key, goal: 'ship it', hostName: 'host', joinTtlMs: 20 }, log);
    const port = await relay.start();
    const url = `ws://127.0.0.1:${port}/t/${tunnelId}`;

    await new Promise((r) => setTimeout(r, 60)); // let the 20ms window elapse

    const ws = new WebSocket(url);
    const next = frameQueue(ws);
    await waitForOpen(ws);
    const challenge = await next();
    if (challenge.t !== 'challenge') throw new Error('expected challenge');
    ws.send(
      encodeFrame({
        t: 'auth',
        response: respondChallenge(challenge.nonce, key),
        name: 'late',
        sinceSeq: 0,
      }),
    );
    const reply = await next();
    expect(reply.t).toBe('auth_fail');
    if (reply.t === 'auth_fail') expect(reply.reason).toBe('join link expired');
    expect(relay.peerConnected).toBe(false);

    ws.close();
  });

  it('ignores a guest send frame whose msg is missing id or body', async () => {
    tunnelId = generateTunnelId();
    const key = generateKey();
    const log = new SessionLog(tunnelId);
    relay = new HostRelay({ tunnelId, key, goal: 'ship it', hostName: 'host' }, log);
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
    await next(); // drain "guest joined"

    const seqBefore = log.lastSeq;

    // Missing `id`.
    ws.send(JSON.stringify({ t: 'send', msg: { kind: 'chat', body: 'no id here' } }));
    // Missing `body`.
    ws.send(JSON.stringify({ t: 'send', msg: { id: 'no-body-1', kind: 'chat' } }));

    // No reply frame should ever arrive for either forged send; assert
    // silence by racing a short timer against the frame queue.
    const raced = await Promise.race([
      next().then((f) => ({ arrived: true as const, frame: f })),
      new Promise<{ arrived: false }>((resolve) =>
        setTimeout(() => resolve({ arrived: false }), 100),
      ),
    ]);
    expect(raced.arrived).toBe(false);

    expect(log.lastSeq).toBe(seqBefore);
    expect(log.all().some((m) => m.id === 'no-body-1')).toBe(false);

    ws.close();
  });

  it('treats a missing sinceSeq on auth as 0, returning the full backlog', async () => {
    tunnelId = generateTunnelId();
    const key = generateKey();
    const log = new SessionLog(tunnelId);
    relay = new HostRelay({ tunnelId, key, goal: 'ship it', hostName: 'host' }, log);
    const port = await relay.start();
    const url = `ws://127.0.0.1:${port}/t/${tunnelId}`;

    relay.submitLocal(buildSystem('host', 'seed message one'));
    relay.submitLocal(buildSystem('host', 'seed message two'));
    expect(log.lastSeq).toBe(2);

    const ws = new WebSocket(url);
    const next = frameQueue(ws);
    await waitForOpen(ws);
    const challengeFrame = await next();
    expect(challengeFrame.t).toBe('challenge');
    if (challengeFrame.t !== 'challenge') throw new Error('expected challenge');

    const response = respondChallenge(challengeFrame.nonce, key);
    // `sinceSeq` deliberately omitted entirely — bypass the ControlFrame
    // type to simulate an untrusted/older client that never sends it.
    ws.send(JSON.stringify({ t: 'auth', response, name: 'guest' }));
    const authOk = await next();
    expect(authOk.t).toBe('auth_ok');
    if (authOk.t === 'auth_ok') {
      expect(authOk.backlog.map((m) => m.body)).toEqual(['seed message one', 'seed message two']);
    }

    ws.close();
  });

  it('treats a non-numeric sinceSeq on auth as 0, returning the full backlog', async () => {
    tunnelId = generateTunnelId();
    const key = generateKey();
    const log = new SessionLog(tunnelId);
    relay = new HostRelay({ tunnelId, key, goal: 'ship it', hostName: 'host' }, log);
    const port = await relay.start();
    const url = `ws://127.0.0.1:${port}/t/${tunnelId}`;

    relay.submitLocal(buildSystem('host', 'seed message one'));
    relay.submitLocal(buildSystem('host', 'seed message two'));
    expect(log.lastSeq).toBe(2);

    const ws = new WebSocket(url);
    const next = frameQueue(ws);
    await waitForOpen(ws);
    const challengeFrame = await next();
    expect(challengeFrame.t).toBe('challenge');
    if (challengeFrame.t !== 'challenge') throw new Error('expected challenge');

    const response = respondChallenge(challengeFrame.nonce, key);
    // `sinceSeq` is a string, not a finite number — a forged/buggy client
    // input Number.isFinite() must reject.
    ws.send(JSON.stringify({ t: 'auth', response, name: 'guest', sinceSeq: 'not-a-number' }));
    const authOk = await next();
    expect(authOk.t).toBe('auth_ok');
    if (authOk.t === 'auth_ok') {
      expect(authOk.backlog.map((m) => m.body)).toEqual(['seed message one', 'seed message two']);
    }

    ws.close();
  });

  it('reports peerConnected as false before the handshake and true immediately after auth_ok', async () => {
    tunnelId = generateTunnelId();
    const key = generateKey();
    const log = new SessionLog(tunnelId);
    relay = new HostRelay({ tunnelId, key, goal: 'ship it', hostName: 'host' }, log);
    const port = await relay.start();
    const url = `ws://127.0.0.1:${port}/t/${tunnelId}`;

    expect(relay.peerConnected).toBe(false);

    const ws = new WebSocket(url);
    const next = frameQueue(ws);
    await waitForOpen(ws);
    const challengeFrame = await next();
    expect(challengeFrame.t).toBe('challenge');
    if (challengeFrame.t !== 'challenge') throw new Error('expected challenge');

    // Connected at the socket level but not yet authenticated: must still
    // read as false.
    expect(relay.peerConnected).toBe(false);

    const response = respondChallenge(challengeFrame.nonce, key);
    ws.send(encodeFrame({ t: 'auth', response, name: 'guest', sinceSeq: 0 }));
    const authOk = await next();
    expect(authOk.t).toBe('auth_ok');
    expect(relay.peerConnected).toBe(true);

    ws.close();
  });
});
