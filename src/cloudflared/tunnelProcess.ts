import { spawn, ChildProcess } from 'node:child_process';
import {
  CLOUDFLARED_URL_TIMEOUT_MS,
  CLOUDFLARED_HEALTH_ATTEMPTS,
  CLOUDFLARED_HEALTH_INTERVAL_MS,
} from '../config.js';

export interface TunnelHandle {
  publicUrl: string;
  stop(): void;
}

export interface StartOptions {
  timeoutMs?: number; // wait for the URL line
  extraArgs?: string[]; // tests: launch a fake binary
  attempts?: number; // edge-reachability probes
  intervalMs?: number; // delay between probes
  healthCheck?: (url: string) => Promise<boolean>; // default: HTTP reachability
  probeTimeoutMs?: number; // per-attempt budget for a health probe
  skipHealthCheck?: boolean; // bypass the probe (host DNS blocked but guest resolves)
}

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

// Bounds a single probe so a black-hole connection (or a caller-supplied
// healthCheck that hangs/throws) can't stall the health-check loop forever.
const DEFAULT_PROBE_TIMEOUT_MS = 5000;

interface ProbeResult {
  ok: boolean;
  reason?: string; // why the last probe failed (surfaced in the error)
}

export function parsePublicUrl(line: string): string | null {
  const m = line.match(URL_RE);
  return m ? m[0] : null;
}

// undici (Node's global fetch) reports the real network error on `.cause`, e.g.
// a DNS failure surfaces as `cause.code === 'ENOTFOUND'`. Pull that out so the
// caller can tell "DNS can't resolve the host" apart from "edge not ready yet".
export function describeProbeError(e: unknown): string {
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  const code = err?.cause?.code;
  if (code) return err.cause?.message ? `${code}: ${err.cause.message}` : code;
  if (err?.name === 'TimeoutError') return 'probe timed out';
  return err?.message || 'unknown error';
}

// Any HTTP response (even 404/502/426) means the Cloudflare edge is routing to
// us. A thrown error carries why it failed (DNS, TLS, refused, timeout).
async function reachabilityProbe(url: string, probeTimeoutMs: number): Promise<ProbeResult> {
  try {
    await fetch(url, { method: 'GET', signal: AbortSignal.timeout(probeTimeoutMs) });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: describeProbeError(e) };
  }
}

// Back-compat boolean probe (kept for external callers/tests).
export async function defaultHealthCheck(url: string): Promise<boolean> {
  return (await reachabilityProbe(url, DEFAULT_PROBE_TIMEOUT_MS)).ok;
}

// Builds the actionable "never became reachable" error. Names the host and,
// when the failure looks like DNS resolution, points at *.trycloudflare.com
// blocking — the single most common real-world cause. Always mentions the
// escape hatch, since the guest's network (not the host's) is what must reach
// the URL for messaging.
export function unreachableMessage(url: string, attempts: number, lastReason?: string): string {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* keep the raw url */
  }
  const dnsish = !!lastReason && /ENOTFOUND|EAI_AGAIN|getaddrinfo|\bdns\b/i.test(lastReason);
  let msg = `cloudflared reported ${url} but it never became reachable from this machine after ${attempts} probe(s)`;
  if (lastReason) msg += ` (last error: ${lastReason})`;
  msg += '.';
  if (dnsish) {
    msg +=
      ` This machine can't resolve ${host} — your DNS or network may be blocking *.trycloudflare.com` +
      ` (common on filtered/corporate networks and some public DNS resolvers). You and your guest both` +
      ` need to be able to resolve it.`;
  }
  msg += ` If you're confident your guest's network can reach the URL, set TUNNEL_SKIP_REACHABILITY_CHECK=1 to open the tunnel anyway.`;
  return msg;
}

