import type { ParticipantId } from '../protocol/messages.js';

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
  createdAt: number;
  complete: boolean;
}

/**
 * In-memory only (mirrors SessionLog's no-fs discipline). Caps reserve the
 * declared plaintext `size` at begin() so a member cannot start many uploads to
 * exhaust host memory before the first chunk lands. Actual ciphertext buffered
 * is ~1.4x the reserved size (nonce + tag + base64url), comfortably bounded.
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
    if (!Number.isInteger(meta.chunkCount) || meta.chunkCount < 1) return 'bad_meta';
    if (meta.size > this.opts.maxArtifactBytes) return 'too_large';
    if (this.bytesFor(by) + meta.size > this.opts.maxMemberBytes) return 'member_full';
    if (this.totalBytes() + meta.size > this.opts.maxRoomBytes) return 'room_full';
    this.artifacts.set(artifactId, {
      meta,
      by,
      chunks: new Array<string | undefined>(meta.chunkCount).fill(undefined),
      received: 0,
      createdAt: now,
      complete: false,
    });
    return 'ok';
  }

  putChunk(
    artifactId: string,
    seq: number,
    data: string,
  ): 'ok' | 'unknown' | 'bad_seq' | 'duplicate_chunk' {
    const a = this.artifacts.get(artifactId);
    if (!a) return 'unknown';
    if (!Number.isInteger(seq) || seq < 0 || seq >= a.meta.chunkCount) return 'bad_seq';
    if (a.chunks[seq] !== undefined) return 'duplicate_chunk';
    a.chunks[seq] = data;
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
}
