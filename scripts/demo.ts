/**
 * A self-narrating live demo of tunnel-mcp, designed to be recorded in one take
 * (`npm run demo`). Opens a REAL cloudflared tunnel, joins it as a guest over
 * the public internet, exchanges end-to-end-encrypted messages, proves the
 * join link is single-use, and tears everything down.
 *
 * Requires outbound network access (Cloudflare edge). Not shipped in the npm
 * package — repo/demo tooling only.
 */
import { TunnelSession } from '../src/session.js';

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  alice: '\x1b[36m', // cyan
  bob: '\x1b[35m', // magenta
  mallory: '\x1b[31m', // red
  ok: '\x1b[32m',
  sys: '\x1b[90m',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function line(tag: string, color: string, text: string): void {
  console.log(`${color}${C.bold}${tag.padEnd(16)}${C.reset} ${text}`);
}

async function typeOut(tag: string, color: string, text: string): Promise<void> {
  process.stdout.write(`${color}${C.bold}${tag.padEnd(16)}${C.reset} `);
  for (const ch of text) {
    process.stdout.write(ch);
    await sleep(14);
  }
  process.stdout.write('\n');
}

async function withSpinner<T>(label: string, p: Promise<T>): Promise<T> {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const t0 = Date.now();
  let i = 0;
  const timer = setInterval(() => {
    const s = ((Date.now() - t0) / 1000).toFixed(1);
    process.stdout.write(`\r${C.sys}${frames[i++ % frames.length]} ${label} (${s}s)${C.reset}  `);
  }, 80);
  try {
    return await p;
  } finally {
    clearInterval(timer);
    process.stdout.write('\r' + ' '.repeat(72) + '\r');
  }
}

async function waitForPeerChat(
  session: TunnelSession,
  myRole: 'host' | 'guest',
  deadlineMs: number,
): Promise<string> {
  const stop = Date.now() + deadlineMs;
  let since = 0;
  while (Date.now() < stop) {
    const { messages } = await session.listen(since, Math.max(200, stop - Date.now()));
    for (const m of messages) since = Math.max(since, m.seq);
    const peer = messages.find((m) => m.kind === 'chat' && m.from !== myRole);
    if (peer) return peer.text;
  }
  return '(timed out)';
}

console.log(
  `\n${C.bold}  tunnel-mcp${C.reset} ${C.sys}— two Claude agents, one ephemeral encrypted tunnel. No server. No accounts.${C.reset}\n`,
);
await sleep(900);

line("ALICE'S AGENT", C.alice, `tunnel_open({ goal: "debug the flaky checkout test" })`);
const alice = new TunnelSession();
const opened = await withSpinner(
  'spawning cloudflared + waiting for the DNS record to go live (DoH readiness gate)',
  alice.open('debug the flaky checkout test', 'Alice'),
);
line('', C.sys, `${C.sys}tunnel up → ${C.reset}${opened.joinLink.replace(/#.*$/, '#…key…')}`);
line(
  '',
  C.sys,
  `${C.sys}link is single-use and expires in ${opened.joinLinkExpiresInSec}s — Alice DMs it to Bob${C.reset}`,
);
await sleep(1200);

line(
  "BOB'S AGENT",
  C.bob,
  `tunnel_join({ joinLink: "wss://…" })   ${C.sys}(from a different machine)${C.reset}`,
);
const bob = new TunnelSession();
const joined = await withSpinner('dialing the public tunnel', bob.join(opened.joinLink, 'Bob'));
line('', C.ok, `joined — goal: "${joined.goal}", peer: ${joined.peer}`);
await sleep(900);

await typeOut(
  "ALICE'S AGENT",
  C.alice,
  `→ "The test fails on a 401 from /checkout. Can you hit it from your side?"`,
);
await alice.say('The test fails on a 401 from /checkout. Can you hit it from your side?');
const bobGot = await waitForPeerChat(bob, 'guest', 15000);
line("BOB'S AGENT", C.bob, `${C.dim}decrypted:${C.reset} "${bobGot}"`);
await sleep(700);

await typeOut(
  "BOB'S AGENT",
  C.bob,
  `→ "Repro'd. Your client sends X-Api-Version: 2 — staging only accepts 3."`,
);
await bob.say("Repro'd. Your client sends X-Api-Version: 2 — staging only accepts 3.");
const aliceGot = await waitForPeerChat(alice, 'host', 15000);
line("ALICE'S AGENT", C.alice, `${C.dim}decrypted:${C.reset} "${aliceGot}"`);
await sleep(1000);

line('MALLORY', C.mallory, `tries the leaked link…`);
const mallory = new TunnelSession();
try {
  await mallory.join(opened.joinLink, 'Mallory');
  line('MALLORY', C.mallory, 'joined?! (this should never print)');
} catch (e) {
  line('', C.ok, `rejected — ${String((e as Error).message)} ${C.sys}(single-use link)${C.reset}`);
}
await mallory.close().catch(() => {});
await sleep(1000);

await alice.close('bug found: X-Api-Version mismatch');
await bob.close();
line('', C.sys, 'tunnel_close → relay, cloudflared process, and session log all destroyed.');
console.log(
  `\n${C.bold}  npx tunnel-mcp${C.reset} ${C.sys}· E2E-encrypted (NaCl) · host-owned · github.com/zachlikefolio/tunnel-mcp${C.reset}\n`,
);
process.exit(0);
