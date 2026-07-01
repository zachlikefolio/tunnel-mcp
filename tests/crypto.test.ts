import { describe, it, expect } from 'vitest';
import {
  generateKey, keyToBase64url, keyFromBase64url,
  seal, open, makeChallenge, respondChallenge, verifyChallenge,
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
});
