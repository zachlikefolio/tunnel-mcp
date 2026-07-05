import { describe, it, expect } from 'vitest';
import { ArtifactStore } from '../src/relay/artifactStore.js';
import { ARTIFACT_CHUNK_BYTES, MAX_SEALED_CHUNK_BYTES } from '../src/config.js';

const opts = { maxArtifactBytes: 1000, maxMemberBytes: 1500, maxRoomBytes: 2000, ttlMs: 1000 };
const meta = (size: number, chunkCount: number) => ({
  name: 'f',
  kind: 'binary' as const,
  size,
  sha256: 'x',
  chunkCount,
});

/** A base64url string that decodes to exactly n raw bytes — a fake "sealed" chunk. */
const sealedOf = (n: number) => Buffer.alloc(n, 7).toString('base64url');

describe('ArtifactStore', () => {
  it('buffers chunks and completes a valid upload', () => {
    const s = new ArtifactStore(opts);
    expect(s.begin('a', meta(6, 2), 'm1', 0)).toBe('ok');
    expect(s.putChunk('a', 0, 'c0')).toBe('ok');
    expect(s.putChunk('a', 1, 'c1')).toBe('ok');
    expect(s.end('a')).toBe('ok');
    expect(s.chunkOf('a', 0)).toBe('c0');
    expect(s.chunkOf('a', 1)).toBe('c1');
    expect(s.get('a')?.complete).toBe(true);
  });

  it('rejects a duplicate id, oversized artifact, and bad meta', () => {
    const s = new ArtifactStore(opts);
    expect(s.begin('a', meta(6, 2), 'm1', 0)).toBe('ok');
    expect(s.begin('a', meta(6, 2), 'm1', 0)).toBe('duplicate');
    expect(s.begin('big', meta(1001, 1), 'm1', 0)).toBe('too_large');
    expect(s.begin('z', meta(0, 0), 'm1', 0)).toBe('bad_meta');
    expect(s.begin('z', meta(6, 0), 'm1', 0)).toBe('bad_meta');
  });

  it('enforces per-member and room caps against reserved size', () => {
    const s = new ArtifactStore(opts);
    expect(s.begin('a', meta(900, 1), 'm1', 0)).toBe('ok');
    expect(s.begin('b', meta(900, 1), 'm1', 0)).toBe('member_full'); // 1800 > 1500
    expect(s.begin('c', meta(900, 1), 'm2', 0)).toBe('ok');
    expect(s.begin('d', meta(900, 1), 'm3', 0)).toBe('room_full'); // 2700 > 2000
    expect(s.bytesFor('m1')).toBe(900);
    expect(s.totalBytes()).toBe(1800);
  });

  it('rejects unknown id, out-of-range seq, and duplicate chunk', () => {
    const s = new ArtifactStore(opts);
    s.begin('a', meta(6, 2), 'm1', 0);
    expect(s.putChunk('nope', 0, 'x')).toBe('unknown');
    expect(s.putChunk('a', -1, 'x')).toBe('bad_seq');
    expect(s.putChunk('a', 2, 'x')).toBe('bad_seq');
    expect(s.putChunk('a', 0, 'x')).toBe('ok');
    expect(s.putChunk('a', 0, 'y')).toBe('duplicate_chunk');
  });

  it('end() is incomplete until every chunk arrives; unknown for a missing id', () => {
    const s = new ArtifactStore(opts);
    s.begin('a', meta(6, 2), 'm1', 0);
    s.putChunk('a', 0, 'c0');
    expect(s.end('a')).toBe('incomplete');
    s.putChunk('a', 1, 'c1');
    expect(s.end('a')).toBe('ok');
    expect(s.end('missing')).toBe('unknown');
  });

  it('evicts by explicit id and by TTL, freeing the reserved bytes', () => {
    const s = new ArtifactStore(opts);
    s.begin('a', meta(900, 1), 'm1', 0);
    s.evict('a');
    expect(s.totalBytes()).toBe(0);
    s.begin('b', meta(900, 1), 'm1', 0);
    expect(s.evictExpired(1000)).toEqual(['b']); // createdAt 0 + ttl 1000
    expect(s.get('b')).toBeUndefined();
    expect(s.bytesFor('m1')).toBe(0);
  });

  describe('putChunk enforces caps on ACTUAL buffered bytes', () => {
    // Generous opts so only the per-chunk absolute bound / per-artifact ceiling
    // under test is exercised, not the (tiny) fixture caps above.
    const roomy = {
      maxArtifactBytes: 20_000_000,
      maxMemberBytes: 20_000_000,
      maxRoomBytes: 20_000_000,
      ttlMs: 1000,
    };

    it('rejects a chunk whose decoded bytes exceed the per-chunk bound, even under a huge declared size', () => {
      const s = new ArtifactStore(roomy);
      expect(s.begin('a', meta(10_000_000, 1), 'm1', 0)).toBe('ok');
      const oversizedChunk = sealedOf(MAX_SEALED_CHUNK_BYTES + 1);
      expect(s.putChunk('a', 0, oversizedChunk)).toBe('too_large');
      // rejected, not silently buffered
      expect(s.get('a')?.actualBytes).toBe(0);
      // a chunk right at the bound is fine
      expect(s.putChunk('a', 0, sealedOf(MAX_SEALED_CHUNK_BYTES))).toBe('ok');
    });

    it('rejects an oversized chunk against a tiny declared size instead of silently buffering it', () => {
      const s = new ArtifactStore(roomy);
      // Declares size:1 (trivially under every cap) then tries to smuggle 500
      // actual bytes through putChunk — well under the absolute per-chunk bound,
      // but far past the declared size + per-chunk overhead tolerance.
      expect(s.begin('a', meta(1, 1), 'm1', 0)).toBe('ok');
      expect(s.putChunk('a', 0, sealedOf(500))).toBe('too_large');
      expect(s.get('a')?.actualBytes).toBe(0);
    });

    it('rejects when actual buffered bytes would exceed the per-member cap', () => {
      const capped = {
        maxArtifactBytes: 20_000_000,
        maxMemberBytes: 50,
        maxRoomBytes: 20_000_000,
        ttlMs: 1000,
      };
      const s = new ArtifactStore(capped);
      // Declared size (10) passes begin()'s reservation check against maxMemberBytes,
      // but the actual chunk (60 bytes) alone exceeds the 50-byte member cap.
      expect(s.begin('a', meta(10, 1), 'm1', 0)).toBe('ok');
      expect(s.putChunk('a', 0, sealedOf(60))).toBe('member_full');
      expect(s.actualBytesFor('m1')).toBe(0);
    });

    it('rejects when actual buffered bytes would exceed the room-wide cap', () => {
      const capped = {
        maxArtifactBytes: 20_000_000,
        maxMemberBytes: 20_000_000,
        maxRoomBytes: 50,
        ttlMs: 1000,
      };
      const s = new ArtifactStore(capped);
      expect(s.begin('a', meta(10, 1), 'm1', 0)).toBe('ok');
      expect(s.putChunk('a', 0, sealedOf(60))).toBe('room_full');
      expect(s.actualTotalBytes()).toBe(0);
    });

    it('a normal in-spec multi-chunk upload still succeeds and end() still validates chunkCount', () => {
      const s = new ArtifactStore(roomy);
      const plainSize = ARTIFACT_CHUNK_BYTES + 123;
      expect(s.begin('a', meta(plainSize, 2), 'm1', 0)).toBe('ok');
      expect(s.putChunk('a', 0, sealedOf(ARTIFACT_CHUNK_BYTES + 40))).toBe('ok');
      expect(s.end('a')).toBe('incomplete');
      expect(s.putChunk('a', 1, sealedOf(163))).toBe('ok');
      expect(s.end('a')).toBe('ok');
      expect(s.get('a')?.complete).toBe(true);
      expect(s.get('a')?.actualBytes).toBe(ARTIFACT_CHUNK_BYTES + 40 + 163);
    });
  });
});
