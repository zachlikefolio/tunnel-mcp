import { describe, it, expect, vi } from 'vitest';
import { makeGuestLookup } from '../src/relay/guestLookup.js';
import type { DohResult } from '../src/net/doh.js';

type Addr = { address: string; family: number };
function call(
  lookup: ReturnType<typeof makeGuestLookup>,
  host: string,
  options: Record<string, unknown> | number,
): Promise<{ err: NodeJS.ErrnoException | null; address?: string | Addr[]; family?: number }> {
  return new Promise((resolve) => {
    lookup(host, options as never, (err, address, family) => resolve({ err, address, family }));
  });
}

const RESOLVED = (address: string, family: 4 | 6 = 4): DohResult => ({
  klass: 'RESOLVED',
  addresses: [{ address, family }],
});
const NX: DohResult = { klass: 'NXDOMAIN', addresses: [] };

// Fake system lookup honoring the all/family contract.
const sysOk =
  (addr: string, fam = 4) =>
  (h: string, o: { all?: boolean }, cb: (e: null, a: unknown, f?: number) => void) =>
    cb(null, o.all ? [{ address: addr, family: fam }] : addr, fam);
const sysFail =
  (code = 'ENOTFOUND') =>
  (_h: string, _o: unknown, cb: (e: NodeJS.ErrnoException) => void) =>
    cb(Object.assign(new Error('nf'), { code }) as NodeJS.ErrnoException);
const sysHang = () => () => {};

describe('makeGuestLookup', () => {
  it('system-first success never touches DoH, and returns the array shape when all:true', async () => {
    const doh = vi.fn(async () => RESOLVED('9.9.9.9'));
    const lookup = makeGuestLookup({ sys: sysOk('1.2.3.4') as never, doh });
    const r = await call(lookup, 'host', { all: true, family: 0 });
    expect(doh).not.toHaveBeenCalled();
    expect(r.err).toBeNull();
    expect(r.address).toEqual([{ address: '1.2.3.4', family: 4 }]);
  });

  it('returns the 3-arg single form when all is not set', async () => {
    const lookup = makeGuestLookup({ sys: sysOk('1.2.3.4') as never, doh: vi.fn(async () => NX) });
    const r = await call(lookup, 'host', { family: 4 });
    expect(r.address).toBe('1.2.3.4');
    expect(r.family).toBe(4);
  });

  it('falls back to DoH when the system resolver fails (ENOTFOUND)', async () => {
    const doh = vi.fn(async () => RESOLVED('5.6.7.8'));
    const lookup = makeGuestLookup({ sys: sysFail() as never, doh });
    const r = await call(lookup, 'host', { all: true });
    expect(doh).toHaveBeenCalledWith('host', 4);
    expect(r.address).toEqual([{ address: '5.6.7.8', family: 4 }]);
  });

  it('falls back to DoH when the system resolver hangs past its bound', async () => {
    const doh = vi.fn(async () => RESOLVED('5.6.7.8'));
    const lookup = makeGuestLookup({ sys: sysHang() as never, doh, sysTimeoutMs: 5 });
    const r = await call(lookup, 'host', {});
    expect(doh).toHaveBeenCalled();
    expect(r.address).toBe('5.6.7.8');
  });

  it('queries AAAA and returns a family-6 address when family:6', async () => {
    const doh = vi.fn(async () => RESOLVED('2606:4700::1', 6));
    const lookup = makeGuestLookup({ sys: sysFail() as never, doh });
    const r = await call(lookup, 'host', { family: 6 });
    expect(doh).toHaveBeenCalledWith('host', 6);
    expect(r.address).toBe('2606:4700::1');
    expect(r.family).toBe(6);
  });

  it('after system + all DoH retries fail, calls back a diagnosable ENOTFOUND', async () => {
    const doh = vi.fn(async () => NX);
    const lookup = makeGuestLookup({ sys: sysFail() as never, doh, retries: 3, retryDelayMs: 1 });
    const r = await call(lookup, 'my.trycloudflare.com', {});
    expect(doh).toHaveBeenCalledTimes(3);
    expect(r.err?.code).toBe('ENOTFOUND');
    expect(r.err?.message).toContain('my.trycloudflare.com');
    expect(r.err?.message.toLowerCase()).toContain('doh');
  });

  it('when TUNNEL_DOH is disabled, a system failure fails immediately without DoH', async () => {
    const doh = vi.fn(async () => RESOLVED('5.6.7.8'));
    const lookup = makeGuestLookup({ dohEnabled: false, sys: sysFail() as never, doh });
    const r = await call(lookup, 'host', {});
    expect(doh).not.toHaveBeenCalled();
    expect(r.err?.code).toBe('ENOTFOUND');
  });
});
