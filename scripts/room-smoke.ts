/**
 * Real-network room smoke: host + multiple members over an actual cloudflared
 * tunnel. Run manually before releasing 0.2.0: `npm run smoke:room`.
 *
 * Loopback green != internet green (see the 0.1.4 DNS postmortem) — this is
 * the one script that dials the real Cloudflare edge with a real room, so it
 * is deliberately NOT part of `npm test` / the commit gate. It requires
 * outbound network access and is not shipped in the npm package.
 *
 * Proves, over the real internet:
 *  - a host can mint several invites in one `open()` call
 *  - each invite admits exactly one member, with a correct/growing roster
 *  - a used invite link is rejected on a second join attempt
 *  - chat fanout reaches every member (and the host) with the right fromName
 *  - only the host can mint invites (`invite()` is host-only)
 *  - a member can leave and a freshly minted invite admits a replacement
 */
import { TunnelSession } from '../src/session.js';
import type { PlainMessage } from '../src/protocol/messages.js';

const t0 = Date.now();
const el = (): string => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (msg: string): void => console.log(`[${el()}] ${msg}`);

class SmokeFailure extends Error {}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new SmokeFailure(msg);
}

/**
 * Poll `listen()` until a message matching `predicate` shows up, or the
 * deadline passes. Tracks `sinceSeq` per session so repeated calls make
 * forward progress instead of re-scanning the same backlog.
 */
async function waitForMessage(
  session: TunnelSession,
  sinceSeq: { v: number },
  predicate: (m: PlainMessage) => boolean,
  deadlineMs: number,
): Promise<PlainMessage | undefined> {
  const stop = Date.now() + deadlineMs;
  while (Date.now() < stop) {
    const { messages } = await session.listen(sinceSeq.v, Math.max(200, stop - Date.now()));
    for (const m of messages) sinceSeq.v = Math.max(sinceSeq.v, m.seq);
    const hit = messages.find(predicate);
    if (hit) return hit;
  }
  return undefined;
}

const opened: TunnelSession[] = [];
function track(s: TunnelSession): TunnelSession {
  opened.push(s);
  return s;
}

async function main(): Promise<void> {
  // --- 1. host opens a room with 3 invites in one call ---------------------
  const host = track(new TunnelSession());
  const room = await host.open('room smoke', 'Host', { invites: 3 });
  assert(room.invites.length === 3, `expected 3 invites, got ${room.invites.length}`);
  log(`host opened room with ${room.invites.length} invites`);

  // --- 2. three members join over the real tunnel, one invite each ---------
  const names = ['Ana', 'Ben', 'Cyd'];
  const members: Record<string, TunnelSession> = {};
  const since: Record<string, { v: number }> = { Host: { v: 0 } };
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const m = track(new TunnelSession());
    const j = await m.join(room.invites[i].joinLink, name);
    assert(
      j.members.length === i + 2,
      `${name}: expected roster of ${i + 2} after joining, got ${j.members.length}`,
    );
    assert(
      j.members.some((r) => r.name === 'Host' && r.isHost),
      `${name}: roster missing the host`,
    );
    members[name] = m;
    since[name] = { v: 0 };
    log(`${name} joined over the real tunnel; roster: ${j.members.map((r) => r.name).join(', ')}`);
  }

  // --- 3. a used invite is rejected on a second join attempt ---------------
  const reused = track(new TunnelSession());
  let usedInviteRejected = false;
  try {
    await reused.join(room.invites[0].joinLink, 'Mallory');
  } catch (e) {
    usedInviteRejected = true;
    log(`used invite correctly rejected — ${String((e as Error).message)}`);
  }
  assert(usedInviteRejected, 'a used invite link was accepted a second time');

  // --- 4. chat fanout: host -> every member, with correct fromName ---------
  await host.say('hello everyone');
  for (const name of names) {
    const got = await waitForMessage(
      members[name],
      since[name],
      (m) => m.kind === 'chat' && m.text === 'hello everyone',
      20_000,
    );
    assert(got, `${name} never received the host's broadcast`);
    assert(got.fromName === 'Host', `${name} saw fromName="${got.fromName}", expected "Host"`);
  }
  log('fanout verified: host -> Ana, Ben, Cyd (correct fromName on all)');

  // --- 5. chat fanout: a member -> host + the other members -----------------
  await members.Ben.say('ben reporting');
  const hostGot = await waitForMessage(
    host,
    since.Host,
    (m) => m.kind === 'chat' && m.text === 'ben reporting',
    20_000,
  );
  assert(hostGot, "host never received Ben's message");
  assert(hostGot.fromName === 'Ben', `host saw fromName="${hostGot.fromName}", expected "Ben"`);
  for (const name of ['Ana', 'Cyd']) {
    const got = await waitForMessage(
      members[name],
      since[name],
      (m) => m.kind === 'chat' && m.text === 'ben reporting',
      20_000,
    );
    assert(got, `${name} never received Ben's message`);
    assert(got.fromName === 'Ben', `${name} saw fromName="${got.fromName}", expected "Ben"`);
  }
  log('fanout verified: Ben -> Host, Ana, Cyd (correct fromName on all)');

  // --- 6. invite() is host-only ---------------------------------------------
  let memberInviteRejected = false;
  try {
    members.Ana.invite(1);
  } catch (e) {
    memberInviteRejected = true;
    log(`member-side invite() correctly rejected — ${String((e as Error).message)}`);
  }
  assert(memberInviteRejected, 'a non-host member was able to mint an invite');

  // --- 7. member leaves; host mints a fresh invite; a replacement joins -----
  await members.Ben.close();
  log('Ben left the room');
  const [reinvite] = host.invite(1);
  const ben2 = track(new TunnelSession());
  const rejoin = await ben2.join(reinvite.joinLink, 'Ben2');
  assert(
    rejoin.members.some((r) => r.name === 'Ben2'),
    'Ben2 did not appear in the roster after re-joining with a fresh invite',
  );
  log(`host-only invite() verified; Ben2 joined via a freshly minted invite`);

  // --- 8. teardown ------------------------------------------------------------
  await ben2.close();
  await members.Ana.close();
  await members.Cyd.close();
  await host.close('room smoke done');
  log('all sessions closed cleanly');
}

main()
  .then(() => {
    console.log(`[${el()}] ROOM SMOKE PASSED`);
    process.exit(0);
  })
  .catch(async (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`✗ ROOM SMOKE FAILED: ${msg}`);
    if (!(err instanceof SmokeFailure) && err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    // Best-effort cleanup so a failed run doesn't leak cloudflared processes.
    await Promise.all(opened.map((s) => s.close().catch(() => {})));
    process.exit(1);
  });
