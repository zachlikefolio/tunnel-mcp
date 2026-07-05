import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { SESSIONS_DIR, PROTOCOL_VERSION } from '../src/config.js';
import { HostRelay } from '../src/relay/hostRelay.js';
import { SessionLog } from '../src/log/sessionLog.js';
import { generateKey, respondChallenge, generateToken } from '../src/protocol/crypto.js';
import { generateTunnelId } from '../src/protocol/link.js';
import {
  decodeFrame,
  encodeFrame,
  ControlFrame,
  buildSystem,
  buildArtifactMessage,
} from '../src/protocol/messages.js';

const INCOMPATIBLE = 'incompatible client — upgrade: npx -y tunnel-mcp@latest';

let relay: HostRelay | undefined;
let tunnelId: string | undefined;
const sockets: WebSocket[] = [];

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

// Wait for the next frame satisfying `pred`, racing an overall deadline so a
// missing frame surfaces as a test failure instead of a hang.
async function waitFrame(
  next: () => Promise<ControlFrame>,
  pred: (f: ControlFrame) => boolean,
  timeoutMs = 2000,
): Promise<ControlFrame> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('waitFrame timed out');
    const f = await Promise.race([
      next(),
      new Promise<'__t__'>((r) => setTimeout(() => r('__t__'), remaining)),
    ]);
    if (f === '__t__') throw new Error('waitFrame timed out');
    if (pred(f)) return f;
  }
}

function connect(url: string): { ws: WebSocket; next: () => Promise<ControlFrame> } {
  const ws = new WebSocket(url);
  sockets.push(ws);
  return { ws, next: frameQueue(ws) };
}

// Full v2 handshake with a valid minted token; resolves after auth_ok.
async function join(
  url: string,
  key: Uint8Array,
  token: string,
  name: string,
): Promise<{ ws: WebSocket; next: () => Promise<ControlFrame>; selfId: string }> {
  const { ws, next } = connect(url);
  await waitForOpen(ws);
  const challenge = await next();
  if (challenge.t !== 'challenge') throw new Error('expected challenge');
  ws.send(
    encodeFrame({
      t: 'auth',
      response: respondChallenge(challenge.nonce, key),
      name,
      sinceSeq: 0,
      token,
      protocolVersion: PROTOCOL_VERSION,
    }),
  );
  const ok = await next();
  if (ok.t !== 'auth_ok') throw new Error(`expected auth_ok, got ${ok.t}`);
  return { ws, next, selfId: ok.selfId };
}

