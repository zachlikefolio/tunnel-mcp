import crypto from 'node:crypto';
import { Key, keyToBase64url, keyFromBase64url } from './crypto.js';

export interface JoinLink {
  tunnelId: string;
  key: Key;
  wsUrl: string;
}

export function generateTunnelId(): string {
  return crypto.randomBytes(8).toString('hex');
}

export function mintLink(publicBaseUrl: string, tunnelId: string, key: Key): string {
  const wsBase = publicBaseUrl.replace(/^http/, 'ws'); // https->wss, http->ws
  return `${wsBase}/t/${tunnelId}#${keyToBase64url(key)}`;
}

export function parseLink(link: string): JoinLink {
  const hashIdx = link.indexOf('#');
  if (hashIdx < 0) throw new Error('link missing key fragment');
  const urlPart = link.slice(0, hashIdx);
  const keyPart = link.slice(hashIdx + 1);
  const u = new URL(urlPart);
  const m = u.pathname.match(/^\/t\/([0-9a-f]+)$/);
  if (!m) throw new Error('link missing tunnel id');
  return { tunnelId: m[1], key: keyFromBase64url(keyPart), wsUrl: urlPart };
}
