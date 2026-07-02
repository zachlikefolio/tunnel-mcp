import { describe, it, expect } from 'vitest';
import { InviteLedger } from '../src/relay/inviteLedger.js';

describe('InviteLedger', () => {
  it('mints unique tokens with ttl stamped at mint time', () => {
    const led = new InviteLedger(1000);
    const a = led.mint(5000);
    const b = led.mint(5000);
    expect(a.token).not.toBe(b.token);
    expect(a.expiresAt).toBe(6000);
    expect(led.pendingCount(5000)).toBe(2);
  });

  it('redeems exactly once: ok, then used', () => {
    const led = new InviteLedger(1000);
    const { token } = led.mint(0);
    expect(led.redeem(token, 'aaaa', 10)).toBe('ok');
    expect(led.redeem(token, 'bbbb', 20)).toBe('used');
    expect(led.pendingCount(20)).toBe(0);
  });

  it('expires by wall clock and reports unknown tokens', () => {
    const led = new InviteLedger(1000);
    const { token } = led.mint(0);
    expect(led.redeem(token, 'aaaa', 1001)).toBe('expired');
    expect(led.redeem('never-minted', 'aaaa', 5)).toBe('unknown');
    expect(led.pendingCount(1001)).toBe(0);
  });

  it('concurrent redemption of one token: exactly one winner (sync-atomic)', () => {
    const led = new InviteLedger(60_000);
    const { token } = led.mint(0);
    const results = ['m1', 'm2', 'm3', 'm4'].map((id) => led.redeem(token, id, 1));
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'used')).toHaveLength(3);
  });
});
