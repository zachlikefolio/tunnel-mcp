import os from 'node:os';
import path from 'node:path';
import type { DohProvider } from './net/doh.js';

export const TUNNEL_HOME = path.join(os.homedir(), '.tunnel');
export const BIN_DIR = path.join(TUNNEL_HOME, 'bin');
export const SESSIONS_DIR = path.join(TUNNEL_HOME, 'sessions');

export const DEFAULT_LISTEN_TIMEOUT_MS = 60_000;
export const DEFAULT_IDLE_TEARDOWN_MS = 30 * 60_000;
// Join links are single-use and expire after this window; a leaked link that
// is never used (or is reused after the guest joined) can't admit anyone.
export const DEFAULT_JOIN_LINK_TTL_MS = 10 * 60_000;

// cloudflared startup
export const CLOUDFLARED_URL_TIMEOUT_MS = 30_000; // wait for the URL line
export const OPEN_RETRY_ATTEMPTS = 3; // re-spawn attempts in session.open

// Host readiness gate. cloudflared prints the quick-tunnel URL before the
// per-tunnel DNS record has propagated (~8–25s). Any early lookup of the name
// via the system resolver would be NXDOMAIN and get negative-cached for the
// zone's SOA minimum (1800s), breaking the guest's join for up to 30 minutes.
// So we confirm liveness via DoH to IP-literal endpoints (which never touch the
// system resolver) before handing out the link.
export const READINESS_GATE_BUDGET_MS = 60_000; // total wait for the record to go live
export const READINESS_INITIAL_DELAY_MS = 5_000; // delay before the first poll (never faster than ~8s)
export const READINESS_POLL_INTERVAL_MS = 1_000; // between DoH polls

// DoH resolver
export const DOH_REQUEST_TIMEOUT_MS = 3_000; // per-request (measured 40–110ms)
export const DOH_PROVIDERS: DohProvider[] = [
  {
    name: 'cloudflare',
    url: (h, t) => `https://1.1.1.1/dns-query?name=${encodeURIComponent(h)}&type=${t}`,
    headers: { accept: 'application/dns-json' },
  },
  {
    name: 'cloudflare2',
    url: (h, t) => `https://1.0.0.1/dns-query?name=${encodeURIComponent(h)}&type=${t}`,
    headers: { accept: 'application/dns-json' },
  },
  // dns.google's cert carries an 8.8.8.8 SAN; the JSON endpoint is /resolve
  // (NOT /dns-query, which expects wire format). IP-literal, so no system DNS.
  {
    name: 'google',
    url: (h, t) => `https://8.8.8.8/resolve?name=${encodeURIComponent(h)}&type=${t}`,
  },
];

// Guest connection bounds (so a black-hole/lagging resolver can't hang the join)
export const GUEST_HANDSHAKE_TIMEOUT_MS = 15_000; // ws handshake (DNS+TCP+TLS+upgrade)
export const GUEST_CONNECT_DEADLINE_MS = 20_000; // overall connect+auth deadline (> handshake)
export const GUEST_SYS_LOOKUP_TIMEOUT_MS = 2_000; // bound the system-first lookup before DoH fallback
export const DOH_GUEST_RETRIES = 3; // DoH attempts in the guest fallback
export const DOH_GUEST_RETRY_DELAY_MS = 700; // backoff between guest DoH attempts

// Rooms
export const MAX_ROOM_MEMBERS = 16; // includes the host → at most 15 ws members
export const PROTOCOL_VERSION = 2;
