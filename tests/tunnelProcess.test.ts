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
});

describe('startCloudflared', () => {
  function writeFake(): string {
    // Fake binary: a node script that prints a trycloudflare URL then idles.
    const fake = path.join(os.tmpdir(), `fake-cf-${Date.now()}-${Math.round(performance.now())}.mjs`);
    fs.writeFileSync(fake, `console.error('INF https://fake-tunnel-1.trycloudflare.com'); setInterval(()=>{}, 1000);`);
    return fake;
  }

  it('resolves with the parsed url from a fake cloudflared and stops it', async () => {
    const fake = writeFake();
    const handle = await startCloudflared(process.execPath, 12345, {
      timeoutMs: 5000, extraArgs: [fake], healthCheck: async () => true,
    });
    expect(handle.publicUrl).toBe('https://fake-tunnel-1.trycloudflare.com');
    handle.stop();
    fs.rmSync(fake);
  });

  it('waits for the edge to become reachable before surfacing the url', async () => {
    const fake = writeFake();
    let probes = 0;
    const handle = await startCloudflared(process.execPath, 0, {
      extraArgs: [fake], intervalMs: 10, attempts: 5,
      healthCheck: async () => ++probes >= 3, // unhealthy twice, then healthy
    });
    expect(probes).toBeGreaterThanOrEqual(3);
    expect(handle.publicUrl).toBe('https://fake-tunnel-1.trycloudflare.com');
    handle.stop();
    fs.rmSync(fake);
  });
});
