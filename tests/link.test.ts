import { describe, it, expect } from 'vitest';
import { generateKey } from '../src/protocol/crypto.js';
import { generateTunnelId, mintLink, parseLink } from '../src/protocol/link.js';

describe('link', () => {
  it('mints an https base into a wss link and parses it back', () => {
    const key = generateKey();
    const id = generateTunnelId();
    const link = mintLink('https://abc-def.trycloudflare.com', id, key);
    expect(link).toMatch(/^wss:\/\/abc-def\.trycloudflare\.com\/t\/[0-9a-f]+#.+$/);

    const parsed = parseLink(link);
    expect(parsed.tunnelId).toBe(id);
    expect(parsed.key).toEqual(key);
    expect(parsed.wsUrl).toBe(`wss://abc-def.trycloudflare.com/t/${id}`);
  });

  it('rejects a link without a key fragment', () => {
    expect(() => parseLink('wss://x.trycloudflare.com/t/abcd')).toThrow();
  });

  it('rejects a link without a tunnel id', () => {
    const key = generateKey();
    expect(() => parseLink(`wss://x.trycloudflare.com/nope#${Buffer.from(key).toString('base64url')}`)).toThrow();
  });
});
