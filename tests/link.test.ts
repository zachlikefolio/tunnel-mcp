import { describe, it, expect } from 'vitest';
import { generateKey, keyToBase64url, generateToken } from '../src/protocol/crypto.js';
import { generateTunnelId, mintLink, parseLink, mintInvite } from '../src/protocol/link.js';

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
    expect(() =>
      parseLink(`wss://x.trycloudflare.com/nope#${Buffer.from(key).toString('base64url')}`),
    ).toThrow();
  });

  it('converts an http:// base to ws:// (not just https->wss)', () => {
    const key = generateKey();
    const id = generateTunnelId();
    const link = mintLink('http://localhost:8080', id, key);
    expect(link).toMatch(/^ws:\/\/localhost:8080\/t\/[0-9a-f]+#.+$/);
    expect(link.startsWith('wss://')).toBe(false);

    const parsed = parseLink(link);
    expect(parsed.tunnelId).toBe(id);
    expect(parsed.key).toEqual(key);
    expect(parsed.wsUrl).toBe(`ws://localhost:8080/t/${id}`);
  });

  it('does not corrupt a host that literally contains "http" elsewhere in the string', () => {
    const key = generateKey();
    const id = generateTunnelId();
    const link = mintLink('https://myhttphost.example', id, key);
    // Only the leading scheme should change; the rest of the host must be untouched.
    expect(link.startsWith('wss://myhttphost.example/')).toBe(true);
    expect(link).toMatch(/^wss:\/\/myhttphost\.example\/t\/[0-9a-f]+#.+$/);

    const parsed = parseLink(link);
    expect(parsed.wsUrl).toBe(`wss://myhttphost.example/t/${id}`);
  });

  it('throws on a bad/wrong-length base64 key fragment', () => {
    const id = generateTunnelId();
    // Valid-looking base64url but decodes to the wrong byte length for a secretbox key.
    expect(() => parseLink(`wss://x.trycloudflare.com/t/${id}#YWJj`)).toThrow(/invalid key length/);
  });

  it('throws on a path that is not /t/<hexid>', () => {
    const key = generateKey();
    const keyPart = keyToBase64url(key);
    expect(() => parseLink(`wss://x.trycloudflare.com/t/nothex#${keyPart}`)).toThrow(
      /link missing tunnel id/,
    );
    expect(() => parseLink(`wss://x.trycloudflare.com/tunnels/abc123#${keyPart}`)).toThrow(
      /link missing tunnel id/,
    );
    expect(() => parseLink(`wss://x.trycloudflare.com/t/abc123/extra#${keyPart}`)).toThrow(
      /link missing tunnel id/,
    );
  });

  it('excludes the "#key" fragment from wsUrl', () => {
    const key = generateKey();
    const id = generateTunnelId();
    const link = mintLink('https://abc-def.trycloudflare.com', id, key);
    const parsed = parseLink(link);
    expect(parsed.wsUrl.includes('#')).toBe(false);
    expect(parsed.wsUrl).not.toContain(keyToBase64url(key));
  });

  it('round-trips tunnelId+key through a URL with a port and multi-level subdomain', () => {
    const key = generateKey();
    const id = generateTunnelId();
    const link = mintLink('https://foo.bar.baz.example.com:9443', id, key);
    const parsed = parseLink(link);
    expect(parsed.tunnelId).toBe(id);
    expect(parsed.key).toEqual(key);
    expect(parsed.wsUrl).toBe(`wss://foo.bar.baz.example.com:9443/t/${id}`);
  });
});

describe('v2 invite links', () => {
  it('mintInvite embeds key and token dot-separated in the fragment; parseLink round-trips both', () => {
    const key = generateKey();
    const token = generateToken();
    const link = mintInvite('https://x.trycloudflare.com', 'abc123', key, token);
    expect(link).toBe(`wss://x.trycloudflare.com/t/abc123#${keyToBase64url(key)}.${token}`);
    const parsed = parseLink(link);
    expect(parsed.tunnelId).toBe('abc123');
    expect(parsed.token).toBe(token);
    expect(keyToBase64url(parsed.key)).toBe(keyToBase64url(key));
  });
  it('parseLink still accepts a v1 (tokenless) link for now, with token undefined', () => {
    const key = generateKey();
    const parsed = parseLink(mintLink('https://x.io', 'abc', key));
    expect(parsed.token).toBeUndefined();
  });
  it('rejects a fragment with more than one dot', () => {
    const key = generateKey();
    expect(() => parseLink(`wss://x.io/t/abc#${keyToBase64url(key)}.tok.extra`)).toThrow();
  });
});
