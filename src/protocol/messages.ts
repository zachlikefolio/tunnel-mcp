import crypto from 'node:crypto';
import { Key, seal, open } from './crypto.js';

export type MessageKind = 'chat' | 'system' | 'presence' | 'artifact';

export type ParticipantId = string; // 8 random bytes, hex (16 chars)

export interface RosterEntry {
  id: ParticipantId;
  name: string;
  isHost: boolean;
  connected: boolean;
  protocolVersion?: number; // wire version the member authed with (host = PROTOCOL_VERSION)
}

export interface WireMessage {
  id: string;
  seq: number; // -1 until the host relay assigns it
  from: ParticipantId;
  kind: MessageKind;
  body: string; // chat: ciphertext; system/presence: plaintext
  ts: number; // 0 until the host relay assigns it
}

export interface PlainMessage {
  id: string;
  seq: number;
  from: ParticipantId;
  fromName?: string; // resolved from the roster at delivery (session.listen)
  kind: MessageKind;
  text: string;
  ts: number;
}

export function newId(): string {
  return crypto.randomBytes(8).toString('hex');
}

export function newParticipantId(): ParticipantId {
  return crypto.randomBytes(8).toString('hex');
}

export function buildChat(from: ParticipantId, text: string, key: Key): WireMessage {
  return { id: newId(), seq: -1, from, kind: 'chat', body: seal(text, key), ts: 0 };
}

export function buildSystem(from: ParticipantId, text: string): WireMessage {
  return { id: newId(), seq: -1, from, kind: 'system', body: text, ts: 0 };
}

export interface ArtifactOffer {
  id: string;
  name: string;
  kind: 'text' | 'binary';
  size: number;
  sha256: string;
  from: ParticipantId;
}

/** Offer metadata rides the single sequencer as a plaintext `artifact` message. */
export function buildArtifactMessage(from: ParticipantId, offer: ArtifactOffer): WireMessage {
  return { id: newId(), seq: -1, from, kind: 'artifact', body: JSON.stringify(offer), ts: 0 };
}

// decrypt() must be TOTAL: a malformed/forged peer chat body must never
// throw here, or one bad message poisons every listen() batch that includes
// it (the untrusted guest could otherwise deny the host's receive loop).
export function decrypt(msg: WireMessage, key: Key): PlainMessage {
  let text: string;
  if (msg.kind === 'chat') {
    try {
      text = open(msg.body, key);
    } catch {
      text = '[unreadable]';
    }
  } else {
    text = msg.body;
  }
  return { id: msg.id, seq: msg.seq, from: msg.from, kind: msg.kind, text, ts: msg.ts };
}

export type ControlFrame =
  | { t: 'challenge'; nonce: string }
  | {
      t: 'auth';
      response: string;
      name: string;
      sinceSeq: number;
      token: string;
      protocolVersion: number;
    }
  | {
      t: 'auth_ok';
      goal: string;
      selfId: ParticipantId;
      roster: RosterEntry[];
      backlog: WireMessage[];
    }
  | { t: 'auth_fail'; reason: string }
  | { t: 'msg'; msg: WireMessage }
  | { t: 'send'; msg: WireMessage }
  | { t: 'roster'; members: RosterEntry[] }
  | {
      t: 'share_begin';
      artifactId: string;
      name: string;
      kind: 'text' | 'binary';
      size: number;
      sha256: string;
      chunkCount: number;
    }
  | { t: 'share_chunk'; artifactId: string; seq: number; data: string }
  | { t: 'share_end'; artifactId: string }
  | { t: 'fetch'; artifactId: string }
  | { t: 'fetch_chunk'; artifactId: string; seq: number; data: string; last: boolean }
  | { t: 'error'; code: string; message: string; artifactId?: string };

export function encodeFrame(frame: ControlFrame): string {
  return JSON.stringify(frame);
}

// Validate enough of the shape that the `as ControlFrame` cast is honest: every
// caller switches on `frame.t`, so a parsed value that is null, a primitive, an
// array, or lacks a string `t` must be rejected here (callers wrap this in
// try/catch) rather than handed back as a frame that crashes `frame.t`.
export function decodeFrame(data: string): ControlFrame {
  const parsed: unknown = JSON.parse(data);
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    typeof (parsed as { t?: unknown }).t !== 'string'
  ) {
    throw new Error('malformed control frame');
  }
  return parsed as ControlFrame;
}
