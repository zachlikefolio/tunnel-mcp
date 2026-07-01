import { describe, it, expect, afterEach } from 'vitest';
import { envFlag } from '../src/env.js';

const KEY = 'TUNNEL_TEST_FLAG_XYZ';
afterEach(() => {
  delete process.env[KEY];
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
