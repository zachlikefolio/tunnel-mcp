import { describe, it, expect } from 'vitest';
import { detectKind, chunkAndSeal, reassembleAndVerify } from '../src/protocol/artifact.js';
import { generateKey } from '../src/protocol/crypto.js';

describe('artifact codec', () => {
  it('detectKind flags NUL/invalid-utf8 as binary and clean utf8 as text', () => {
    expect(detectKind(new TextEncoder().encode('hello world'))).toBe('text');
    expect(detectKind(new Uint8Array([104, 105, 0, 105]))).toBe('binary');
    expect(detectKind(new Uint8Array([0xff, 0xfe, 0xfd]))).toBe('binary');
  });

  it('chunkAndSeal → reassembleAndVerify round-trips bytes exactly', () => {
    const key = generateKey();
    const bytes = new Uint8Array(64 * 1024 + 123).map((_, i) => (i * 7) % 256);
    const { chunks, sha256, chunkCount, kind } = chunkAndSeal(bytes, key, 64 * 1024);
    expect(chunkCount).toBe(2);
    expect(kind).toBe('binary');
    const out = reassembleAndVerify(chunks, key, sha256, bytes.length);
    expect(Array.from(out)).toEqual(Array.from(bytes));
  });

  it('a size mismatch is refused', () => {
    const key = generateKey();
    const { chunks, sha256 } = chunkAndSeal(new Uint8Array([1, 2, 3]), key, 64 * 1024);
    expect(() => reassembleAndVerify(chunks, key, sha256, 999)).toThrow(
      'artifact size mismatch — refusing to write',
    );
  });

  it('a tampered chunk fails the post-decrypt hash (or decrypt) check', () => {
    const key = generateKey();
    const bytes = new Uint8Array([5, 6, 7, 8, 9]);
    const { chunks, sha256 } = chunkAndSeal(bytes, key, 2); // 3 chunks
    // Re-seal a different plaintext for chunk 1 under the SAME key: decrypt
    // succeeds but the reassembled hash won't match.
    const tampered = [...chunks];
    tampered[1] = chunkAndSeal(new Uint8Array([0, 0]), key, 2).chunks[0];
    expect(() => reassembleAndVerify(tampered, key, sha256, bytes.length)).toThrow(
      'artifact hash mismatch — refusing to write',
    );
  });
});
