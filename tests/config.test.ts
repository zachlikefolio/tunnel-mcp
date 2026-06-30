import { describe, it, expect } from 'vitest';
import { SESSIONS_DIR, BIN_DIR, DEFAULT_LISTEN_TIMEOUT_MS } from '../src/config.js';

describe('config', () => {
  it('points session + bin dirs under ~/.tunnel and sets default timeout', () => {
    expect(SESSIONS_DIR).toMatch(/\.tunnel[/\\]sessions$/);
    expect(BIN_DIR).toMatch(/\.tunnel[/\\]bin$/);
    expect(DEFAULT_LISTEN_TIMEOUT_MS).toBe(60000);
  });
});
