import { describe, it, expect } from 'vitest';
import { ArtifactStore } from '../src/relay/artifactStore.js';

const opts = { maxArtifactBytes: 1000, maxMemberBytes: 1500, maxRoomBytes: 2000, ttlMs: 1000 };
const meta = (size: number, chunkCount: number) => ({
  name: 'f',
  kind: 'binary' as const,
  size,
  sha256: 'x',
  chunkCount,
});

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
});
