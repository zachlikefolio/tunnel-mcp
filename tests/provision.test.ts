import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  cloudflaredDownloadUrl,
  cloudflaredBinName,
  downloadCloudflared,
} from '../src/cloudflared/provision.js';

describe('cloudflared provision', () => {
  it('maps darwin/arm64 to the tgz release asset', () => {
    expect(cloudflaredDownloadUrl('darwin', 'arm64'))
      .toBe('https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz');
  });

  it('maps linux/x64 to the amd64 raw binary', () => {
    expect(cloudflaredDownloadUrl('linux', 'x64'))
      .toBe('https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64');
  });

  it('maps win32/x64 to the .exe asset', () => {
    expect(cloudflaredDownloadUrl('win32', 'x64'))
      .toBe('https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe');
  });

  it('names the binary per platform', () => {
    expect(cloudflaredBinName('darwin')).toBe('cloudflared');
    expect(cloudflaredBinName('win32')).toBe('cloudflared.exe');
  });

  it('throws on an unsupported platform', () => {
    expect(() => cloudflaredDownloadUrl('aix' as NodeJS.Platform, 'x64')).toThrow();
  });
});

// Target the RAW (non-.tgz) asset path so `tar` is never invoked — these tests
// run with no real network access and no real `cloudflared` binary.
const RAW_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';

// A distinctive URL ending in `.tgz` so downloadCloudflared takes the tar-extraction branch.
const TGZ_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz';

describe('downloadCloudflared', () => {
  let tmpDir: string | undefined;
  const extraTmpDirs: string[] = [];

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
    for (const d of extraTmpDirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  function freshDest(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-provision-test-'));
    return path.join(tmpDir, 'cloudflared');
  }

  function trackedMkdtemp(prefix: string): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    extraTmpDirs.push(d);
    return d;
  }

  function webStreamFromBytes(bytes: Buffer): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    });
  }

  // Snapshot of os.tmpdir() so we can assert downloadCloudflared leaves no new
  // entries behind once it settles (success or failure).
  function tmpdirSnapshot(): Set<string> {
    return new Set(fs.readdirSync(os.tmpdir()));
  }

  it('a non-OK response produces a readable error with the manual-install pointer and leaves no file at dest', async () => {
    const dest = freshDest();
    const fetchImpl = (async () => ({ ok: false, status: 503, body: null })) as unknown as typeof fetch;

    await expect(downloadCloudflared(RAW_URL, dest, { fetchImpl }))
      .rejects.toThrow(/developers\.cloudflare\.com\/cloudflare-one\/connections\/connect-networks\/downloads\//);

    expect(fs.existsSync(dest)).toBe(false);
  });

  it('a mid-stream failure does not poison the cache with a partial file at dest', async () => {
    const dest = freshDest();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(new TextEncoder().encode('partial-bytes-that-should-never-land'));
        } else {
          controller.error(new Error('simulated mid-stream network failure'));
        }
      },
    });
    const fetchImpl = (async () => ({ ok: true, status: 200, body })) as unknown as typeof fetch;

    await expect(downloadCloudflared(RAW_URL, dest, { fetchImpl }))
      .rejects.toThrow(/cloudflared download\/install failed/);

    expect(fs.existsSync(dest)).toBe(false);
  });

  it('a successful RAW (non-.tgz) download installs the bytes at dest, chmods it executable, and leaves no temp file behind', async () => {
    const dest = freshDest();
    const payload = Buffer.from(`fake-raw-cloudflared-binary-${crypto.randomUUID()}`, 'utf8');
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      body: webStreamFromBytes(payload),
    })) as unknown as typeof fetch;

    const before = tmpdirSnapshot();
    await downloadCloudflared(RAW_URL, dest, { fetchImpl });
    const after = tmpdirSnapshot();

    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.readFileSync(dest)).toEqual(payload);
    expect(fs.statSync(dest).mode & 0o111).not.toBe(0);

    // The module's own temp download file must be cleaned up. Filter to the
    // module's `cloudflared-` prefix so unrelated tmpdir entries created by
    // other test files running in parallel don't cause a false failure.
    const leaked = [...after].filter((e) => !before.has(e) && e.startsWith('cloudflared-'));
    expect(leaked).toEqual([]);
  });

  it('extracts a real .tgz archive, moves the contained `cloudflared` binary to dest, chmods it executable, and cleans up temp artifacts', async () => {
    const dest = freshDest();

    // Build a real tiny gzipped tar containing a single `cloudflared` file.
    const fixtureDir = trackedMkdtemp('tunnel-provision-fixture-src-');
    const binContent = `fake-tgz-cloudflared-binary-${crypto.randomUUID()}`;
    fs.writeFileSync(path.join(fixtureDir, 'cloudflared'), binContent, 'utf8');

    const tgzDir = trackedMkdtemp('tunnel-provision-fixture-tgz-');
    const tgzPath = path.join(tgzDir, 'cloudflared.tgz');
    execFileSync('tar', ['-czf', tgzPath, '-C', fixtureDir, 'cloudflared']);
    const tgzBytes = fs.readFileSync(tgzPath);

    const fetchImpl = (async (url: string | URL) => {
      expect(String(url).endsWith('.tgz')).toBe(true);
      return { ok: true, status: 200, body: webStreamFromBytes(tgzBytes) };
    }) as unknown as typeof fetch;

    const before = tmpdirSnapshot();
    await downloadCloudflared(TGZ_URL, dest, { fetchImpl });
    const after = tmpdirSnapshot();

    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.readFileSync(dest, 'utf8')).toBe(binContent);
    expect(fs.statSync(dest).mode & 0o111).not.toBe(0);

    // The module's own `cloudflared-<uuid>.download` file and
    // `cloudflared-extract-<uuid>` dir must be cleaned up. Filter to the
    // module's `cloudflared-` prefix so unrelated tmpdir entries from other
    // parallel test files don't cause a false failure.
    const leaked = [...after].filter((e) => !before.has(e) && e.startsWith('cloudflared-'));
    expect(leaked).toEqual([]);
  });
});
