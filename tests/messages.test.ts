import { describe, it, expect } from 'vitest';
import { generateKey } from '../src/protocol/crypto.js';
import {
  buildChat,
  buildSystem,
  decrypt,
  encodeFrame,
  decodeFrame,
  newId,
  ControlFrame,
  WireMessage,
  newParticipantId,
} from '../src/protocol/messages.js';

describe('messages', () => {
  it('builds an encrypted chat message that decrypts back', () => {
    const key = generateKey();
    const msg = buildChat('host', 'ship it', key);
    expect(msg.kind).toBe('chat');
    expect(msg.seq).toBe(-1);
    expect(msg.body).not.toContain('ship');
    expect(decrypt(msg, key).text).toBe('ship it');
  });

  it('leaves system messages in plaintext', () => {
    const key = generateKey();
    const msg = buildSystem('host', 'guest joined');
    expect(msg.body).toBe('guest joined');
    expect(decrypt(msg, key).text).toBe('guest joined');
  });

  it('encodes and decodes control frames', () => {
    const frame: ControlFrame = { t: 'challenge', nonce: 'abc' };
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });

  it('decrypt() is total — a malformed chat body returns [unreadable] instead of throwing', () => {
    const key = generateKey();
    const malformed = {
      id: 'x',
      seq: 1,
      from: 'guest' as const,
      kind: 'chat' as const,
      body: 'not-valid-ciphertext',
      ts: Date.now(),
    };
    expect(() => decrypt(malformed, key)).not.toThrow();
    const result = decrypt(malformed, key);
    expect(result.text).toBe('[unreadable]');
    expect(result.id).toBe('x');
    expect(result.seq).toBe(1);
    expect(result.from).toBe('guest');
    expect(result.kind).toBe('chat');
  });

  it('newId() returns distinct ids across many calls', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newId()));
    expect(ids.size).toBe(200);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('buildChat produces a different body per call (random nonce) but both decrypt to the same text', () => {
    const key = generateKey();
    const a = buildChat('host', 'same text', key);
    const b = buildChat('host', 'same text', key);
    expect(a.body).not.toBe(b.body);
    expect(a.id).not.toBe(b.id);
    expect(decrypt(a, key).text).toBe('same text');
    expect(decrypt(b, key).text).toBe('same text');
  });

  it('decrypt() passes through a presence message body as plaintext', () => {
    const key = generateKey();
    const msg: WireMessage = {
      id: newId(),
      seq: 3,
      from: 'guest',
      kind: 'presence',
      body: 'guest is typing',
      ts: 123,
    };
    const result = decrypt(msg, key);
    expect(result.text).toBe('guest is typing');
    expect(result.kind).toBe('presence');
    expect(result.seq).toBe(3);
    expect(result.ts).toBe(123);
  });

  describe('participant ids', () => {
    it('newParticipantId returns 8 random bytes hex, unique per call', () => {
      const a = newParticipantId();
      expect(a).toMatch(/^[0-9a-f]{16}$/);
      expect(newParticipantId()).not.toBe(a);
    });
    it('WireMessage.from accepts a participant id and decrypt passes it through', () => {
      const key = generateKey();
      const id = newParticipantId();
      const m = buildChat(id, 'hi', key);
      expect(m.from).toBe(id);
      expect(decrypt(m, key).from).toBe(id);
    });
  });

  describe('control frame round-trip', () => {
    it('challenge', () => {
      const frame: ControlFrame = { t: 'challenge', nonce: 'nonce-value-123' };
      expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
    });

    it('auth', () => {
      const frame: ControlFrame = {
        t: 'auth',
        response: 'resp-abc',
        name: 'agent-1',
        sinceSeq: 42,
      };
      expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
    });

    it('auth_ok with a backlog array of wire messages', () => {
      const key = generateKey();
      const backlog: WireMessage[] = [
        buildChat('host', 'hello', key),
        buildSystem('guest', 'joined'),
        { id: newId(), seq: 5, from: 'host', kind: 'presence', body: 'typing', ts: 999 },
      ];
      const frame: ControlFrame = {
        t: 'auth_ok',
        goal: 'ship the feature',
        peerName: 'host-agent',
        backlog,
      };
      const decoded = decodeFrame(encodeFrame(frame));
      expect(decoded).toEqual(frame);
      if (decoded.t === 'auth_ok') {
        expect(decoded.backlog).toHaveLength(3);
        expect(decoded.backlog[0].body).toBe(backlog[0].body);
      }
    });

    it('auth_ok with an empty backlog array', () => {
      const frame: ControlFrame = { t: 'auth_ok', goal: 'g', peerName: 'p', backlog: [] };
      const decoded = decodeFrame(encodeFrame(frame));
      expect(decoded).toEqual(frame);
      if (decoded.t === 'auth_ok') expect(decoded.backlog).toEqual([]);
    });

    it('auth_fail', () => {
      const frame: ControlFrame = { t: 'auth_fail', reason: 'bad credentials' };
      expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
    });

    it('msg', () => {
      const key = generateKey();
      const wire = buildChat('guest', 'incoming', key);
      const frame: ControlFrame = { t: 'msg', msg: wire };
      const decoded = decodeFrame(encodeFrame(frame));
      expect(decoded).toEqual(frame);
      if (decoded.t === 'msg') expect(decrypt(decoded.msg, key).text).toBe('incoming');
    });

    it('send', () => {
      const key = generateKey();
      const wire = buildChat('host', 'outgoing', key);
      const frame: ControlFrame = { t: 'send', msg: wire };
      const decoded = decodeFrame(encodeFrame(frame));
      expect(decoded).toEqual(frame);
      if (decoded.t === 'send') expect(decrypt(decoded.msg, key).text).toBe('outgoing');
    });
  });
});
