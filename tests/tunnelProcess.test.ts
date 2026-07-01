import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { parsePublicUrl, startCloudflared } from '../src/cloudflared/tunnelProcess.js';

describe('parsePublicUrl', () => {
  it('extracts a trycloudflare url from a log line', () => {
    const line = '2026-06-30T00:00:00Z INF +-----+ https://blue-cat-42.trycloudflare.com +-----+';
    expect(parsePublicUrl(line)).toBe('https://blue-cat-42.trycloudflare.com');
  });
  it('returns null for unrelated lines', () => {
    expect(parsePublicUrl('INF starting tunnel')).toBeNull();
  });
  it('returns null for a non-trycloudflare https url', () => {
    expect(parsePublicUrl('INF serving on https://example.com')).toBeNull();
  });
});

describe('startCloudflared', () => {
  function writeFake(): string {
    // Fake binary: a node script that prints a trycloudflare URL then idles.
    const fake = path.join(
      os.tmpdir(),
      `fake-cf-${Date.now()}-${Math.round(performance.now())}.mjs`,
    );
    fs.writeFileSync(
      fake,
      `console.error('INF https://fake-tunnel-1.trycloudflare.com'); setInterval(()=>{}, 1000);`,
    );
    return fake;
  }

  it('resolves with the parsed url from a fake cloudflared and stops it', async () => {
    const fake = writeFake();
    const handle = await startCloudflared(process.execPath, 12345, {
      timeoutMs: 5000,
      extraArgs: [fake],
      healthCheck: async () => true,
    });
    expect(handle.publicUrl).toBe('https://fake-tunnel-1.trycloudflare.com');
    handle.stop();
    fs.rmSync(fake);
  });

  it('waits for the edge to become reachable before surfacing the url', async () => {
    const fake = writeFake();
    try {
      let probes = 0;
      const handle = await startCloudflared(process.execPath, 0, {
        extraArgs: [fake],
        intervalMs: 10,
        attempts: 5,
        healthCheck: async () => ++probes >= 3, // unhealthy twice, then healthy
      });
      expect(probes).toBeGreaterThanOrEqual(3);
      expect(handle.publicUrl).toBe('https://fake-tunnel-1.trycloudflare.com');
      handle.stop();
    } finally {
      fs.rmSync(fake);
    }
  });

  it('rejects (without hanging) when the edge is never reachable', async () => {
    const fake = writeFake();
    try {
      await expect(
        startCloudflared(process.execPath, 0, {
          extraArgs: [fake],
          intervalMs: 5,
          attempts: 3,
          healthCheck: async () => false,
        }),
      ).rejects.toThrow(/never became reachable/);
    } finally {
      fs.rmSync(fake);
    }
  });

  it('treats a throwing health-check as a failed attempt and still rejects', async () => {
    const fake = writeFake();
    try {
      await expect(
        startCloudflared(process.execPath, 0, {
          extraArgs: [fake],
          intervalMs: 5,
          attempts: 3,
          healthCheck: async () => {
            throw new Error('boom');
          },
        }),
      ).rejects.toThrow(/never became reachable/);
    } finally {
      fs.rmSync(fake);
    }
  });

  it('treats a hanging health-check as a failed attempt and rejects within a bounded time (no half-open state)', async () => {
    const fake = writeFake();
    try {
      const start = Date.now();
      await expect(
        startCloudflared(process.execPath, 0, {
          extraArgs: [fake],
          intervalMs: 5,
          attempts: 3,
          probeTimeoutMs: 20,
          healthCheck: () =>
            new Promise(() => {
              /* never resolves */
            }),
        }),
      ).rejects.toThrow(/never became reachable/);
      // 3 attempts * (20ms probe timeout + 5ms interval) plus slack — well under
      // vitest's default test timeout, proving the loop can't hang forever.
      expect(Date.now() - start).toBeLessThan(2000);
    } finally {
      fs.rmSync(fake);
    }
  });

  it('rejects when cloudflared never reports a url in time', async () => {
    const fake = path.join(
      os.tmpdir(),
      `fake-cf-nourl-${Date.now()}-${Math.round(performance.now())}.mjs`,
    );
    fs.writeFileSync(fake, `console.error('INF starting tunnel'); setInterval(()=>{}, 1000);`);
    try {
      await expect(
        startCloudflared(process.execPath, 0, { extraArgs: [fake], timeoutMs: 100 }),
      ).rejects.toThrow(/did not report a URL in time/);
    } finally {
      fs.rmSync(fake);
    }
  });

  it('rejects when the fake binary exits immediately without printing a url', async () => {
    const fake = path.join(
      os.tmpdir(),
      `fake-cf-exit-${Date.now()}-${Math.round(performance.now())}.mjs`,
    );
    fs.writeFileSync(fake, `console.error('INF no url here, just exiting'); process.exit(0);`);
    try {
      await expect(
        startCloudflared(process.execPath, 0, { extraArgs: [fake], timeoutMs: 5000 }),
      ).rejects.toThrow(/cloudflared exited/);
    } finally {
      fs.rmSync(fake);
    }
  });

  it('rejects via the error event when spawning a non-existent binary path', async () => {
    const missingBin = path.join(
      os.tmpdir(),
      `no-such-cloudflared-binary-${Date.now()}-${Math.round(performance.now())}`,
    );
    // Sanity check: nothing lives at this path.
    expect(fs.existsSync(missingBin)).toBe(false);
    await expect(
      startCloudflared(missingBin, 0, { extraArgs: [], timeoutMs: 5000 }),
    ).rejects.toThrow();
  });
});
