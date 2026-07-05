import { createHash } from 'node:crypto';
import { Key, sealBytes, openBytes } from './crypto.js';

/** Display hint only — bytes transfer identically either way. */
export function detectKind(bytes: Uint8Array): 'text' | 'binary' {
  if (bytes.includes(0)) return 'binary';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return 'text';
  } catch {
    return 'binary';
  }
}

export function chunkAndSeal(
  bytes: Uint8Array,
  key: Key,
  chunkBytes: number,
): { chunks: string[]; sha256: string; chunkCount: number; kind: 'text' | 'binary' } {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const chunks: string[] = [];
  for (let off = 0; off < bytes.length; off += chunkBytes) {
    chunks.push(sealBytes(bytes.subarray(off, off + chunkBytes), key));
  }
  return { chunks, sha256, chunkCount: chunks.length, kind: detectKind(bytes) };
}

/** Decrypt every sealed chunk in order, concatenate, verify size + sha256. */
export function reassembleAndVerify(
  sealedChunks: string[],
  key: Key,
  sha256: string,
  size: number,
): Uint8Array {
  const parts = sealedChunks.map((c) => openBytes(c, key)); // throws on tamper/missing
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  if (out.length !== size) throw new Error('artifact size mismatch — refusing to write');
  const got = createHash('sha256').update(out).digest('hex');
  if (got !== sha256) throw new Error('artifact hash mismatch — refusing to write');
  return out;
}
