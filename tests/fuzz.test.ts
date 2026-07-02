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
