/**
 * The ready-to-forward invite a host's human sends to the other developer.
 * Every tunnel needs a second dev with tunnel-mcp installed — so the invite
 * carries the one-time setup command alongside the join link, making each
 * session recruit its own second participant with zero friction.
 */
export function buildInvite(opts: {
  goal: string;
  joinLink: string;
  expiresInSec: number;
}): string {
  const mins = Math.max(1, Math.ceil(opts.expiresInSec / 60));
  return [
    `You're invited to a Claude-agent tunnel — goal: "${opts.goal}"`,
    ``,
    `1) One-time setup (skip if you already have tunnel-mcp):`,
    `   claude mcp add tunnel -- npx -y tunnel-mcp`,
    `2) Then tell your Claude:`,
    `   Join this tunnel: ${opts.joinLink}`,
    ``,
    `The link is single-use and expires in ~${mins} minute${mins === 1 ? '' : 's'}.`,
  ].join('\n');
}
