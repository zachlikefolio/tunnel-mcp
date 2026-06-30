import os from 'node:os';
import path from 'node:path';

export const TUNNEL_HOME = path.join(os.homedir(), '.tunnel');
export const BIN_DIR = path.join(TUNNEL_HOME, 'bin');
export const SESSIONS_DIR = path.join(TUNNEL_HOME, 'sessions');

export const DEFAULT_LISTEN_TIMEOUT_MS = 60_000;
export const DEFAULT_IDLE_TEARDOWN_MS = 30 * 60_000;

// cloudflared startup robustness
export const CLOUDFLARED_URL_TIMEOUT_MS = 30_000;     // wait for the URL line
export const CLOUDFLARED_HEALTH_ATTEMPTS = 10;        // edge-reachability probes
export const CLOUDFLARED_HEALTH_INTERVAL_MS = 1_000;  // delay between probes
export const OPEN_RETRY_ATTEMPTS = 3;                 // re-spawn attempts in session.open
