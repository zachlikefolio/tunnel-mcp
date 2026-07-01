import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync, execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { BIN_DIR } from '../config.js';

const RELEASE_BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download';
const MANUAL_INSTALL_POINTER = 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';

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

// Move src -> dest atomically. fs.renameSync is atomic within a filesystem; if src/dest
// straddle devices (EXDEV) fall back to copy+unlink, which is the best available
// approximation (still: dest only appears once the copy has fully completed).
function moveIntoPlace(src: string, dest: string): void {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EXDEV') {
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
    } else {
      throw err;
    }
  }
}

function rmQuiet(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    // best-effort cleanup; nothing useful to do if this fails
  }
}

export interface DownloadDeps {
  fetchImpl?: typeof fetch;
}

/**
 * Download cloudflared from `url` and install it at `destBinPath`.
 *
 * Atomic: the binary is downloaded/extracted into a unique location under
 * os.tmpdir() and only moved into `destBinPath` once it is fully present and
 * valid, so a failed/partial download never poisons the destination (callers
 * that check `fs.existsSync(destBinPath)` to skip re-downloading are safe).
 *
 * Any failure anywhere in this path (network, tar extraction, fs ops) is
 * caught, temp artifacts (and any partially-installed dest) are cleaned up,
 * and a single readable error with a manual-install pointer is thrown.
 */
export async function downloadCloudflared(
  url: string,
  destBinPath: string,
  deps: DownloadDeps = {},
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const unique = crypto.randomUUID();
  const tmpFile = path.join(os.tmpdir(), `cloudflared-${unique}.download`);
  const tmpExtractDir = path.join(os.tmpdir(), `cloudflared-extract-${unique}`);
  let destMayBePartial = false;

  try {
    const res = await fetchImpl(url);
    if (!res.ok || !res.body) {
      const status = !res.ok ? ` (status ${res.status})` : '';
      throw new Error(`cloudflared download failed${status}`);
    }

    await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(tmpFile));

    if (url.endsWith('.tgz')) {
      fs.mkdirSync(tmpExtractDir, { recursive: true });
      execFileSync('tar', ['-xzf', tmpFile, '-C', tmpExtractDir]); // extracts a `cloudflared` binary
      const extractedBin = path.join(tmpExtractDir, 'cloudflared');
      destMayBePartial = true;
      moveIntoPlace(extractedBin, destBinPath);
    } else {
      destMayBePartial = true;
      moveIntoPlace(tmpFile, destBinPath);
    }

    fs.chmodSync(destBinPath, 0o755);
  } catch (err) {
    // Never leave a partial/corrupt binary at the cached path.
    if (destMayBePartial) rmQuiet(destBinPath);
    rmQuiet(tmpFile);
    rmQuiet(tmpExtractDir);
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(`cloudflared download/install failed: ${cause}. Install it manually: ${MANUAL_INSTALL_POINTER}`);
  }

  rmQuiet(tmpFile);
  rmQuiet(tmpExtractDir);
}

export async function ensureCloudflared(): Promise<string> {
  const onpath = onPath();
  if (onpath) return onpath;

  const binName = cloudflaredBinName(process.platform);
  const dest = path.join(BIN_DIR, binName);
  if (fs.existsSync(dest)) return dest;

  fs.mkdirSync(BIN_DIR, { recursive: true });
  const url = cloudflaredDownloadUrl(process.platform, process.arch);
  await downloadCloudflared(url, dest);
  return dest;
}
