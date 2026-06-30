import crypto from 'node:crypto';
import { Key, seal, open } from './crypto.js';

export type MessageKind = 'chat' | 'system' | 'presence';
export type Role = 'host' | 'guest';

export interface WireMessage {
  id: string;
  seq: number;   // -1 until the host relay assigns it
  from: Role;
  kind: MessageKind;
  body: string;  // chat: ciphertext; system/presence: plaintext
  ts: number;    // 0 until the host relay assigns it
}

export interface PlainMessage {
  id: string;
  seq: number;
  from: Role;
  kind: MessageKind;
  text: string;
  ts: number;
}

export function newId(): string {
  return crypto.randomBytes(8).toString('hex');
}

export function buildChat(from: Role, text: string, key: Key): WireMessage {
  return { id: newId(), seq: -1, from, kind: 'chat', body: seal(text, key), ts: 0 };
}

export function buildSystem(from: Role, text: string): WireMessage {
  return { id: newId(), seq: -1, from, kind: 'system', body: text, ts: 0 };
}

export function decrypt(msg: WireMessage, key: Key): PlainMessage {
  const text = msg.kind === 'chat' ? open(msg.body, key) : msg.body;
  return { id: msg.id, seq: msg.seq, from: msg.from, kind: msg.kind, text, ts: msg.ts };
}

export type ControlFrame =
  | { t: 'challenge'; nonce: string }
  | { t: 'auth'; response: string; name: string; sinceSeq: number }
  | { t: 'auth_ok'; goal: string; peerName: string; backlog: WireMessage[] }
  | { t: 'auth_fail'; reason: string }
  | { t: 'msg'; msg: WireMessage }
  | { t: 'send'; msg: WireMessage };

export function encodeFrame(frame: ControlFrame): string {
  return JSON.stringify(frame);
}

export function decodeFrame(data: string): ControlFrame {
  return JSON.parse(data) as ControlFrame;
}