afterEach(async () => {
  for (const s of sockets) {
    try {
      s.close();
    } catch {
      /* already gone */
    }
  }
  sockets.length = 0;
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

async function makeRelay(opts: { joinTtlMs?: number } = {}): Promise<{
  key: Uint8Array;
  log: SessionLog;
  url: string;
}> {
  tunnelId = generateTunnelId();
  const key = generateKey();
  const log = new SessionLog(tunnelId);
  relay = new HostRelay({ tunnelId, key, goal: 'ship it', hostName: 'host', ...opts }, log);
  const port = await relay.start();
  return { key, log, url: `ws://127.0.0.1:${port}/t/${tunnelId}` };
}

describe('HostRelay resilience', () => {
  it('survives a malformed auth frame, then admits a valid member with a fresh token', async () => {
    const { key, url } = await makeRelay();

    // A well-versioned but schema-malformed auth (no response/name) → malformed.
    const bad = connect(url);
    await waitForOpen(bad.ws);
    expect((await bad.next()).t).toBe('challenge');
    bad.ws.send(
      JSON.stringify({ t: 'auth', token: 'anything', protocolVersion: PROTOCOL_VERSION }),
    );
    const badReply = await bad.next();
    expect(badReply.t).toBe('auth_fail');
    if (badReply.t === 'auth_fail') expect(badReply.reason).toBe('malformed auth');
    bad.ws.close();

    // The relay is still alive; a fresh, well-formed member completes the flow.
    const token = relay!.mintInvites(1)[0].token;
    const { next } = await join(url, key, token, 'guest');
    const roster = relay!.rosterEntries();
    expect(roster.some((r) => r.isHost && r.name === 'host')).toBe(true);
    expect(roster.some((r) => !r.isHost && r.name === 'guest')).toBe(true);
    expect(relay!.connectedMembers()).toBe(1);
    // The new member receives its own "guest joined" system broadcast.
    const joined = await waitFrame(next, (f) => f.t === 'msg');
    if (joined.t === 'msg') expect(joined.msg.kind).toBe('system');
  });

  it('does not crash when the server-accepted socket emits an error event', async () => {
    const { url } = await makeRelay();

    const serverSockets: WebSocket[] = [];
    (
      relay as unknown as { wss: { on(event: 'connection', cb: (ws: WebSocket) => void): void } }
    ).wss.on('connection', (ws) => serverSockets.push(ws));

    const client = connect(url);
    await waitForOpen(client.ws);
    await client.next(); // challenge
    expect(serverSockets).toHaveLength(1);

    expect(() => serverSockets[0].emit('error', new Error('boom'))).not.toThrow();

    const fresh = connect(url);
    await waitForOpen(fresh.ws);
    expect((await fresh.next()).t).toBe('challenge');
  });

  it('rejects a member-forged system/presence frame but still accepts a legit chat send', async () => {
    const { key, log, url } = await makeRelay();
    const token = relay!.mintInvites(1)[0].token;
    const { ws, next } = await join(url, key, token, 'guest');
    await waitFrame(next, (f) => f.t === 'msg'); // drain "guest joined"

    const seqBeforeForgery = log.lastSeq;

    // Members may only originate `chat`. Forge a `system` frame.
    ws.send(
      JSON.stringify({
        t: 'send',
        msg: { id: 'forged-1', kind: 'system', body: 'idle timeout — closing tunnel' },
      }),
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(log.lastSeq).toBe(seqBeforeForgery);
    expect(log.all().some((m) => m.id === 'forged-1')).toBe(false);

    // A legitimate chat send is delivered (fanout includes the sender).
    ws.send(
      JSON.stringify({
        t: 'send',
        msg: { id: 'legit-1', kind: 'chat', body: 'sealed-ciphertext-placeholder' },
      }),
    );
    const delivered = await waitFrame(next, (f) => f.t === 'msg' && f.msg.id === 'legit-1');
    if (delivered.t === 'msg') {
      expect(delivered.msg.kind).toBe('chat');
      expect(delivered.msg.seq).toBe(seqBeforeForgery + 1);
    }
  });

  it('ignores a member send frame whose msg is missing id or body', async () => {
    const { key, log, url } = await makeRelay();
    const token = relay!.mintInvites(1)[0].token;
    const { ws, next } = await join(url, key, token, 'guest');
    await waitFrame(next, (f) => f.t === 'msg'); // drain "guest joined"

    const seqBefore = log.lastSeq;
    ws.send(JSON.stringify({ t: 'send', msg: { kind: 'chat', body: 'no id here' } }));
    ws.send(JSON.stringify({ t: 'send', msg: { id: 'no-body-1', kind: 'chat' } }));

    const raced = await Promise.race([
      next().then((f) => ({ arrived: true as const, frame: f })),
      new Promise<{ arrived: false }>((resolve) =>
        setTimeout(() => resolve({ arrived: false }), 100),
      ),
    ]);
    expect(raced.arrived).toBe(false);
    expect(log.lastSeq).toBe(seqBefore);
    expect(log.all().some((m) => m.id === 'no-body-1')).toBe(false);
  });

  it('treats a missing sinceSeq on auth as 0, returning the full backlog', async () => {
    const { key, log, url } = await makeRelay();
    relay!.submitLocal(buildSystem(relay!.hostId, 'seed message one'));
    relay!.submitLocal(buildSystem(relay!.hostId, 'seed message two'));
    expect(log.lastSeq).toBe(2);

    const token = relay!.mintInvites(1)[0].token;
    const { ws, next } = connect(url);
    await waitForOpen(ws);
    const challenge = await next();
    if (challenge.t !== 'challenge') throw new Error('expected challenge');
    // sinceSeq deliberately omitted.
    ws.send(
      JSON.stringify({
        t: 'auth',
        response: respondChallenge(challenge.nonce, key),
        name: 'guest',
        token,
        protocolVersion: PROTOCOL_VERSION,
      }),
    );
    const authOk = await next();
    expect(authOk.t).toBe('auth_ok');
    if (authOk.t === 'auth_ok') {
      expect(authOk.backlog.map((m) => m.body)).toEqual(['seed message one', 'seed message two']);
    }
  });

  it('treats a non-numeric sinceSeq on auth as 0, returning the full backlog', async () => {
    const { key, log, url } = await makeRelay();
    relay!.submitLocal(buildSystem(relay!.hostId, 'seed message one'));
    relay!.submitLocal(buildSystem(relay!.hostId, 'seed message two'));
    expect(log.lastSeq).toBe(2);

    const token = relay!.mintInvites(1)[0].token;
    const { ws, next } = connect(url);
    await waitForOpen(ws);
    const challenge = await next();
    if (challenge.t !== 'challenge') throw new Error('expected challenge');
    ws.send(
      JSON.stringify({
        t: 'auth',
        response: respondChallenge(challenge.nonce, key),
        name: 'guest',
        sinceSeq: 'not-a-number',
        token,
        protocolVersion: PROTOCOL_VERSION,
      }),
    );
    const authOk = await next();
    expect(authOk.t).toBe('auth_ok');
    if (authOk.t === 'auth_ok') {
      expect(authOk.backlog.map((m) => m.body)).toEqual(['seed message one', 'seed message two']);
    }
  });

  it('reports peerConnected as false before the handshake and true after auth_ok', async () => {
    const { key, url } = await makeRelay();
    expect(relay!.peerConnected).toBe(false);

    const token = relay!.mintInvites(1)[0].token;
    const { ws, next } = connect(url);
    await waitForOpen(ws);
    const challenge = await next();
    if (challenge.t !== 'challenge') throw new Error('expected challenge');
    expect(relay!.peerConnected).toBe(false); // socket up, not authed

    ws.send(
      encodeFrame({
        t: 'auth',
        response: respondChallenge(challenge.nonce, key),
        name: 'guest',
        sinceSeq: 0,
        token,
        protocolVersion: PROTOCOL_VERSION,
      }),
    );
    expect((await next()).t).toBe('auth_ok');
    expect(relay!.peerConnected).toBe(true);
  });
});

describe('HostRelay invite tokens', () => {
  it('rejects an auth with no token / wrong protocol version as incompatible', async () => {
    const { key, url } = await makeRelay();
    const { ws, next } = connect(url);
    await waitForOpen(ws);
    const challenge = await next();
    if (challenge.t !== 'challenge') throw new Error('expected challenge');
    // No token, no protocolVersion — a v1 client.
    ws.send(
      JSON.stringify({
        t: 'auth',
        response: respondChallenge(challenge.nonce, key),
        name: 'old-client',
        sinceSeq: 0,
      }),
    );
    const reply = await next();
    expect(reply.t).toBe('auth_fail');
    if (reply.t === 'auth_fail') expect(reply.reason).toBe(INCOMPATIBLE);
  });

  it('rejects a reused token with "invite already used"', async () => {
    const { key, url } = await makeRelay();
    const token = relay!.mintInvites(1)[0].token;
    await join(url, key, token, 'first'); // consumes the token

    const { ws, next } = connect(url);
    await waitForOpen(ws);
    const challenge = await next();
    if (challenge.t !== 'challenge') throw new Error('expected challenge');
    ws.send(
      encodeFrame({
        t: 'auth',
        response: respondChallenge(challenge.nonce, key),
        name: 'second',
        sinceSeq: 0,
        token,
        protocolVersion: PROTOCOL_VERSION,
      }),
    );
    const reply = await next();
    expect(reply.t).toBe('auth_fail');
    if (reply.t === 'auth_fail') expect(reply.reason).toBe('invite already used');
  });

  it('rejects an expired token with "invite expired"', async () => {
    const { key, url } = await makeRelay({ joinTtlMs: 20 });
    const token = relay!.mintInvites(1)[0].token; // minted before the sleep
    await new Promise((r) => setTimeout(r, 60)); // let the 20ms window lapse

    const { ws, next } = connect(url);
    await waitForOpen(ws);
    const challenge = await next();
    if (challenge.t !== 'challenge') throw new Error('expected challenge');
    ws.send(
      encodeFrame({
        t: 'auth',
        response: respondChallenge(challenge.nonce, key),
        name: 'late',
        sinceSeq: 0,
        token,
        protocolVersion: PROTOCOL_VERSION,
      }),
    );
    const reply = await next();
    expect(reply.t).toBe('auth_fail');
    if (reply.t === 'auth_fail') expect(reply.reason).toBe('invite expired');
    expect(relay!.peerConnected).toBe(false);
  });

  it('rejects an unknown (never-minted) token with "invalid invite"', async () => {
    const { key, url } = await makeRelay();
    const { ws, next } = connect(url);
    await waitForOpen(ws);
    const challenge = await next();
    if (challenge.t !== 'challenge') throw new Error('expected challenge');
    ws.send(
      encodeFrame({
        t: 'auth',
        response: respondChallenge(challenge.nonce, key),
        name: 'stranger',
        sinceSeq: 0,
        token: generateToken(), // valid shape, never minted
        protocolVersion: PROTOCOL_VERSION,
      }),
    );
    const reply = await next();
    expect(reply.t).toBe('auth_fail');
    if (reply.t === 'auth_fail') expect(reply.reason).toBe('invalid invite');
  });

  it('two sockets racing one token: exactly one admitted, the loser gets "invite already used"', async () => {
    const { key, url } = await makeRelay();
    const token = relay!.mintInvites(1)[0].token;

    // Connect both sockets and drain their challenges up front, so the only
    // thing left to race is the redeem step inside onAuth.
    async function connectAndChallenge(
      name: string,
    ): Promise<{ ws: WebSocket; next: () => Promise<ControlFrame>; nonce: string; name: string }> {
      const { ws, next } = connect(url);
      await waitForOpen(ws);
      const challenge = await next();
      if (challenge.t !== 'challenge') throw new Error('expected challenge');
      return { ws, next, nonce: challenge.nonce, name };
    }

    async function authWith(c: Awaited<ReturnType<typeof connectAndChallenge>>): Promise<string> {
      c.ws.send(
        encodeFrame({
          t: 'auth',
          response: respondChallenge(c.nonce, key),
          name: c.name,
          sinceSeq: 0,
          token,
          protocolVersion: PROTOCOL_VERSION,
        }),
      );
      const reply = await c.next();
      if (reply.t === 'auth_ok') return 'ok';
      if (reply.t === 'auth_fail') return reply.reason;
      throw new Error(`unexpected frame ${reply.t}`);
    }

    const [a, b] = await Promise.all([
      connectAndChallenge('racer-a'),
      connectAndChallenge('racer-b'),
    ]);
    const [ra, rb] = await Promise.all([authWith(a), authWith(b)]);

    const oks = [ra, rb].filter((r) => r === 'ok');
    const fails = [ra, rb].filter((r) => r === 'invite already used');
    expect(oks).toHaveLength(1);
    expect(fails).toHaveLength(1);
  });

  it('mintInvites over the remaining seats throws', () => {
    const key = generateKey();
    const id = generateTunnelId();
    const log = new SessionLog(id);
    const r = new HostRelay({ tunnelId: id, key, goal: 'g', hostName: 'host' }, log);
    // 16 members max including the host → at most 15 mintable seats.
    expect(() => r.mintInvites(16)).toThrow(/seat\(s\) remaining/);
    log.delete();
  });
});

describe('HostRelay rooms', () => {
  it('admits three members and fans chats + roster frames out to everyone', async () => {
    const { key, url } = await makeRelay();
    const [t1, t2, t3] = relay!.mintInvites(3).map((i) => i.token);

    const m1 = await join(url, key, t1, 'm1');
    const m2 = await join(url, key, t2, 'm2');
    // m1 learns about m2 via a roster frame (broadcast excludes the newcomer).
    const rosterAtM1 = await waitFrame(m1.next, (f) => f.t === 'roster');
    if (rosterAtM1.t === 'roster') {
      expect(rosterAtM1.members.map((r) => r.name).sort()).toEqual(['host', 'm1', 'm2']);
    }
    const m3 = await join(url, key, t3, 'm3');

    expect(relay!.connectedMembers()).toBe(3);
    expect(relay!.rosterEntries()).toHaveLength(4); // host + 3

    // A chat from m1 reaches m2 and m3 (and echoes back to m1).
    m1.ws.send(
      JSON.stringify({ t: 'send', msg: { id: 'hello-1', kind: 'chat', body: 'ciphertext' } }),
    );
    for (const m of [m1, m2, m3]) {
      const got = await waitFrame(m.next, (f) => f.t === 'msg' && f.msg.id === 'hello-1');
      if (got.t === 'msg') expect(got.msg.kind).toBe('chat');
    }
  });

  it('denies the 16th member with "room at capacity" (capacity is checked before redeem)', async () => {
    const { key, url } = await makeRelay();
    // Admit 15 members, minting one token each.
    for (let i = 0; i < 15; i++) {
      const token = relay!.mintInvites(1)[0].token;
      await join(url, key, token, `m${i}`);
    }
    expect(relay!.connectedMembers()).toBe(15);

    // The 16th presents an unminted token: capacity denies before redeem is even
    // reached, so a full room never burns a token.
    const { ws, next } = connect(url);
    await waitForOpen(ws);
    const challenge = await next();
    if (challenge.t !== 'challenge') throw new Error('expected challenge');
    ws.send(
      encodeFrame({
        t: 'auth',
        response: respondChallenge(challenge.nonce, key),
        name: 'sixteenth',
        sinceSeq: 0,
        token: generateToken(),
        protocolVersion: PROTOCOL_VERSION,
      }),
    );
    const reply = await next();
    expect(reply.t).toBe('auth_fail');
    if (reply.t === 'auth_fail') expect(reply.reason).toBe('room at capacity');
  });

  it('retains departed members in the roster as connected:false', async () => {
    const { key, url } = await makeRelay();
    const token = relay!.mintInvites(1)[0].token;
    const { ws } = await join(url, key, token, 'leaver');
    expect(relay!.connectedMembers()).toBe(1);

    ws.close();
    const deadline = Date.now() + 2000;
    while (relay!.connectedMembers() > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(relay!.connectedMembers()).toBe(0);
    const entry = relay!.rosterEntries().find((r) => r.name === 'leaver');
    expect(entry).toBeDefined();
    expect(entry!.connected).toBe(false); // roster RETAINS departed members
  });
});

describe('HostRelay artifact-message delivery + v2 compat', () => {
  // Auth a raw socket at an arbitrary protocolVersion; resolve after auth_ok.
  async function joinAt(
    url: string,
    key: Uint8Array,
    token: string,
    name: string,
    protocolVersion: number,
  ): Promise<{ ws: WebSocket; next: () => Promise<ControlFrame> }> {
    const { ws, next } = connect(url);
    await waitForOpen(ws);
    const challenge = await next();
    if (challenge.t !== 'challenge') throw new Error('expected challenge');
    ws.send(
      encodeFrame({
        t: 'auth',
        response: respondChallenge(challenge.nonce, key),
        name,
        sinceSeq: 0,
        token,
        protocolVersion,
      }),
    );
    const ok = await next();
    if (ok.t !== 'auth_ok') throw new Error(`expected auth_ok, got ${ok.t}`);
    return { ws, next };
  }

  // Same handshake, but returns the auth_ok frame itself (so callers can
  // inspect .backlog) instead of discarding it.
  async function joinAtWithAuthOk(
    url: string,
    key: Uint8Array,
    token: string,
    name: string,
    protocolVersion: number,
  ): Promise<{
    ws: WebSocket;
    next: () => Promise<ControlFrame>;
    authOk: Extract<ControlFrame, { t: 'auth_ok' }>;
  }> {
    const { ws, next } = connect(url);
    await waitForOpen(ws);
    const challenge = await next();
    if (challenge.t !== 'challenge') throw new Error('expected challenge');
    ws.send(
      encodeFrame({
        t: 'auth',
        response: respondChallenge(challenge.nonce, key),
        name,
        sinceSeq: 0,
        token,
        protocolVersion,
      }),
    );
    const ok = await next();
    if (ok.t !== 'auth_ok') throw new Error(`expected auth_ok, got ${ok.t}`);
    return { ws, next, authOk: ok };
  }

  it('still admits a v2 (protocolVersion 2) client against a v3 host', async () => {
    const { key, url } = await makeRelay();
    const token = relay!.mintInvites(1)[0].token;
    const m = await joinAt(url, key, token, 'legacy', 2);
    expect(relay!.connectedMembers()).toBe(1);
    // drain the "legacy joined" system message
    const sys = await waitFrame(m.next, (f) => f.t === 'msg');
    if (sys.t === 'msg') expect(sys.msg.kind).toBe('system');
  });

  it('delivers an artifact message to a v3 member but never to a v2 member (live)', async () => {
    const { key, url } = await makeRelay();
    const [t2, t3] = relay!.mintInvites(2).map((i) => i.token);
    const v2 = await joinAt(url, key, t2, 'old', 2);
    const v3 = await joinAt(url, key, t3, 'new', 3);

    const offer = {
      id: 'art-live',
      name: 'f.bin',
      kind: 'binary' as const,
      size: 5,
      sha256: 'abc',
      from: relay!.hostId,
    };
    relay!.submitLocal(buildArtifactMessage(relay!.hostId, offer));

    // v3 receives the artifact msg…
    const got = await waitFrame(v3.next, (f) => f.t === 'msg' && f.msg.kind === 'artifact');
    if (got.t === 'msg') expect(JSON.parse(got.msg.body).id).toBe('art-live');

    // …and the v2 member never does (only its own chat echo would arrive; here none).
    const raced = await Promise.race([
      v2.next().then((f) => ({ arrived: true as const, frame: f })),
      new Promise<{ arrived: false }>((r) => setTimeout(() => r({ arrived: false }), 150)),
    ]);
    if (raced.arrived) expect(raced.frame.t === 'msg' && raced.frame.msg.kind).not.toBe('artifact');
    else expect(raced.arrived).toBe(false);
  });

  it('excludes artifact messages from a v2 late-joiner backlog but includes them for v3', async () => {
    const { key, url } = await makeRelay();
    relay!.submitLocal(
      buildArtifactMessage(relay!.hostId, {
        id: 'art-backlog',
        name: 'f',
        kind: 'text',
        size: 3,
        sha256: 'x',
        from: relay!.hostId,
      }),
    );

    const [t2, t3] = relay!.mintInvites(2).map((i) => i.token);
    const { authOk: okV2 } = await joinAtWithAuthOk(url, key, t2, 'old', 2);
    expect(okV2.backlog.some((m) => m.kind === 'artifact')).toBe(false);

    const { authOk: okV3 } = await joinAtWithAuthOk(url, key, t3, 'new', 3);
    expect(okV3.backlog.some((m) => m.kind === 'artifact')).toBe(true);
  });
});
