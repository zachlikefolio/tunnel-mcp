import nacl from 'tweetnacl';
import crypto from 'node:crypto';

export type Key = Uint8Array;

export function generateKey(): Key {
  return nacl.randomBytes(nacl.secretbox.keyLength);
}

export function keyToBase64url(key: Key): string {
  return Buffer.from(key).toString('base64url');
}

export function keyFromBase64url(s: string): Key {
  const b = Buffer.from(s, 'base64url');
  if (b.length !== nacl.secretbox.keyLength) throw new Error('invalid key length');
  return new Uint8Array(b);
}

export function seal(plaintext: string, key: Key): string {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const box = nacl.secretbox(Buffer.from(plaintext, 'utf8'), nonce, key);
  return Buffer.concat([Buffer.from(nonce), Buffer.from(box)]).toString('base64url');
}

export function open(sealed: string, key: Key): string {
  const data = Buffer.from(sealed, 'base64url');
  const nonce = new Uint8Array(data.subarray(0, nacl.secretbox.nonceLength));
  const box = new Uint8Array(data.subarray(nacl.secretbox.nonceLength));
  const plain = nacl.secretbox.open(box, nonce, key);
  if (!plain) throw new Error('decryption failed');
  return Buffer.from(plain).toString('utf8');
}

export function sealBytes(plaintext: Uint8Array, key: Key): string {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const box = nacl.secretbox(plaintext, nonce, key);
  return Buffer.concat([Buffer.from(nonce), Buffer.from(box)]).toString('base64url');
}

export function openBytes(sealed: string, key: Key): Uint8Array {
  const data = Buffer.from(sealed, 'base64url');
  const nonce = new Uint8Array(data.subarray(0, nacl.secretbox.nonceLength));
  const box = new Uint8Array(data.subarray(nacl.secretbox.nonceLength));
  const plain = nacl.secretbox.open(box, nonce, key);
  if (!plain) throw new Error('decryption failed');
  return plain;
}

export function makeChallenge(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function respondChallenge(challenge: string, key: Key): string {
  return crypto.createHmac('sha256', Buffer.from(key)).update(challenge).digest('base64url');
}

export function verifyChallenge(challenge: string, response: string, key: Key): boolean {
  const expected = Buffer.from(respondChallenge(challenge, key));
  const got = Buffer.from(response);
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}

// One-time invite token: 16 random bytes, base64url. High-entropy bearer value
// redeemed exactly once by the host's invite ledger.
export function generateToken(): string {
  return crypto.randomBytes(16).toString('base64url');
}
