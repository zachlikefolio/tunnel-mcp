import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { parsePublicUrl, startCloudflared } from '../src/cloudflared/tunnelProcess.js';
import type { DohResult } from '../src/net/doh.js';

const RESOLVED: DohResult = { klass: 'RESOLVED', addresses: [{ address: '1.2.3.4', family: 4 }] };
const NX: DohResult = { klass: 'NXDOMAIN', addresses: [] };
const INDET: DohResult = { klass: 'INDETERMINATE', addresses: [] };

// A resolveHost that returns a scripted sequence (last entry repeats).
function scriptedResolve(seq: DohResult[]) {
  let i = 0;
  return vi.fn(async () => seq[Math.min(i++, seq.length - 1)]);
}

// Fast gate knobs so tests don't wait real propagation windows.
const FAST = { initialDelayMs: 1, pollIntervalMs: 2, budgetMs: 5000 };

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

describe('startCloudflared readiness gate', () => {
  function writeFake(): string {
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
  function writeFakeThenExit(): string {
    const fake = path.join(
      os.tmpdir(),
      `fake-cf-exit-${Date.now()}-${Math.round(performance.now())}.mjs`,
    );
    fs.writeFileSync(
      fake,
      `console.error('INF https://fake-tunnel-1.trycloudflare.com'); setTimeout(()=>process.exit(1), 30);`,
    );
    return fake;
  }

  it('waits until DoH shows the record live (NXDOMAIN, NXDOMAIN, then RESOLVED)', async () => {
    const fake = writeFake();
    try {
      const resolveHost = scriptedResolve([NX, NX, RESOLVED]);
      const handle = await startCloudflared(process.execPath, 0, {
        extraArgs: [fake],
        resolveHost,
        ...FAST,
      });
      expect(handle.publicUrl).toBe('https://fake-tunnel-1.trycloudflare.com');
      expect(resolveHost.mock.calls.length).toBeGreaterThanOrEqual(3);
      handle.stop();
    } finally {
      fs.rmSync(fake);
    }
  });

  it('returns the link optimistically after the budget when the record never resolves (all NXDOMAIN)', async () => {
    const fake = writeFake();
    try {
      const resolveHost = scriptedResolve([NX]);
      const handle = await startCloudflared(process.execPath, 0, {
        extraArgs: [fake],
        resolveHost,
        initialDelayMs: 1,
        pollIntervalMs: 2,
        budgetMs: 25,
      });
      expect(handle.publicUrl).toBe('https://fake-tunnel-1.trycloudflare.com');
      handle.stop();
    } finally {
      fs.rmSync(fake);
    }
  });

  it('returns the link optimistically when DoH itself is unavailable (INDETERMINATE)', async () => {
    const fake = writeFake();
    try {
      const resolveHost = scriptedResolve([INDET]);
      const handle = await startCloudflared(process.execPath, 0, {
        extraArgs: [fake],
        resolveHost,
        initialDelayMs: 1,
        pollIntervalMs: 2,
        budgetMs: 25,
      });
      expect(handle.publicUrl).toBe('https://fake-tunnel-1.trycloudflare.com');
      handle.stop();
    } finally {
      fs.rmSync(fake);
    }
  });

  it('skips the gate entirely when DoH is disabled (never calls resolveHost)', async () => {
    const fake = writeFake();
    try {
      const resolveHost = scriptedResolve([RESOLVED]);
      const handle = await startCloudflared(process.execPath, 0, {
        extraArgs: [fake],
        resolveHost,
        dohEnabled: false,
        pollIntervalMs: 1,
      });
      expect(handle.publicUrl).toBe('https://fake-tunnel-1.trycloudflare.com');
      expect(resolveHost).not.toHaveBeenCalled();
      handle.stop();
    } finally {
      fs.rmSync(fake);
    }
  });

  it('rejects (so session.open can re-spawn) if cloudflared exits during the gate', async () => {
    const fake = writeFakeThenExit();
    try {
      const resolveHost = scriptedResolve([NX]); // never resolves, so the gate is still waiting when it exits
      await expect(
        startCloudflared(process.execPath, 0, {
          extraArgs: [fake],
          resolveHost,
          initialDelayMs: 1,
          pollIntervalMs: 5,
          budgetMs: 5000,
        }),
      ).rejects.toThrow(/cloudflared exited/);
    } finally {
      fs.rmSync(fake);
    }
  });

  it('the gate never resolves the tunnel hostname via fetch/system DNS (no poisoning)', async () => {
    const fake = writeFake();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const resolveHost = scriptedResolve([RESOLVED]);
      const handle = await startCloudflared(process.execPath, 0, {
        extraArgs: [fake],
        resolveHost,
        ...FAST,
      });
      // The old poisoner did fetch(<tunnel url>); the gate must never fetch the
      // hostname. Compare the exact URL host (not a substring) so a DoH request
      // whose query happens to contain the name doesn't false-positive.
      const touchedHost = fetchSpy.mock.calls.some((c) => {
        try {
          return new URL(String(c[0])).hostname === 'fake-tunnel-1.trycloudflare.com';
        } catch {
          return false;
        }
      });
      expect(touchedHost).toBe(false);
      handle.stop();
    } finally {
      fetchSpy.mockRestore();
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
      ).rejects.toThrow(/did not report a URL/);
    } finally {
      fs.rmSync(fake);
    }
  });

  it('rejects when the fake binary exits immediately without printing a url', async () => {
    const fake = path.join(
      os.tmpdir(),
      `fake-cf-exit0-${Date.now()}-${Math.round(performance.now())}.mjs`,
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
      `no-such-cloudflared-${Date.now()}-${Math.round(performance.now())}`,
    );
    expect(fs.existsSync(missingBin)).toBe(false);
    await expect(
      startCloudflared(missingBin, 0, { extraArgs: [], timeoutMs: 5000 }),
    ).rejects.toThrow();
  });
});
