import crypto from 'node:crypto';
import { Key, keyToBase64url, keyFromBase64url } from './crypto.js';

export interface JoinLink {
  tunnelId: string;
  key: Key;
  token?: string; // required from protocol v2 (Task 4 flip); optional during migration
  wsUrl: string;
}

export function generateTunnelId(): string {
  return crypto.randomBytes(8).toString('hex');
}

export function mintLink(publicBaseUrl: string, tunnelId: string, key: Key): string {
  const wsBase = publicBaseUrl.replace(/^http/, 'ws'); // https->wss, http->ws
  return `${wsBase}/t/${tunnelId}#${keyToBase64url(key)}`;
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
  if (parts.length > 2) throw new Error('malformed link fragment');
  const key = keyFromBase64url(parts[0]);
  const token = parts.length === 2 && parts[1].length > 0 ? parts[1] : undefined;
  if (parts.length === 2 && token === undefined) throw new Error('malformed link fragment');
  return { tunnelId: m[1], key, token, wsUrl: urlPart };
}
