import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { decodeFrame, decrypt } from '../src/protocol/messages.js';
import type { WireMessage } from '../src/protocol/messages.js';
import { parseLink, mintInvite, generateTunnelId } from '../src/protocol/link.js';
import { generateKey, keyToBase64url, generateToken } from '../src/protocol/crypto.js';
import { MemberClient } from '../src/relay/memberClient.js';
import { SessionLog } from '../src/log/sessionLog.js';

// Property-based fuzzing of the three decoders that consume UNTRUSTED input: a
// peer's chat ciphertext (decrypt), a relay control frame (decodeFrame), and a
// human-pasted join link (parseLink). The invariant for all three: adversarial
// input must never crash the process — they either return a safe/well-formed
// value or throw a catchable Error, never anything a caller would blindly trust.
const key = generateKey();

describe('fuzz: untrusted-input decoders', () => {
  it('decrypt is total — any chat body yields a string, never a throw', () => {
    fc.assert(
      fc.property(fc.string(), fc.constantFrom('host', 'guest'), (body, from) => {
        const msg: WireMessage = {
          id: 'x',
          seq: 0,
          from: from as WireMessage['from'],
          kind: 'chat',
          body,
          ts: 0,
        };
        return typeof decrypt(msg, key).text === 'string';
      }),
      { numRuns: 2000 },
    );
  });

  it('decodeFrame either throws or returns a frame object with a string `t` (no value that crashes `frame.t`)', () => {
    const check = (s: string): boolean => {
      try {
        const f = decodeFrame(s) as unknown;
        return (
          f !== null &&
          typeof f === 'object' &&
          !Array.isArray(f) &&
          typeof (f as { t?: unknown }).t === 'string'
        );
      } catch {
        return true; // every caller wraps decodeFrame in try/catch, so a throw is safe
      }
    };
    // Arbitrary strings AND arbitrary valid-JSON strings (which explores null,
    // primitives, arrays, and objects — the case a blind `as ControlFrame` misses).
    fc.assert(fc.property(fc.string(), check), { numRuns: 2000 });
    fc.assert(fc.property(fc.json(), check), { numRuns: 2000 });
  });

  it('parseLink either throws or returns a valid JoinLink with a 32-byte key', () => {
    const check = (s: string): boolean => {
      try {
        const l = parseLink(s);
        return (
          /^[0-9a-f]+$/.test(l.tunnelId) &&
          l.key instanceof Uint8Array &&
          l.key.length === 32 &&
          typeof l.wsUrl === 'string'
        );
      } catch {
        return true;
      }
    };
    fc.assert(fc.property(fc.string(), check), { numRuns: 2000 });
    // Structurally-plausible (but fuzzed) links, to exercise the deep parse path.
    const linkish = fc
      .tuple(
        fc.constantFrom('ws', 'wss', 'http', 'https', 'ftp', ''),
        fc.string(),
        fc.string(),
        fc.string(),
      )
      .map(([scheme, host, tid, k]) => `${scheme}://${host}/t/${tid}#${k}`);
    fc.assert(fc.property(linkish, check), { numRuns: 2000 });

    // Genuinely VALID links (real 32-byte key + token + hex tunnel id over a fuzzed
    // host), so parseLink MUST return and the success-branch invariants actually run
    // — a regression that returned a non-32-byte key or non-hex id would fail here.
    const validLink = fc
      .tuple(
        fc.domain(),
        fc.uint8Array({ minLength: 1, maxLength: 12 }).map((b) => Buffer.from(b).toString('hex')),
      )
      .map(
        ([host, tid]) =>
          `wss://${host}/t/${tid}#${keyToBase64url(generateKey())}.${generateToken()}`,
      );
    fc.assert(
      fc.property(validLink, (s) => {
        const l = parseLink(s); // must NOT throw for a well-formed link
        return (
          l.key.length === 32 && /^[0-9a-f]+$/.test(l.tunnelId) && l.wsUrl.startsWith('wss://')
        );
      }),
      { numRuns: 500 },
    );

    // v2 valid-link generator asserting the success path with tokens
    const validInvite = fc
      .tuple(
        fc.domain(),
        fc.uint8Array({ minLength: 1, maxLength: 12 }).map((b) => Buffer.from(b).toString('hex')),
      )
      .map(
        ([host, tid]) =>
          `wss://${host}/t/${tid}#${keyToBase64url(generateKey())}.${generateToken()}`,
      );
    fc.assert(
      fc.property(validInvite, (s) => {
        const l = parseLink(s);
        return l.key.length === 32 && typeof l.token === 'string' && l.token.length > 0;
      }),
      { numRuns: 500 },
    );
  });

  it('a minted link always round-trips back to the same tunnel id and key', () => {
    fc.assert(
      fc.property(
        fc.domain().map((d) => `https://${d}`),
        (base) => {
          const k = generateKey();
          const tid = generateTunnelId();
          const parsed = parseLink(mintInvite(base, tid, k, generateToken()));
          return parsed.tunnelId === tid && keyToBase64url(parsed.key) === keyToBase64url(k);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('fuzz: v2 untrusted frames', () => {
  // decodeFrame's only guarantee is "object with string t" — it does not, and
  // cannot, guarantee anything about the other fields. The real crash-safety
  // boundary for a malformed roster/auth_ok/msg frame is the try/catch that
  // wraps MemberClient's whole ws.on('message') handler (src/relay/memberClient.ts).
  // So this fuzzes THAT path: a fake (untrusted) host WebSocketServer speaks a
  // real challenge/auth_ok handshake to fully connect a real MemberClient, then
  // fires a barrage of malformed roster/msg/junk frames at it, then proves the
  // handler loop is still alive by sending one final well-formed `msg` frame and
  // asserting the client still receives it.
  it('a barrage of malformed roster/msg/junk frames from an untrusted host never crashes the member, which keeps processing valid frames afterward', async () => {
    const { WebSocketServer } = await import('ws');
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolveListen) => wss.once('listening', () => resolveListen()));
    const port = (wss.address() as { port: number }).port;

    const hostId = 'aabbccddeeff0011';
    const selfId = 'deadbeefcafebabe';

    let hostSock: import('ws').WebSocket | undefined;
    wss.on('connection', (sock) => {
      hostSock = sock;
      // Speak a real handshake: challenge -> (client answers with `auth`) -> auth_ok.
      // The token/response are never checked by this fake server — it just needs
      // to complete the handshake shape so the real MemberClient fully connects.
      sock.send(JSON.stringify({ t: 'challenge', nonce: 'fuzz-nonce' }));
      sock.once('message', () => {
        sock.send(
          JSON.stringify({
            t: 'auth_ok',
            goal: 'fuzz the handler',
            selfId,
            roster: [
              { id: selfId, name: 'bob', isHost: false, connected: true },
              { id: hostId, name: 'alice', isHost: true, connected: true },
            ],
            backlog: [],
          }),
        );
      });
    });

    const link = parseLink(
      mintInvite(`http://127.0.0.1:${port}`, generateTunnelId(), generateKey(), generateToken()),
    );
    const memberLog = new SessionLog(generateTunnelId());
    const member = new MemberClient(link, 'bob', memberLog, {
      handshakeTimeoutMs: 2000,
      connectDeadlineMs: 3000,
    });

    try {
      await member.connect(0);
      if (!hostSock) throw new Error('test bug: host never saw the connection');

      // roster frames with a garbage `members` field (non-arrays, null, objects,
      // arrays-of-garbage) — exercises `frame.members.map(...)`.
      const rosterGarbage = fc.record({
        t: fc.constant('roster'),
        members: fc.anything(),
      });
      // msg frames with a garbage `msg` field — exercises `this.log.record(frame.msg)`
      // and `frame.msg.id`.
      const msgGarbage = fc.record({
        t: fc.constant('msg'),
        msg: fc.anything(),
      });
      // arbitrary t-valid junk across every known frame shape, garbage fields.
      const junkFrame = fc.record(
        {
          t: fc.constantFrom('roster', 'auth_ok', 'msg', 'challenge', 'auth_fail', 'send'),
          members: fc.anything(),
          roster: fc.anything(),
          selfId: fc.anything(),
          goal: fc.anything(),
          backlog: fc.anything(),
          msg: fc.anything(),
          nonce: fc.anything(),
          reason: fc.anything(),
          response: fc.anything(),
        },
        { requiredKeys: ['t'] },
      );

      // fc.assert's property runner doesn't mix well with an async socket in the
      // loop body, so sample a deterministic, bounded batch and fire it directly.
      const payloads = fc.sample(fc.oneof(rosterGarbage, msgGarbage, junkFrame), {
        numRuns: 150,
        seed: 20260701,
      });
      for (const p of payloads) hostSock.send(JSON.stringify(p));

      // The final, well-formed frame. Matched by id (not just "any message"),
      // since some garbage `msg` payloads above are shaped enough to also emit a
      // 'message' event without throwing.
      const finalMsg: WireMessage = {
        id: 'fuzz-final-msg-id',
        seq: 999,
        from: hostId,
        kind: 'system',
        body: 'still alive',
        ts: Date.now(),
      };
      const received = new Promise<WireMessage>((resolve) => {
        member.on('message', (m: WireMessage) => {
          if (m && m.id === finalMsg.id) resolve(m);
        });
      });
      hostSock.send(JSON.stringify({ t: 'msg', msg: finalMsg }));

      const got = await received;
      expect(got.id).toBe(finalMsg.id);
      expect(got.body).toBe('still alive');
    } finally {
      member.close();
      wss.close();
      memberLog.delete();
    }
  }, 5000);
});

describe('fuzz: artifact frames through the real relay + member handlers', () => {
  // Garbage payloads covering every artifact-related frame shape, with every
  // field (including `t`'s siblings) fuzzed to arbitrary JSON values — non-array
  // seq, huge/negative numbers, wrong types, missing fields. Shared shape used
  // against both the relay (untrusted member) and the member (untrusted host).
  const artifactGarbage = () =>
    fc.record(
      {
        t: fc.constantFrom(
          'share_begin',
          'share_chunk',
          'share_end',
          'fetch',
          'fetch_chunk',
          'error',
        ),
        artifactId: fc.anything(),
        name: fc.anything(),
        kind: fc.anything(),
        size: fc.anything(),
        sha256: fc.anything(),
        chunkCount: fc.anything(),
        seq: fc.anything(),
        data: fc.anything(),
        last: fc.anything(),
        code: fc.anything(),
        message: fc.anything(),
      },
      { requiredKeys: ['t'] },
    );

  it('a barrage of malformed share/fetch/chunk frames never crashes the relay; a valid chat still flows', async () => {
    const { HostRelay } = await import('../src/relay/hostRelay.js');
    const { MemberClient: MC } = await import('../src/relay/memberClient.js');
    const {
      generateTunnelId: genTid,
      parseLink: pl,
      mintInvite: mi,
    } = await import('../src/protocol/link.js');

    const key = generateKey();
    const tunnelId = genTid();
    const hostLog = new SessionLog(tunnelId);
    const relay = new HostRelay({ tunnelId, key, goal: 'fuzz', hostName: 'host' }, hostLog);
    const port = await relay.start();
    const base = `http://127.0.0.1:${port}`;

    const mk = async (name: string) => {
      const { token } = relay.mintInvites(1)[0];
      const link = pl(mi(base, tunnelId, key, token));
      const log = new SessionLog(genTid());
      const m = new MC(link, name, log);
      await m.connect(0);
      return { m, log };
    };

    const sender = await mk('sender');
    const watcher = await mk('watcher');
    try {
      // Fire malformed share_*/fetch/fetch_chunk/error frames straight at the relay
      // socket (reach into the client's ws) — the whole-handler try/catch must hold.
      const raw = (sender.m as unknown as { ws: import('ws').WebSocket }).ws;
      const garbage = fc.sample(artifactGarbage(), { numRuns: 200, seed: 20260705 });
      for (const g of garbage) raw.send(JSON.stringify(g));

      // The relay is still alive: a legit chat from the watcher reaches the sender.
      const { buildChat } = await import('../src/protocol/messages.js');
      const seen = new Promise<string>((resolve) => {
        sender.m.on('message', (msg: WireMessage) => {
          if (msg.kind === 'chat') resolve(msg.id);
        });
      });
      const outgoing = buildChat(watcher.m.selfId!, 'still alive', key);
      await watcher.m.say(outgoing);
      expect(await seen).toBeDefined();
    } finally {
      sender.m.close();
      watcher.m.close();
      await relay.close();
      hostLog.delete();
      sender.log.delete();
      watcher.log.delete();
    }
  }, 8000);

  it('a barrage of malformed artifact frames from an untrusted host never crashes the member; a valid message still arrives after', async () => {
    const { WebSocketServer } = await import('ws');
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolveListen) => wss.once('listening', () => resolveListen()));
    const port = (wss.address() as { port: number }).port;

    const hostId = 'aabbccddeeff0011';
    const selfId = 'deadbeefcafebabe';

    let hostSock: import('ws').WebSocket | undefined;
    wss.on('connection', (sock) => {
      hostSock = sock;
      sock.send(JSON.stringify({ t: 'challenge', nonce: 'fuzz-artifact-nonce' }));
      sock.once('message', () => {
        sock.send(
          JSON.stringify({
            t: 'auth_ok',
            goal: 'fuzz artifacts',
            selfId,
            roster: [
              { id: selfId, name: 'bob', isHost: false, connected: true },
              { id: hostId, name: 'alice', isHost: true, connected: true },
            ],
            backlog: [],
          }),
        );
      });
    });

    const link = parseLink(
      mintInvite(`http://127.0.0.1:${port}`, generateTunnelId(), generateKey(), generateToken()),
    );
    const memberLog = new SessionLog(generateTunnelId());
    const member = new MemberClient(link, 'bob', memberLog, {
      handshakeTimeoutMs: 2000,
      connectDeadlineMs: 3000,
    });

    try {
      await member.connect(0);
      if (!hostSock) throw new Error('test bug: host never saw the connection');

      const payloads = fc.sample(artifactGarbage(), { numRuns: 150, seed: 20260702 });
      for (const p of payloads) hostSock.send(JSON.stringify(p));

      // The member's handler loop is still alive: a final well-formed frame
      // still arrives after the barrage.
      const finalMsg: WireMessage = {
        id: 'fuzz-artifact-final-msg-id',
        seq: 999,
        from: hostId,
        kind: 'system',
        body: 'artifact handler still alive',
        ts: Date.now(),
      };
      const received = new Promise<WireMessage>((resolve) => {
        member.on('message', (m: WireMessage) => {
          if (m && m.id === finalMsg.id) resolve(m);
        });
      });
      hostSock.send(JSON.stringify({ t: 'msg', msg: finalMsg }));

      const got = await received;
      expect(got.id).toBe(finalMsg.id);
      expect(got.body).toBe('artifact handler still alive');
    } finally {
      member.close();
      wss.close();
      memberLog.delete();
    }
  }, 5000);

  it('negative / oversized seq and chunkCount are rejected by the store, never buffered', async () => {
    const { ArtifactStore } = await import('../src/relay/artifactStore.js');
    const s = new ArtifactStore({
      maxArtifactBytes: 1000,
      maxMemberBytes: 1000,
      maxRoomBytes: 1000,
      ttlMs: 1000,
    });
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (size, chunkCount) => {
        const r = s.begin(
          `id-${size}-${chunkCount}`,
          { name: 'f', kind: 'binary', size, sha256: 'x', chunkCount },
          'm',
        );
        // Only a positive, in-cap size with a positive chunkCount may be accepted.
        if (r === 'ok') return size >= 1 && size <= 1000 && chunkCount >= 1;
        return true;
      }),
      { numRuns: 500 },
    );
    fc.assert(
      fc.property(fc.integer(), (seq) => {
        // size:4 legitimately allows only chunkCount:1 (ceil(4/ARTIFACT_CHUNK_BYTES)
        // === 1), so the only in-range seq is 0.
        s.begin(
          'putfuzz',
          { name: 'f', kind: 'binary', size: 4, sha256: 'x', chunkCount: 1 },
          'm2',
        );
        const r = s.putChunk('putfuzz', seq, 'data');
        s.evict('putfuzz');
        return r === 'ok' ? seq === 0 : true;
      }),
      { numRuns: 500 },
    );
  });

  it('a tampered ciphertext chunk fails the receiver post-decrypt hash check (codec-level)', async () => {
    const { chunkAndSeal, reassembleAndVerify } = await import('../src/protocol/artifact.js');
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const { chunks, sha256 } = chunkAndSeal(bytes, key, 2);
    const tampered = [...chunks];
    tampered[0] = chunkAndSeal(new Uint8Array([9, 9]), key, 2).chunks[0];
    expect(() => reassembleAndVerify(tampered, key, sha256, bytes.length)).toThrow(
      /hash mismatch — refusing to write/,
    );
  });

  // The codec-level test above proves reassembleAndVerify itself is sound. The
  // two tests below prove the SAME guarantee holds when a chunk is tampered at
  // rest in the relay's store and fetched over a REAL socket by a REAL member,
  // all the way through TunnelSession.receive()'s reassemble-then-writeFile —
  // i.e. the actual product code path a user hits, not just the primitive.
  function fakeDeps() {
    return {
      ensureCloudflared: async () => 'fake',
      startCloudflared: async (_b: string, port: number) => ({
        publicUrl: `http://127.0.0.1:${port}`,
        stop() {},
      }),
    };
  }

  async function waitForOffer(
    s: import('../src/session.js').TunnelSession,
    deadlineMs = 4000,
  ): Promise<void> {
    const stop = Date.now() + deadlineMs;
    // `since` MUST advance across iterations: once the log already has an
    // earlier message (e.g. the "joined" system message), calling listen(0,
    // ...) again and again returns synchronously every time (log.since(0) is
    // already non-empty) and never awaits the socket/timer branch — starving
    // the event loop so the pending network share/fetch never gets a turn to
    // complete. Tracking `since` forces listen() to actually wait once caught up.
    let since = 0;
    while (Date.now() < stop) {
      const { messages } = await s.listen(since, Math.max(100, stop - Date.now()));
      for (const m of messages) since = Math.max(since, m.seq);
      if (messages.some((m) => m.kind === 'artifact')) return;
    }
    throw new Error('waitForOffer timed out');
  }

  it('a chunk tampered at rest (same-length swap) fails the REAL receive path with the hash-mismatch message and writes no file', async () => {
    const { TunnelSession } = await import('../src/session.js');
    const { chunkAndSeal: seal } = await import('../src/protocol/artifact.js');
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const crypto = await import('node:crypto');

    const host = new TunnelSession(fakeDeps());
    const ana = new TunnelSession();
    const src = path.join(os.tmpdir(), `tunnel-tamper-src-${crypto.randomUUID()}`);
    const dst = path.join(os.tmpdir(), `tunnel-tamper-dst-${crypto.randomUUID()}`);
    try {
      const opened = await host.open('tamper room', 'Host', { invites: 1 });
      await ana.join(opened.invites[0].joinLink, 'Ana');

      const payload = Buffer.from('integrity-check-payload-bytes!!');
      await fs.writeFile(src, payload);
      const shared = await host.share(src);
      await waitForOffer(ana);

      // Reach into the host relay's in-memory store — this stands in for an
      // on-path tamperer flipping the sealed bytes before Ana's real `fetch`
      // pulls them over the socket. Swap chunk 0 for a DIFFERENT plaintext of
      // the SAME length, sealed under the real session key: it decrypts
      // cleanly (so this isn't just an AEAD-auth-failure case) but reassembles
      // to the wrong bytes, so only the post-decrypt sha256 check catches it.
      const realKey = (host as unknown as { key: Uint8Array }).key;
      const store = (
        host as unknown as {
          relay: { store: import('../src/relay/artifactStore.js').ArtifactStore };
        }
      ).relay.store;
      const stored = store.get(shared.artifactId);
      expect(stored).toBeDefined();
      const decoy = seal(new Uint8Array(payload.length).fill(0x41), realKey, payload.length)
        .chunks[0];
      stored!.chunks[0] = decoy;

      await expect(ana.receive(shared.artifactId, dst)).rejects.toThrow(
        /artifact hash mismatch — refusing to write/,
      );
      await expect(fs.access(dst)).rejects.toThrow();
    } finally {
      await fs.rm(src, { force: true });
      await fs.rm(dst, { force: true });
      await ana.close().catch(() => {});
      await host.close().catch(() => {});
    }
  }, 15000);

  it('a chunk tampered at rest (different-length swap) fails the REAL receive path with the size-mismatch message and writes no file', async () => {
    const { TunnelSession } = await import('../src/session.js');
    const { chunkAndSeal: seal } = await import('../src/protocol/artifact.js');
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const crypto = await import('node:crypto');

    const host = new TunnelSession(fakeDeps());
    const ana = new TunnelSession();
    const src = path.join(os.tmpdir(), `tunnel-tamper2-src-${crypto.randomUUID()}`);
    const dst = path.join(os.tmpdir(), `tunnel-tamper2-dst-${crypto.randomUUID()}`);
    try {
      const opened = await host.open('tamper room 2', 'Host', { invites: 1 });
      await ana.join(opened.invites[0].joinLink, 'Ana');

      const payload = Buffer.from('another integrity payload, twelve bytes longer!!');
      await fs.writeFile(src, payload);
      const shared = await host.share(src);
      await waitForOffer(ana);

      // Same tamper-at-rest mechanism, but the decoy plaintext is a DIFFERENT
      // length: it still decrypts cleanly (a valid, independently-sealed
      // chunk), but the reassembled total no longer matches the declared
      // size, so the SIZE check must fire before the hash check ever runs.
      const realKey = (host as unknown as { key: Uint8Array }).key;
      const store = (
        host as unknown as {
          relay: { store: import('../src/relay/artifactStore.js').ArtifactStore };
        }
      ).relay.store;
      const stored = store.get(shared.artifactId);
      expect(stored).toBeDefined();
      const shorter = new Uint8Array(payload.length - 5).fill(0x42);
      const decoy = seal(shorter, realKey, shorter.length).chunks[0];
      stored!.chunks[0] = decoy;

      await expect(ana.receive(shared.artifactId, dst)).rejects.toThrow(
        /artifact size mismatch — refusing to write/,
      );
      await expect(fs.access(dst)).rejects.toThrow();
    } finally {
      await fs.rm(src, { force: true });
      await fs.rm(dst, { force: true });
      await ana.close().catch(() => {});
      await host.close().catch(() => {});
    }
  }, 15000);
});
