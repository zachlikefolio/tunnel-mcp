import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

describe('downloadCloudflared', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function freshDest(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-provision-test-'));
    return path.join(tmpDir, 'cloudflared');
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
});
