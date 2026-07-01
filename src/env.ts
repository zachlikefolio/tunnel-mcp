/**
 * True only when an env var is set to a meaningfully "on" value. Unset, '', '0',
 * 'false', 'no', and 'off' (any case, trimmed) all read as off — so `FOO=0`
 * disables a flag instead of accidentally enabling it (a plain `process.env.FOO`
 * truthiness check treats "0"/"false" as true).
 */
export function envFlag(name: string): boolean {
  const v = process.env[name];
  if (v === undefined) return false;
  const s = v.trim().toLowerCase();
  return s !== '' && s !== '0' && s !== 'false' && s !== 'no' && s !== 'off';
}

export type ReachabilityMode = 'warn' | 'strict' | 'off';

/**
 * How `tunnel_open` treats a host-side reachability-probe failure:
 *   warn   (default) — open anyway, surface a warning; the guest is the real test
 *   strict           — fail open() if the host can't reach the public URL
 *   off              — skip the probe entirely
 * Reads `TUNNEL_REACHABILITY`; falls back to the deprecated
 * `TUNNEL_SKIP_REACHABILITY_CHECK` (== off) shipped in 0.1.2; defaults to warn.
 */
export function reachabilityMode(): ReachabilityMode {
  const raw = (process.env.TUNNEL_REACHABILITY ?? '').trim().toLowerCase();
  if (raw === 'warn' || raw === 'strict' || raw === 'off') return raw;
  if (envFlag('TUNNEL_SKIP_REACHABILITY_CHECK')) return 'off';
  return 'warn';
}
