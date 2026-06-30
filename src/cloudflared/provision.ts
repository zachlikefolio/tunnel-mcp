import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { BIN_DIR } from '../config.js';

const RELEASE_BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download';

function arch2cf(arch: string): string {
  if (arch === 'x64') return 'amd64';
  if (arch === 'arm64') return 'arm64';
  throw new Error(`unsupported arch: ${arch}`);
}

export function cloudflaredBinName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
}

export function cloudflaredDownloadUrl(platform: NodeJS.Platform, arch: string): string {
  const a = arch2cf(arch);
  if (platform === 'darwin') return `${RELEASE_BASE}/cloudflared-darwin-${a}.tgz`;
  if (platform === 'linux') return `${RELEASE_BASE}/cloudflared-linux-${a}`;
  if (platform === 'win32') return `${RELEASE_BASE}/cloudflared-windows-${a}.exe`;
  throw new Error(`unsupported platform: ${platform}`);
}

function onPath(): string | null {
  try {
    const cmd = process.platform === 'win32' ? 'where cloudflared' : 'command -v cloudflared';
    const out = execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return out.split('\n')[0] || null;
  } catch { return null; }
}

export async function ensureCloudflared(): Promise<string> {
  const onpath = onPath();
  if (onpath) return onpath;

  const binName = cloudflaredBinName(process.platform);
  const dest = path.join(BIN_DIR, binName);
  if (fs.existsSync(dest)) return dest;

  fs.mkdirSync(BIN_DIR, { recursive: true });
  const url = cloudflaredDownloadUrl(process.platform, process.arch);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`cloudflared download failed (${res.status}). Install it manually: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/`);

  if (url.endsWith('.tgz')) {
    const tgz = path.join(os.tmpdir(), `cloudflared-${Date.now()}.tgz`);
    await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(tgz));
    execFileSync('tar', ['-xzf', tgz, '-C', BIN_DIR]); // extracts a `cloudflared` binary
    fs.rmSync(tgz);
  } else {
    await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(dest));
  }
  fs.chmodSync(dest, 0o755);
  return dest;
}
