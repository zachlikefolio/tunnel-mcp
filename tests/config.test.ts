import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  SESSIONS_DIR,
  BIN_DIR,
  TUNNEL_HOME,
  DEFAULT_LISTEN_TIMEOUT_MS,
  DEFAULT_IDLE_TEARDOWN_MS,
  CLOUDFLARED_URL_TIMEOUT_MS,
  CLOUDFLARED_HEALTH_ATTEMPTS,
  CLOUDFLARED_HEALTH_INTERVAL_MS,
  OPEN_RETRY_ATTEMPTS,
} from '../src/config.js';

describe('config', () => {
  it('points session + bin dirs under ~/.tunnel and sets default timeout', () => {
    expect(SESSIONS_DIR).toMatch(/\.tunnel[/\\]sessions$/);
    expect(BIN_DIR).toMatch(/\.tunnel[/\\]bin$/);
    expect(DEFAULT_LISTEN_TIMEOUT_MS).toBe(60000);
  });

  it('exposes every exported constant with its exact documented value', () => {
    expect(TUNNEL_HOME.endsWith('.tunnel')).toBe(true);
    expect(BIN_DIR.endsWith(`.tunnel${path.sep}bin`)).toBe(true);
    expect(SESSIONS_DIR.endsWith(`.tunnel${path.sep}sessions`)).toBe(true);

    expect(DEFAULT_LISTEN_TIMEOUT_MS).toBe(60000);
    expect(DEFAULT_IDLE_TEARDOWN_MS).toBe(1800000);
    expect(CLOUDFLARED_URL_TIMEOUT_MS).toBe(30000);
    expect(CLOUDFLARED_HEALTH_ATTEMPTS).toBe(10);
    expect(CLOUDFLARED_HEALTH_INTERVAL_MS).toBe(1000);
    expect(OPEN_RETRY_ATTEMPTS).toBe(3);
  });

  it('derives BIN_DIR and SESSIONS_DIR as direct children of TUNNEL_HOME', () => {
    expect(BIN_DIR).toBe(path.join(TUNNEL_HOME, 'bin'));
    expect(SESSIONS_DIR).toBe(path.join(TUNNEL_HOME, 'sessions'));
  });

  it('keeps all numeric constants as positive integers, not strings or NaN', () => {
    const numericConstants = [
      DEFAULT_LISTEN_TIMEOUT_MS,
      DEFAULT_IDLE_TEARDOWN_MS,
      CLOUDFLARED_URL_TIMEOUT_MS,
      CLOUDFLARED_HEALTH_ATTEMPTS,
      CLOUDFLARED_HEALTH_INTERVAL_MS,
      OPEN_RETRY_ATTEMPTS,
    ];
    for (const value of numericConstants) {
      expect(typeof value).toBe('number');
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });
});
