import { describe, it, expect } from 'vitest';
import { generateKey } from '../src/protocol/crypto.js';
import {
  buildChat, buildSystem, decrypt, encodeFrame, decodeFrame, ControlFrame,
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
});