// Races a single probe against a per-attempt timeout so that a caller-supplied
// `check` that throws, rejects, or simply never resolves can never leave the
// loop (and therefore the outer startCloudflared promise) hanging.
function probeOnce(
  url: string,
  probe: (u: string) => Promise<ProbeResult>,
  probeTimeoutMs: number,
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: ProbeResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const timer = setTimeout(
      () => finish({ ok: false, reason: 'probe timed out' }),
      probeTimeoutMs,
    );
    Promise.resolve()
      .then(() => probe(url))
      .then((r) => {
        clearTimeout(timer);
        finish(r);
      })
      .catch((err) => {
        clearTimeout(timer);
        finish({ ok: false, reason: describeProbeError(err) });
      });
  });
}

async function waitHealthy(
  url: string,
  attempts: number,
  intervalMs: number,
  probe: (u: string) => Promise<ProbeResult>,
  probeTimeoutMs: number,
): Promise<ProbeResult> {
  let lastReason: string | undefined;
  for (let i = 0; i < attempts; i++) {
    const r = await probeOnce(url, probe, probeTimeoutMs);
    if (r.ok) return r;
    lastReason = r.reason;
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  return { ok: false, reason: lastReason };
}

/**
 * `extraArgs` exists for tests: it lets a fake binary (e.g. `node fake.mjs`) be
 * launched in place of `cloudflared tunnel --url ...`. Production passes none.
 * The URL is surfaced only after a health probe confirms the edge is reachable
 * (cloudflared prints the hostname before routing is live).
 */
export function startCloudflared(
  binPath: string,
  localPort: number,
  opts: StartOptions = {},
): Promise<TunnelHandle> {
  const args = opts.extraArgs ?? ['tunnel', '--url', `http://localhost:${localPort}`];
  const timeoutMs = opts.timeoutMs ?? CLOUDFLARED_URL_TIMEOUT_MS;
  const attempts = opts.attempts ?? CLOUDFLARED_HEALTH_ATTEMPTS;
  const intervalMs = opts.intervalMs ?? CLOUDFLARED_HEALTH_INTERVAL_MS;
  const probeTimeoutMs = opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  // A caller-supplied boolean healthCheck carries no failure reason; the default
  // probe does. Adapt the former into a ProbeResult either way.
  const custom = opts.healthCheck;
  const probe: (u: string) => Promise<ProbeResult> = custom
    ? async (u) => ({ ok: await custom(u) })
    : (u) => reachabilityProbe(u, probeTimeoutMs);

  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(binPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false;
    const stop = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* gone */
      }
    };
    const fail = (err: Error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        stop();
        reject(err);
      }
    };

    const timer = setTimeout(
      () => fail(new Error('cloudflared did not report a URL in time')),
      timeoutMs,
    );

    const onData = (buf: Buffer) => {
      for (const line of buf.toString().split('\n')) {
        const url = parsePublicUrl(line);
        if (url && !settled) {
          settled = true;
          clearTimeout(timer);
          // Escape hatch: the reachability probe runs on the *host*, but only the
          // guest's network must reach the URL for messaging. A host on a filtered
          // network can opt to skip the probe and hand out the link regardless.
          if (opts.skipHealthCheck) {
            resolve({ publicUrl: url, stop });
            return;
          }
          waitHealthy(url, attempts, intervalMs, probe, probeTimeoutMs)
            .then((res) => {
              if (res.ok) resolve({ publicUrl: url, stop });
              else {
                stop();
                reject(new Error(unreachableMessage(url, attempts, res.reason)));
              }
            })
            .catch((err) => {
              // Should be unreachable (waitHealthy/probeOnce never reject), but
              // this guarantees the child is never orphaned and the outer
              // promise always settles, even on a future bug or surprise throw.
              stop();
              const reason = err instanceof Error ? err.message : String(err);
              reject(new Error(`cloudflared health check failed unexpectedly: ${reason}`));
            });
          return;
        }
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (err) => fail(err));
    child.on('exit', (code) => fail(new Error(`cloudflared exited (${code})`)));
  });
}
