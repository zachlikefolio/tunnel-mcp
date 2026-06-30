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
}

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

export function parsePublicUrl(line: string): string | null {
  const m = line.match(URL_RE);
  return m ? m[0] : null;
}

// Any HTTP response (even 404/502/426) means the Cloudflare edge is routing to us.
export async function defaultHealthCheck(url: string): Promise<boolean> {
  try {
    await fetch(url, { method: 'GET' });
    return true;
  } catch {
    return false; // network/DNS error → edge not ready yet
  }
}

async function waitHealthy(
  url: string, attempts: number, intervalMs: number, check: (u: string) => Promise<boolean>,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await check(url)) return true;
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
          waitHealthy(url, attempts, intervalMs, check).then((ok) => {
            if (ok) resolve({ publicUrl: url, stop });
            else { stop(); reject(new Error('cloudflared tunnel never became reachable')); }
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
