import { describe, it, expect } from 'vitest';
import { buildInvite } from '../src/invite.js';

describe('buildInvite', () => {
  const opts = {
    goal: 'debug the flaky checkout test',
    joinLink: 'wss://blue-cat-42.trycloudflare.com/t/abc123#keykeykey',
    expiresInSec: 600,
  };

  it('contains the join link verbatim, the one-time setup command, and the goal', () => {
    const inv = buildInvite(opts);
    expect(inv).toContain(opts.joinLink);
    expect(inv).toContain('claude mcp add tunnel -- npx -y tunnel-mcp');
    expect(inv).toContain(opts.goal);
  });

  it('tells the recipient what to say to their Claude', () => {
    const inv = buildInvite(opts);
    expect(inv.toLowerCase()).toContain('join this tunnel');
  });

  it('states single-use and the expiry in minutes (rounded up, min 1)', () => {
    expect(buildInvite(opts)).toMatch(/single-use/i);
    expect(buildInvite(opts)).toContain('10 minute');
    expect(buildInvite({ ...opts, expiresInSec: 90 })).toContain('2 minutes');
    expect(buildInvite({ ...opts, expiresInSec: 20 })).toContain('1 minute');
  });

  it('is plain text with no markdown headers/formatting (pasteable into any chat)', () => {
    const inv = buildInvite(opts);
    expect(inv).not.toMatch(/^#|\*\*/m);
  });
});
