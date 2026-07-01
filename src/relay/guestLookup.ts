import { lookup as sysLookup } from 'node:dns';
import type { LookupOptions } from 'node:dns';
import { dohResolve } from '../net/doh.js';
import { envFlag } from '../env.js';
import {
  GUEST_SYS_LOOKUP_TIMEOUT_MS,
  DOH_GUEST_RETRIES,
  DOH_GUEST_RETRY_DELAY_MS,
} from '../config.js';

type Addr = { address: string; family: number };
type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: string | Addr[],
  family?: number,
) => void;
type SysLookup = (hostname: string, options: LookupOptions, callback: LookupCallback) => void;

export interface GuestLookupOpts {
  dohEnabled?: boolean;
  doh?: typeof dohResolve;
  sys?: SysLookup;
  sysTimeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
}

// DoH fallback is ON by default; only an explicit off/0/false/no disables it.
export function dohEnabledByDefault(): boolean {
  return process.env.TUNNEL_DOH === undefined || envFlag('TUNNEL_DOH');
}

/**
 * A drop-in `dns.lookup` for the guest WebSocket. Tries the system resolver
 * first (respects split-horizon/corp DNS, and is what most guests need), then —
 * only on failure — falls back to DoH, so a guest whose resolver lags or holds a
 * stale NXDOMAIN negative cache still connects. Returns only an address; ws/tls
 * keep SNI/Host = the hostname, so returning a DoH IP does not break routing.
 */
export function makeGuestLookup(o: GuestLookupOpts = {}) {
  const dohEnabled = o.dohEnabled ?? dohEnabledByDefault();
  const doh = o.doh ?? dohResolve;
  const sys = o.sys ?? (sysLookup as unknown as SysLookup);
  const sysTimeoutMs = o.sysTimeoutMs ?? GUEST_SYS_LOOKUP_TIMEOUT_MS;
  const retries = o.retries ?? DOH_GUEST_RETRIES;
  const retryDelayMs = o.retryDelayMs ?? DOH_GUEST_RETRY_DELAY_MS;

  return function guestLookup(
    hostname: string,
    options: LookupOptions | number,
    callback: LookupCallback,
  ) {
    const opts: LookupOptions = typeof options === 'number' ? { family: options } : (options ?? {});
    const wantAll = opts.all === true;
    const family: 4 | 6 = opts.family === 6 ? 6 : 4; // prefer A/IPv4; AAAA only when explicitly asked

    let settled = false;
    const done: LookupCallback = (err, address, fam) => {
      if (settled) return;
      settled = true;
      callback(err, address, fam);
    };

    // Stage 1: system resolver first, bounded so a poisoned/lagging getaddrinfo
    // can't stall for seconds before we fall back to DoH.
    let sysSettled = false;
    const sysTimer = setTimeout(() => {
      if (!sysSettled) {
        sysSettled = true;
        goDoh(new Error('system lookup timed out'));
      }
    }, sysTimeoutMs);

    sys(hostname, opts, (err, address, fam) => {
      if (sysSettled) return;
      sysSettled = true;
      clearTimeout(sysTimer);
      const ok = !err && (wantAll ? Array.isArray(address) && address.length > 0 : !!address);
      if (ok) return done(null, address, fam);
      goDoh(err ?? new Error(`getaddrinfo failed for ${hostname}`));
    });

    function goDoh(sysErr: Error) {
      if (!dohEnabled) return fail(sysErr);
      let attempt = 0;
      const tryOnce = () => {
        doh(hostname, family)
          .then((res) => {
            if (res.klass === 'RESOLVED') {
              if (wantAll)
                return done(
                  null,
                  res.addresses.map((a) => ({ address: a.address, family: a.family })),
                );
              return done(null, res.addresses[0].address, res.addresses[0].family);
            }
            // NXDOMAIN (still propagating) or INDETERMINATE (DoH blocked): retry a few times.
            if (++attempt < retries) return void setTimeout(tryOnce, retryDelayMs);
            fail(sysErr);
          })
          .catch(() =>
            ++attempt < retries ? void setTimeout(tryOnce, retryDelayMs) : fail(sysErr),
          );
      };
      tryOnce();
    }

    function fail(sysErr: Error) {
      const e = new Error(
        `could not resolve ${hostname}: system resolver failed (${sysErr.message}) and DoH (1.1.1.1/1.0.0.1/8.8.8.8) also failed`,
      ) as NodeJS.ErrnoException;
      e.code = 'ENOTFOUND';
      done(e, wantAll ? [] : '', family);
    }
  };
}
