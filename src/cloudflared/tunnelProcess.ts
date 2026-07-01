import { spawn, ChildProcess } from 'node:child_process';
import {
  CLOUDFLARED_URL_TIMEOUT_MS,
  READINESS_GATE_BUDGET_MS,
  READINESS_INITIAL_DELAY_MS,
  READINESS_POLL_INTERVAL_MS,
} from '../config.js';
import { dohResolve, DohResult } from '../net/doh.js';
import { envFlag } from '../env.js';

export interface TunnelHandle {
  publicUrl: string;
  stop(): void;
}

export interface StartOptions {
  timeoutMs?: number; // wait for the URL line
  extraArgs?: string[]; // tests: launch a fake binary
  budgetMs?: number; // total readiness-gate budget
  pollIntervalMs?: number; // between DoH liveness polls
  initialDelayMs?: number; // before the first poll (propagation is never faster than ~8s)
  resolveHost?: (host: string) => Promise<DohResult>; // injectable DoH liveness (tests)
  dohEnabled?: boolean; // default: TUNNEL_DOH (on unless explicitly off)
}

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function parsePublicUrl(line: string): string | null {
  const m = line.match(URL_RE);
  return m ? m[0] : null;
}

function dohOn(explicit?: boolean): boolean {
  return explicit ?? (process.env.TUNNEL_DOH === undefined || envFlag('TUNNEL_DOH'));
}

/**
 * Spawn `cloudflared tunnel --url ...` and resolve with the public URL — but
 * only after a readiness gate confirms the per-tunnel DNS record has propagated.
 *
 * cloudflared prints the URL ~8–25s before the record exists. Looking the name
 * up via the system resolver during that window returns NXDOMAIN and gets it
 * negative-cached (SOA min 1800s), breaking the guest's join for up to 30 min.
 * So the gate polls DoH over IP-literal endpoints (which never touch the system
 * resolver, so they cannot poison anything). It is best-effort: it never blocks
 * on "not live yet" or "DoH unavailable" — after the budget it returns the link
 * optimistically (the guest's own DoH fallback is the safety net).
 *
 * `extraArgs` exists for tests: it launches a fake binary in place of cloudflared.
 */
export function startCloudflared(
  binPath: string,
  localPort: number,
  opts: StartOptions = {},
): Promise<TunnelHandle> {
  const args = opts.extraArgs ?? ['tunnel', '--url', `http://localhost:${localPort}`];
  const timeoutMs = opts.timeoutMs ?? CLOUDFLARED_URL_TIMEOUT_MS;
  const budgetMs = opts.budgetMs ?? READINESS_GATE_BUDGET_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? READINESS_POLL_INTERVAL_MS;
  const initialDelayMs = opts.initialDelayMs ?? READINESS_INITIAL_DELAY_MS;
  const resolveHost = opts.resolveHost ?? ((h: string) => dohResolve(h, 4));
  const dohEnabled = dohOn(opts.dohEnabled);

  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(binPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false;
    let gateStarted = false;
    let exited = false;

    const stop = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    };
    const succeed = (url: string) => {
      if (!settled) {
        settled = true;
        resolve({ publicUrl: url, stop });
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

    const runGate = async (url: string, host: string) => {
      if (!dohEnabled) {
        await delay(pollIntervalMs); // brief settle; the guest's DoH fallback covers readiness
        succeed(url);
        return;
      }
      await delay(initialDelayMs);
      const deadline = Date.now() + budgetMs;
      while (!settled && !exited && Date.now() < deadline) {
        const res = await resolveHost(host).catch(
          () => ({ klass: 'INDETERMINATE', addresses: [] }) as DohResult,
        );
        if (res.klass === 'RESOLVED') {
          succeed(url);
          return;
        }
        await delay(pollIntervalMs);
      }
      if (settled) return;
      if (exited) {
        fail(new Error('cloudflared exited during readiness wait'));
        return;
      }
      // Budget exhausted without a RESOLVED — hand out the link optimistically.
      // No system-DNS lookup ever happened, so nothing was poisoned, and the
      // guest resolves the name itself (system-first, DoH fallback).
      succeed(url);
    };

    const onData = (buf: Buffer) => {
      if (gateStarted) return;
      for (const line of buf.toString().split('\n')) {
        const url = parsePublicUrl(line);
        if (url) {
          gateStarted = true;
          clearTimeout(timer);
          void runGate(url, new URL(url).host);
          return;
        }
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (err) => fail(err));
    child.on('exit', (code) => {
      exited = true;
      fail(new Error(`cloudflared exited (${code})`));
    });
  });
}
