import { describe, it, expect } from 'vitest';
import {
  generateKey,
  keyToBase64url,
  keyFromBase64url,
  seal,
  open,
  sealBytes,
  openBytes,
  makeChallenge,
  respondChallenge,
  verifyChallenge,
  generateToken,
} from '../src/protocol/crypto.js';

describe('crypto', () => {
  it('seals and opens a roundtrip', () => {
    const key = generateKey();
    const sealed = seal('hello tunnel', key);
    expect(sealed).not.toContain('hello');
    expect(open(sealed, key)).toBe('hello tunnel');
  });

  it('fails to open with the wrong key', () => {
    const sealed = seal('secret', generateKey());
    expect(() => open(sealed, generateKey())).toThrow();
  });

  it('serializes keys to/from base64url', () => {
    const key = generateKey();
    expect(keyFromBase64url(keyToBase64url(key))).toEqual(key);
  });

  it('verifies a correct challenge response and rejects a forged one', () => {
    const key = generateKey();
    const ch = makeChallenge();
    expect(verifyChallenge(ch, respondChallenge(ch, key), key)).toBe(true);
    expect(verifyChallenge(ch, respondChallenge(ch, generateKey()), key)).toBe(false);
  });

  it('throws on open() when the sealed ciphertext has been tampered with', () => {
    const key = generateKey();
    const sealed = seal('do not tamper', key);
    const buf = Buffer.from(sealed, 'base64url');
    // Flip one byte well inside the ciphertext portion (past the nonce).
    const idx = buf.length - 1;
    buf[idx] = buf[idx] ^ 0xff;
    const tampered = buf.toString('base64url');
    expect(() => open(tampered, key)).toThrow();
  });

  it('throws cleanly (no crash) when opening a truncated/too-short sealed string', () => {
    const key = generateKey();
    // Way too short to even contain a full nonce.
    expect(() => open('', key)).toThrow();
    expect(() => open('AA', key)).toThrow();
    const sealed = seal('some plaintext', key);
    const truncated = sealed.slice(0, 10);
    expect(() => open(truncated, key)).toThrow();
  });

  it('keyFromBase64url rejects a wrong-length key', () => {
    const shortKey = Buffer.alloc(8).toString('base64url');
    expect(() => keyFromBase64url(shortKey)).toThrow('invalid key length');
    const longKey = Buffer.alloc(64).toString('base64url');
    expect(() => keyFromBase64url(longKey)).toThrow('invalid key length');
  });

  it('seal() is non-deterministic across calls but both decrypt to the same plaintext', () => {
    const key = generateKey();
    const plaintext = 'same message, different nonce each time';
    const sealedA = seal(plaintext, key);
    const sealedB = seal(plaintext, key);
    expect(sealedA).not.toBe(sealedB);
    expect(open(sealedA, key)).toBe(plaintext);
    expect(open(sealedB, key)).toBe(plaintext);
  });

  it('round-trips an empty string plaintext', () => {
    const key = generateKey();
    const sealed = seal('', key);
    expect(open(sealed, key)).toBe('');
  });

  it('round-trips multi-byte unicode plaintext', () => {
    const key = generateKey();
    const plaintext = '日本語🚀éè中文';
    const sealed = seal(plaintext, key);
    expect(open(sealed, key)).toBe(plaintext);
  });

  it('verifyChallenge returns false (not throw) for a wrong-length response', () => {
    const key = generateKey();
    const ch = makeChallenge();
    expect(() => verifyChallenge(ch, 'short', key)).not.toThrow();
    expect(verifyChallenge(ch, 'short', key)).toBe(false);
    expect(verifyChallenge(ch, '', key)).toBe(false);
  });

  it('makeChallenge() returns distinct values across calls', () => {
    const a = makeChallenge();
    const b = makeChallenge();
    expect(a).not.toBe(b);
  });
});

describe('sealBytes/openBytes (binary-safe)', () => {
  it('round-trips arbitrary bytes including NULs and high bytes', () => {
    const key = generateKey();
    const plain = new Uint8Array([0, 1, 2, 255, 254, 0, 128, 42]);
    const sealed = sealBytes(plain, key);
    expect(typeof sealed).toBe('string');
    expect(Array.from(openBytes(sealed, key))).toEqual(Array.from(plain));
  });
  it('a tampered sealed chunk fails to open', () => {
    const key = generateKey();
    const sealed = sealBytes(new Uint8Array([9, 9, 9, 9]), key);
    const flipped = (sealed[0] === 'A' ? 'B' : 'A') + sealed.slice(1);
    expect(() => openBytes(flipped, key)).toThrow();
  });
  it('opening under the wrong key throws', () => {
    const sealed = sealBytes(new Uint8Array([1, 2, 3]), generateKey());
    expect(() => openBytes(sealed, generateKey())).toThrow('decryption failed');
  });
});

describe('generateToken', () => {
  it('returns 16 random bytes as base64url, unique per call', () => {
    const t1 = generateToken();
    const t2 = generateToken();
    expect(t1).not.toBe(t2);
    expect(Buffer.from(t1, 'base64url').length).toBe(16);
    expect(t1).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
