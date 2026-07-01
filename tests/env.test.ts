import { describe, it, expect, afterEach } from 'vitest';
import { envFlag, reachabilityMode } from '../src/env.js';

const KEY = 'TUNNEL_TEST_FLAG_XYZ';
const REACH = 'TUNNEL_REACHABILITY';
const SKIP = 'TUNNEL_SKIP_REACHABILITY_CHECK';
const savedReach = process.env[REACH];
const savedSkip = process.env[SKIP];
afterEach(() => {
  delete process.env[KEY];
  if (savedReach === undefined) delete process.env[REACH];
  else process.env[REACH] = savedReach;
  if (savedSkip === undefined) delete process.env[SKIP];
  else process.env[SKIP] = savedSkip;
});

describe('envFlag', () => {
  it('is false when unset', () => {
    delete process.env[KEY];
    expect(envFlag(KEY)).toBe(false);
  });

  it('is true for on-ish values', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'anything']) {
      process.env[KEY] = v;
      expect(envFlag(KEY)).toBe(true);
    }
  });

  it('is false for off-ish values (so =0 disables, not enables)', () => {
    for (const v of ['', '0', 'false', 'FALSE', 'no', 'off', ' 0 ']) {
      process.env[KEY] = v;
      expect(envFlag(KEY)).toBe(false);
    }
  });
});

describe('reachabilityMode', () => {
  it('defaults to warn when unset', () => {
    delete process.env[REACH];
    delete process.env[SKIP];
    expect(reachabilityMode()).toBe('warn');
  });

  it('honors explicit warn/strict/off (case-insensitive, trimmed)', () => {
    delete process.env[SKIP];
    for (const [v, want] of [
      ['strict', 'strict'],
      ['STRICT', 'strict'],
      [' off ', 'off'],
      ['warn', 'warn'],
    ] as const) {
      process.env[REACH] = v;
      expect(reachabilityMode()).toBe(want);
    }
  });

  it('falls back to warn for an unrecognized value', () => {
    process.env[REACH] = 'loud';
    delete process.env[SKIP];
    expect(reachabilityMode()).toBe('warn');
  });

  it('treats the deprecated TUNNEL_SKIP_REACHABILITY_CHECK as off, but TUNNEL_REACHABILITY wins', () => {
    delete process.env[REACH];
    process.env[SKIP] = '1';
    expect(reachabilityMode()).toBe('off');
    process.env[REACH] = 'strict';
    expect(reachabilityMode()).toBe('strict'); // explicit mode overrides the alias
  });

  it('an explicit-but-unrecognized value wins over a lingering deprecated flag (→ warn, not off)', () => {
    process.env[REACH] = 'stict'; // typo
    process.env[SKIP] = '1'; // stale flag left in the shell profile
    expect(reachabilityMode()).toBe('warn');
  });
});
