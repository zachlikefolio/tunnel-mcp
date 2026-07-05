import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  SESSIONS_DIR,
  BIN_DIR,
  TUNNEL_HOME,
  DEFAULT_LISTEN_TIMEOUT_MS,
  DEFAULT_IDLE_TEARDOWN_MS,
  DEFAULT_JOIN_LINK_TTL_MS,
  CLOUDFLARED_URL_TIMEOUT_MS,
  OPEN_RETRY_ATTEMPTS,
  READINESS_GATE_BUDGET_MS,
  READINESS_INITIAL_DELAY_MS,
  READINESS_POLL_INTERVAL_MS,
  DOH_REQUEST_TIMEOUT_MS,
  DOH_PROVIDERS,
  GUEST_HANDSHAKE_TIMEOUT_MS,
  GUEST_CONNECT_DEADLINE_MS,
  GUEST_SYS_LOOKUP_TIMEOUT_MS,
  DOH_GUEST_RETRIES,
  DOH_GUEST_RETRY_DELAY_MS,
  MAX_ROOM_MEMBERS,
  PROTOCOL_VERSION,
  ARTIFACT_CHUNK_BYTES,
  MAX_ARTIFACT_BYTES,
  MAX_MEMBER_ARTIFACT_BYTES,
  MAX_ROOM_ARTIFACT_BYTES,
  ARTIFACT_TTL_MS,
  MIN_PROTOCOL_VERSION,
  ARTIFACT_PROTOCOL_VERSION,
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
    expect(DEFAULT_JOIN_LINK_TTL_MS).toBe(600000);
    expect(CLOUDFLARED_URL_TIMEOUT_MS).toBe(30000);
    expect(OPEN_RETRY_ATTEMPTS).toBe(3);

    expect(READINESS_GATE_BUDGET_MS).toBe(60000);
    expect(READINESS_INITIAL_DELAY_MS).toBe(5000);
    expect(READINESS_POLL_INTERVAL_MS).toBe(1000);
    expect(DOH_REQUEST_TIMEOUT_MS).toBe(3000);
    expect(GUEST_HANDSHAKE_TIMEOUT_MS).toBe(15000);
    expect(GUEST_CONNECT_DEADLINE_MS).toBe(20000);
    expect(GUEST_SYS_LOOKUP_TIMEOUT_MS).toBe(2000);
    expect(DOH_GUEST_RETRIES).toBe(3);
    expect(DOH_GUEST_RETRY_DELAY_MS).toBe(700);
    // The overall connect deadline must exceed the handshake bound so the
    // handshake timeout fires first on a connect-phase black hole.
    expect(GUEST_CONNECT_DEADLINE_MS).toBeGreaterThan(GUEST_HANDSHAKE_TIMEOUT_MS);
  });

  it('ships IP-literal DoH providers (never a hostname, which would re-poison the system resolver)', () => {
    expect(DOH_PROVIDERS.length).toBeGreaterThanOrEqual(2);
    for (const p of DOH_PROVIDERS) {
      const u = new URL(p.url('example.trycloudflare.com', 'A'));
      // host must be an IP literal
      expect(u.hostname).toMatch(/^(\d{1,3}\.){3}\d{1,3}$|^\[?[0-9a-fA-F:]+\]?$/);
      expect(u.searchParams.get('name')).toBe('example.trycloudflare.com');
    }
    // Cloudflare uses /dns-query, Google uses /resolve.
    expect(DOH_PROVIDERS.some((p) => p.url('h', 'A').includes('1.1.1.1/dns-query'))).toBe(true);
    expect(DOH_PROVIDERS.some((p) => p.url('h', 'A').includes('8.8.8.8/resolve'))).toBe(true);
  });

  it('derives BIN_DIR and SESSIONS_DIR as direct children of TUNNEL_HOME', () => {
    expect(BIN_DIR).toBe(path.join(TUNNEL_HOME, 'bin'));
    expect(SESSIONS_DIR).toBe(path.join(TUNNEL_HOME, 'sessions'));
  });

  it('keeps all numeric constants as positive integers, not strings or NaN', () => {
    const numericConstants = [
      DEFAULT_LISTEN_TIMEOUT_MS,
      DEFAULT_IDLE_TEARDOWN_MS,
      DEFAULT_JOIN_LINK_TTL_MS,
      CLOUDFLARED_URL_TIMEOUT_MS,
      OPEN_RETRY_ATTEMPTS,
      READINESS_GATE_BUDGET_MS,
      READINESS_INITIAL_DELAY_MS,
      READINESS_POLL_INTERVAL_MS,
      DOH_REQUEST_TIMEOUT_MS,
      GUEST_HANDSHAKE_TIMEOUT_MS,
      GUEST_CONNECT_DEADLINE_MS,
      GUEST_SYS_LOOKUP_TIMEOUT_MS,
      DOH_GUEST_RETRIES,
      DOH_GUEST_RETRY_DELAY_MS,
      MAX_ROOM_MEMBERS,
      PROTOCOL_VERSION,
      ARTIFACT_CHUNK_BYTES,
      MAX_ARTIFACT_BYTES,
      MAX_MEMBER_ARTIFACT_BYTES,
      MAX_ROOM_ARTIFACT_BYTES,
      ARTIFACT_TTL_MS,
      MIN_PROTOCOL_VERSION,
      ARTIFACT_PROTOCOL_VERSION,
    ];
    for (const value of numericConstants) {
      expect(typeof value).toBe('number');
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });

  it('exposes room constants', () => {
    expect(MAX_ROOM_MEMBERS).toBe(16);
    expect(PROTOCOL_VERSION).toBe(3);
  });

  it('exposes artifact + protocol constants', () => {
    expect(ARTIFACT_CHUNK_BYTES).toBe(64 * 1024);
    expect(MAX_ARTIFACT_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_MEMBER_ARTIFACT_BYTES).toBe(20 * 1024 * 1024);
    expect(MAX_ROOM_ARTIFACT_BYTES).toBe(64 * 1024 * 1024);
    expect(ARTIFACT_TTL_MS).toBe(30 * 60 * 1000);
    expect(PROTOCOL_VERSION).toBe(3);
    expect(MIN_PROTOCOL_VERSION).toBe(2);
    expect(ARTIFACT_PROTOCOL_VERSION).toBe(3);
  });
});
