import crypto from 'node:crypto';
import { Key, keyToBase64url, keyFromBase64url } from './crypto.js';

export interface JoinLink {
  tunnelId: string;
  key: Key;
  token: string; // required from protocol v2 (Task 4 flip)
  wsUrl: string;
}

export function generateTunnelId(): string {
  return crypto.randomBytes(8).toString('hex');
}

export function mintInvite(
  publicBaseUrl: string,
  tunnelId: string,
  key: Key,
  token: string,
): string {
  const wsBase = publicBaseUrl.replace(/^http/, 'ws');
  return `${wsBase}/t/${tunnelId}#${keyToBase64url(key)}.${token}`;
}

export function parseLink(link: string): JoinLink {
  const hashIdx = link.indexOf('#');
  if (hashIdx < 0) throw new Error('link missing key fragment');
  const urlPart = link.slice(0, hashIdx);
  const keyPart = link.slice(hashIdx + 1);
  const u = new URL(urlPart);
  const m = u.pathname.match(/^\/t\/([0-9a-f]+)$/);
  if (!m) throw new Error('link missing tunnel id');

  const parts = keyPart.split('.');
  if (parts.length !== 2 || parts[1].length === 0) {
    if (parts.length === 1) {
      throw new Error(
        'this link is from an older tunnel-mcp host — ask them to upgrade, or join with: npx -y tunnel-mcp@0.1',
      );
    }
    throw new Error('malformed link fragment');
  }
  return { tunnelId: m[1], key: keyFromBase64url(parts[0]), token: parts[1], wsUrl: urlPart };
}
