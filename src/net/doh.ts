import { isIP } from 'node:net';
import { DOH_PROVIDERS, DOH_REQUEST_TIMEOUT_MS } from '../config.js';

export type DohClass = 'RESOLVED' | 'NXDOMAIN' | 'INDETERMINATE';

export interface DohAddress {
  address: string;
  family: 4 | 6;
}

export interface DohResult {
  klass: DohClass;
  addresses: DohAddress[]; // populated only when RESOLVED
}

export interface DohProvider {
  name: string;
  url: (host: string, type: 'A' | 'AAAA') => string;
  headers?: Record<string, string>;
}

interface DohJson {
  Status?: number;
  Answer?: Array<{ type?: number; data?: string }>;
}

// Query ONE provider for ONE record type over an IP-literal endpoint (so it can
// never re-enter the system resolver). Never throws; classifies every failure.
export async function dohQueryOnce(
  provider: DohProvider,
  host: string,
  family: 4 | 6,
  timeoutMs: number = DOH_REQUEST_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<DohResult> {
  const type = family === 6 ? 'AAAA' : 'A';
  const rrType = family === 6 ? 28 : 1;
  try {
    const r = await fetchImpl(provider.url(host, type), {
      headers: { accept: 'application/dns-json', ...(provider.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return { klass: 'INDETERMINATE', addresses: [] };
    let j: DohJson;
    try {
      j = (await r.json()) as DohJson; // captive-portal HTML / non-JSON body → catch below
    } catch {
      return { klass: 'INDETERMINATE', addresses: [] };
    }
    if (!j || typeof j.Status !== 'number') return { klass: 'INDETERMINATE', addresses: [] };
    if (j.Status === 3) return { klass: 'NXDOMAIN', addresses: [] }; // not live yet → keep polling
    if (j.Status !== 0) return { klass: 'INDETERMINATE', addresses: [] }; // SERVFAIL(2) etc → unreachable-ish
    const answers = Array.isArray(j.Answer) ? j.Answer : [];
    const addresses: DohAddress[] = answers
      .filter((a) => a.type === rrType && typeof a.data === 'string' && isIP(a.data) === family)
      .map((a) => ({ address: a.data as string, family }));
    if (!addresses.length) return { klass: 'NXDOMAIN', addresses: [] }; // A-less / CNAME-only → not routable yet
    return { klass: 'RESOLVED', addresses };
  } catch {
    return { klass: 'INDETERMINATE', addresses: [] }; // refused/timeout/ENETUNREACH/TLS reset
  }
}

// Try providers in order; first RESOLVED wins. Fold classes: any NXDOMAIN (and
// no RESOLVED) → NXDOMAIN; otherwise INDETERMINATE (DoH itself unavailable).
export async function dohResolve(
  host: string,
  family: 4 | 6,
  providers: DohProvider[] = DOH_PROVIDERS,
  timeoutMs: number = DOH_REQUEST_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<DohResult> {
  let sawNx = false;
  for (const p of providers) {
    const res = await dohQueryOnce(p, host, family, timeoutMs, fetchImpl);
    if (res.klass === 'RESOLVED') return res;
    if (res.klass === 'NXDOMAIN') sawNx = true;
  }
  return { klass: sawNx ? 'NXDOMAIN' : 'INDETERMINATE', addresses: [] };
}
