import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync, execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { BIN_DIR } from '../config.js';

// Pin a specific cloudflared release and verify the downloaded artifact against a
// SHA-256 committed here (and provenance-attested when the package is published),
// so the tool never executes an unverified binary and never silently picks up a
// changed "latest". Bump both together with:
//   node scripts/refresh-cloudflared-hashes.mjs <version>
export const CLOUDFLARED_VERSION = '2026.6.1';
const RELEASE_BASE = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}`;
const MANUAL_INSTALL_POINTER =
  'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';

// SHA-256 of each pinned release asset (Cloudflare does not publish a checksum
// manifest, so these are computed from the official assets by the refresh script).
export const CLOUDFLARED_SHA256: Record<string, string> = {
  'cloudflared-darwin-amd64.tgz':
    'd7a66b525fe76820da6e5406611b61e48b40de682368ac00454d9158f085be4b',
  'cloudflared-darwin-arm64.tgz':
    'f6d4c439c6c782b83264951d327989ce5e23373acc5942b872411601fedb020d',
  'cloudflared-linux-amd64': '5861a10a438fe8ddcfebb3b830f83966cbf193edafce0fe2eeb198fbae1f7a22',
  'cloudflared-linux-arm64': '59816ce9b16db71f5bc2a86d59b3632a96c8c3ee934bde2bc8641ee83a6070eb',
  'cloudflared-windows-amd64.exe':
    '5253e66f1f493c4e13539749f1aa86fd0c61e3072900fec29a44ba046a6d97e2',
};

function arch2cf(arch: string): string {
  if (arch === 'x64') return 'amd64';
  if (arch === 'arm64') return 'arm64';
  throw new Error(`unsupported arch: ${arch}`);
}

export function cloudflaredBinName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
}

// The release asset filename for this platform/arch — the single key shared by
// the download URL and the pinned-checksum lookup, so they can never disagree.
export function cloudflaredAsset(platform: NodeJS.Platform, arch: string): string {
  const a = arch2cf(arch);
  if (platform === 'darwin') return `cloudflared-darwin-${a}.tgz`;
  if (platform === 'linux') return `cloudflared-linux-${a}`;
  if (platform === 'win32') return `cloudflared-windows-${a}.exe`;
  throw new Error(`unsupported platform: ${platform}`);
}

export function cloudflaredDownloadUrl(platform: NodeJS.Platform, arch: string): string {
  return `${RELEASE_BASE}/${cloudflaredAsset(platform, arch)}`;
}

export function expectedSha256(platform: NodeJS.Platform, arch: string): string {
  const asset = cloudflaredAsset(platform, arch);
  const sha = CLOUDFLARED_SHA256[asset];
  if (!sha) {
    throw new Error(`no pinned checksum for ${asset} (cloudflared ${CLOUDFLARED_VERSION})`);
  }
  return sha;
}

async function sha256File(p: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(p), hash);
  return hash.digest('hex');
}

function onPath(): string | null {
  try {
    const cmd = process.platform === 'win32' ? 'where cloudflared' : 'command -v cloudflared';
    const out = execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    return out.split('\n')[0] || null;
  } catch {
    return null;
  }
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
  expectedSha256?: string; // when set, the downloaded artifact is verified before use
}

/**
 * Download cloudflared from `url` and install it at `destBinPath`.
 *
 * Integrity: when `deps.expectedSha256` is provided, the downloaded artifact is
 * hashed and rejected on any mismatch BEFORE it is extracted, moved into place,
 * or made executable — so a corrupt, tampered, or wrong-version binary never
 * reaches the cache or runs.
 *
 * Atomic: the binary is downloaded/extracted into a unique location under
 * os.tmpdir() and only moved into `destBinPath` once it is fully present and
 * verified, so a failed/partial download never poisons the destination.
 *
 * Any failure anywhere in this path (network, checksum, tar extraction, fs ops)
 * is caught, temp artifacts (and any partially-installed dest) are cleaned up,
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

    // Verify integrity of the downloaded asset before trusting it in any way.
    if (deps.expectedSha256) {
      const actual = await sha256File(tmpFile);
      if (actual.toLowerCase() !== deps.expectedSha256.toLowerCase()) {
        throw new Error(
          `checksum mismatch — expected ${deps.expectedSha256}, got ${actual}. Refusing to install a binary that does not match the pinned cloudflared release`,
        );
      }
    }

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
    throw new Error(
      `cloudflared download/install failed: ${cause}. Install it manually: ${MANUAL_INSTALL_POINTER}`,
    );
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
  await downloadCloudflared(url, dest, {
    expectedSha256: expectedSha256(process.platform, process.arch),
  });
  return dest;
}
