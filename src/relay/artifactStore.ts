import type { ParticipantId } from '../protocol/messages.js';
import { MAX_SEALED_CHUNK_BYTES, SEALED_CHUNK_OVERHEAD_BYTES } from '../config.js';

// Cheap pre-check on the *encoded* string length, applied before Buffer.from ever
// touches the bytes, so an attacker can't force a large decode allocation just to
// have the chunk rejected. base64url expands N raw bytes to ceil(N*4/3) chars; the
// small "+ 4" absorbs rounding at the boundary.
const MAX_SEALED_CHUNK_B64_LEN = Math.ceil((MAX_SEALED_CHUNK_BYTES * 4) / 3) + 4;

export interface ArtifactMeta {
  name: string;
  kind: 'text' | 'binary';
  size: number; // plaintext bytes, declared by the sharer
  sha256: string; // hex, plaintext hash
  chunkCount: number;
}

export interface ArtifactStoreOptions {
  maxArtifactBytes: number;
  maxMemberBytes: number;
  maxRoomBytes: number;
  ttlMs: number;
}

export interface StoredArtifact {
  meta: ArtifactMeta;
  by: ParticipantId;
  chunks: (string | undefined)[]; // sealed base64url chunk per seq index
  received: number;
  actualBytes: number; // sum of decoded (sealed) bytes actually buffered so far
  createdAt: number;
  complete: boolean;
}

/**
 * In-memory only (mirrors SessionLog's no-fs discipline). Caps reserve the
 * declared plaintext `size` at begin() so a member cannot start many uploads to
 * exhaust host memory before the first chunk lands. That reservation trusts the
 * caller's declared size, though, so putChunk() independently enforces the same
 * caps against the ACTUAL bytes it buffers — a client can't declare a tiny size
 * then smuggle unbounded bytes through chunk data. Actual ciphertext buffered
 * per chunk is ~1.4x its plaintext (nonce + tag + base64url), comfortably bounded.
 */
export class ArtifactStore {
  private artifacts = new Map<string, StoredArtifact>();

  constructor(private opts: ArtifactStoreOptions) {}

  begin(
    artifactId: string,
    meta: ArtifactMeta,
    by: ParticipantId,
    now: number = Date.now(),
  ): 'ok' | 'too_large' | 'duplicate' | 'member_full' | 'room_full' | 'bad_meta' {
    if (this.artifacts.has(artifactId)) return 'duplicate';
    if (!Number.isInteger(meta.size) || meta.size < 1) return 'bad_meta';
    // chunkCount is bounded by size (chunkAndSeal never emits an empty chunk, so a
    // legitimate upload can never have more chunks than plaintext bytes). Without
    // this, an attacker-declared chunkCount near Number.MAX_SAFE_INTEGER/2^31 with
    // a tiny declared size sails past the size cap below and crashes the process
    // via `new Array(meta.chunkCount)` a few lines down (V8 OOM abort — reproduced).
    if (!Number.isInteger(meta.chunkCount) || meta.chunkCount < 1 || meta.chunkCount > meta.size) {
      return 'bad_meta';
    }
    if (meta.size > this.opts.maxArtifactBytes) return 'too_large';
    if (this.bytesFor(by) + meta.size > this.opts.maxMemberBytes) return 'member_full';
    if (this.totalBytes() + meta.size > this.opts.maxRoomBytes) return 'room_full';
    this.artifacts.set(artifactId, {
      meta,
      by,
      chunks: new Array<string | undefined>(meta.chunkCount).fill(undefined),
      received: 0,
      actualBytes: 0,
      createdAt: now,
      complete: false,
    });
    return 'ok';
  }

  putChunk(
    artifactId: string,
    seq: number,
    data: string,
  ): 'ok' | 'unknown' | 'bad_seq' | 'duplicate_chunk' | 'too_large' | 'member_full' | 'room_full' {
    const a = this.artifacts.get(artifactId);
    if (!a) return 'unknown';
    if (!Number.isInteger(seq) || seq < 0 || seq >= a.meta.chunkCount) return 'bad_seq';
    if (a.chunks[seq] !== undefined) return 'duplicate_chunk';

    // 1. Per-chunk bound. Reject before decoding if the encoded string alone is
    // already too long to be a legitimate sealed chunk (avoids a large decode
    // allocation just to reject it), then confirm on the decoded byte length.
    if (data.length > MAX_SEALED_CHUNK_B64_LEN) return 'too_large';
    const decodedLen = Buffer.from(data, 'base64url').length;
    if (decodedLen > MAX_SEALED_CHUNK_BYTES) return 'too_large';

    // 2a. Per-artifact: actual buffered bytes must stay within the declared
    // plaintext size plus a fixed per-chunk overhead tolerance. Without this a
    // client could declare size:1 and stream unbounded chunks into one artifact.
    const artifactCeiling = a.meta.size + a.meta.chunkCount * SEALED_CHUNK_OVERHEAD_BYTES;
    if (a.actualBytes + decodedLen > artifactCeiling) return 'too_large';

    // 2b. Per-member / room: begin() reserves against these caps using the
    // DECLARED size; enforce the same caps here against ACTUAL buffered bytes so
    // reservation can't be bypassed by a caller who never validates its own claims.
    if (this.actualBytesFor(a.by) + decodedLen > this.opts.maxMemberBytes) return 'member_full';
    if (this.actualTotalBytes() + decodedLen > this.opts.maxRoomBytes) return 'room_full';

    a.chunks[seq] = data;
    a.actualBytes += decodedLen;
    a.received++;
    return 'ok';
  }

  end(artifactId: string): 'ok' | 'unknown' | 'incomplete' {
    const a = this.artifacts.get(artifactId);
    if (!a) return 'unknown';
    if (a.received !== a.meta.chunkCount || a.chunks.some((c) => c === undefined)) {
      return 'incomplete';
    }
    a.complete = true;
    return 'ok';
  }

  get(artifactId: string): StoredArtifact | undefined {
    return this.artifacts.get(artifactId);
  }

  chunkOf(artifactId: string, seq: number): string | undefined {
    const a = this.artifacts.get(artifactId);
    if (!a || seq < 0 || seq >= a.meta.chunkCount) return undefined;
    return a.chunks[seq];
  }

  evict(artifactId: string): void {
    this.artifacts.delete(artifactId);
  }

  evictExpired(now: number = Date.now()): string[] {
    const dead: string[] = [];
    for (const [id, a] of this.artifacts) {
      if (now - a.createdAt >= this.opts.ttlMs) dead.push(id);
    }
    for (const id of dead) this.artifacts.delete(id);
    return dead;
  }

  bytesFor(member: ParticipantId): number {
    let n = 0;
    for (const a of this.artifacts.values()) if (a.by === member) n += a.meta.size;
    return n;
  }

  totalBytes(): number {
    let n = 0;
    for (const a of this.artifacts.values()) n += a.meta.size;
    return n;
  }

  /** Sum of ACTUAL bytes buffered so far for one member (vs. bytesFor's reserved/declared size). */
  actualBytesFor(member: ParticipantId): number {
    let n = 0;
    for (const a of this.artifacts.values()) if (a.by === member) n += a.actualBytes;
    return n;
  }

  /** Sum of ACTUAL bytes buffered so far, room-wide (vs. totalBytes's reserved/declared size). */
  actualTotalBytes(): number {
    let n = 0;
    for (const a of this.artifacts.values()) n += a.actualBytes;
    return n;
  }
}
