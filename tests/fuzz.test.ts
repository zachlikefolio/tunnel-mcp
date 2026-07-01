import { describe, it } from 'vitest';
import fc from 'fast-check';
import { decodeFrame, decrypt } from '../src/protocol/messages.js';
import type { WireMessage } from '../src/protocol/messages.js';
import { parseLink, mintLink, generateTunnelId } from '../src/protocol/link.js';
import { generateKey, keyToBase64url } from '../src/protocol/crypto.js';

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

    // Genuinely VALID links (real 32-byte key + hex tunnel id over a fuzzed host),
    // so parseLink MUST return and the success-branch invariants actually run —
    // a regression that returned a non-32-byte key or non-hex id would fail here.
    const validLink = fc
      .tuple(
        fc.domain(),
        fc.uint8Array({ minLength: 1, maxLength: 12 }).map((b) => Buffer.from(b).toString('hex')),
      )
      .map(([host, tid]) => `wss://${host}/t/${tid}#${keyToBase64url(generateKey())}`);
    fc.assert(
      fc.property(validLink, (s) => {
        const l = parseLink(s); // must NOT throw for a well-formed link
        return (
          l.key.length === 32 && /^[0-9a-f]+$/.test(l.tunnelId) && l.wsUrl.startsWith('wss://')
        );
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
          const parsed = parseLink(mintLink(base, tid, k));
          return parsed.tunnelId === tid && keyToBase64url(parsed.key) === keyToBase64url(k);
        },
      ),
      { numRuns: 500 },
    );
  });
});
