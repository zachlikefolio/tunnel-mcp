import { spawn, ChildProcess } from 'node:child_process';
import {
  CLOUDFLARED_URL_TIMEOUT_MS, CLOUDFLARED_HEALTH_ATTEMPTS, CLOUDFLARED_HEALTH_INTERVAL_MS,
} from '../config.js';

export interface TunnelHandle {
  publicUrl: string;
  stop(): void;
}

export interface StartOptions {
  timeoutMs?: number;                              // wait for the URL line
  extraArgs?: string[];                            // tests: launch a fake binary
  attempts?: number;                               // edge-reachability probes
  intervalMs?: number;                             // delay between probes
  healthCheck?: (url: string) => Promise<boolean>; // default: HTTP reachability
  probeTimeoutMs?: number;                         // per-attempt budget for a health probe
}

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

// Bounds a single probe so a black-hole connection (or a caller-supplied
// healthCheck that hangs/throws) can't stall the health-check loop forever.
const DEFAULT_PROBE_TIMEOUT_MS = 5000;

export function parsePublicUrl(line: string): string | null {
  const m = line.match(URL_RE);
  return m ? m[0] : null;
}

// Any HTTP response (even 404/502/426) means the Cloudflare edge is routing to us.
export async function defaultHealthCheck(url: string): Promise<boolean> {
  try {
    await fetch(url, { method: 'GET', signal: AbortSignal.timeout(DEFAULT_PROBE_TIMEOUT_MS) });
    return true;
  } catch {
    return false; // network/DNS error/timeout → edge not ready yet
  }
}

// Races a single health-check attempt against a per-attempt timeout so that a
// caller-supplied `check` that throws, rejects, or simply never resolves can
// never leave the loop (and therefore the outer startCloudflared promise)
// hanging. Any failure mode here just counts as "not healthy yet".
function probeOnce(
  url: string, check: (u: string) => Promise<boolean>, probeTimeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };
    const timer = setTimeout(() => finish(false), probeTimeoutMs);
    Promise.resolve()
      .then(() => check(url))
      .then((ok) => { clearTimeout(timer); finish(ok); })
      .catch(() => { clearTimeout(timer); finish(false); });
  });
}

async function waitHealthy(
  url: string,
  attempts: number,
  intervalMs: number,
  check: (u: string) => Promise<boolean>,
  probeTimeoutMs: number,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await probeOnce(url, check, probeTimeoutMs)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * `extraArgs` exists for tests: it lets a fake binary (e.g. `node fake.mjs`) be
 * launched in place of `cloudflared tunnel --url ...`. Production passes none.
 * The URL is surfaced only after a health probe confirms the edge is reachable
 * (cloudflared prints the hostname before routing is live).
 */
export function startCloudflared(binPath: string, localPort: number, opts: StartOptions = {}): Promise<TunnelHandle> {
  const args = opts.extraArgs ?? ['tunnel', '--url', `http://localhost:${localPort}`];
  const timeoutMs = opts.timeoutMs ?? CLOUDFLARED_URL_TIMEOUT_MS;
  const attempts = opts.attempts ?? CLOUDFLARED_HEALTH_ATTEMPTS;
  const intervalMs = opts.intervalMs ?? CLOUDFLARED_HEALTH_INTERVAL_MS;
  const check = opts.healthCheck ?? defaultHealthCheck;
  const probeTimeoutMs = opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(binPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false;
    const stop = () => { try { child.kill('SIGTERM'); } catch { /* gone */ } };
    const fail = (err: Error) => { if (!settled) { settled = true; clearTimeout(timer); stop(); reject(err); } };

    const timer = setTimeout(() => fail(new Error('cloudflared did not report a URL in time')), timeoutMs);

    const onData = (buf: Buffer) => {
      for (const line of buf.toString().split('\n')) {
        const url = parsePublicUrl(line);
        if (url && !settled) {
          settled = true;
          clearTimeout(timer);
          waitHealthy(url, attempts, intervalMs, check, probeTimeoutMs)
            .then((ok) => {
              if (ok) resolve({ publicUrl: url, stop });
              else { stop(); reject(new Error('cloudflared tunnel never became reachable')); }
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
