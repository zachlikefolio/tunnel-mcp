#!/usr/bin/env node
// Recompute the pinned cloudflared checksums when bumping CLOUDFLARED_VERSION.
//
//   node scripts/refresh-cloudflared-hashes.mjs 2026.6.1
//
// Paste the printed map into src/cloudflared/provision.ts (CLOUDFLARED_SHA256)
// and set CLOUDFLARED_VERSION to the same version. This is a maintainer tool; it
// is not shipped in the published package.
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const version = process.argv[2];
if (!version) {
  console.error('usage: node scripts/refresh-cloudflared-hashes.mjs <version>');
  process.exit(1);
}

const base = `https://github.com/cloudflare/cloudflared/releases/download/${version}`;
const assets = [
  'cloudflared-darwin-amd64.tgz',
  'cloudflared-darwin-arm64.tgz',
  'cloudflared-linux-amd64',
  'cloudflared-linux-arm64',
  'cloudflared-windows-amd64.exe',
];

async function sha256(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`fetch failed for ${url}: ${res.status}`);
  const hash = createHash('sha256');
  await pipeline(Readable.fromWeb(res.body), hash);
  return hash.digest('hex');
}

console.log(`// cloudflared ${version}`);
console.log(`export const CLOUDFLARED_VERSION = '${version}';`);
console.log('export const CLOUDFLARED_SHA256: Record<string, string> = {');
for (const asset of assets) {
  const h = await sha256(`${base}/${asset}`);
  console.log(`  '${asset}': '${h}',`);
}
console.log('};');
