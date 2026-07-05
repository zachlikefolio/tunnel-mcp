/**
 * Real-network artifact smoke: host + two members over an actual cloudflared
 * tunnel, sharing a real text file AND a real binary file and asserting
 * byte-identical, hash-verified receipt by two independent recipients.
 * Run manually before releasing 0.3.0: `npm run smoke:artifact`.
 *
 * Loopback green != internet green (see the 0.1.4 DNS postmortem), so this is
 * deliberately NOT part of `npm test` / the commit gate. It requires outbound
 * network access and is not shipped in the npm package.
 *
 * Proves, over the real internet:
 *  - a host can open a room with multiple invites and 2+ members can join
 *  - a member's share() of a text file AND a binary file offers both to every
 *    other member, with the correct fromName, over the real tunnel
 *  - the offer is visible both via listen() (kind 'artifact') and status()
 *  - two DIFFERENT members can each receive() the same artifact to distinct
 *    save paths and get back bytes that are byte-identical (Buffer.compare)
 *    to the original file, for both the text and the binary artifact
 *  - receive() of an artifact id nobody ever offered is rejected, not hung
 *    or silently accepted
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
 * Poll `listen()` until an 'artifact' message offering `artifactId` shows
 * up, or the deadline passes. Tracks `sinceSeq` per session so repeated
 * calls make forward progress instead of re-scanning the same backlog.
 */
async function waitForArtifactOffer(
  session: TunnelSession,
  sinceSeq: { v: number },
  artifactId: string,
  deadlineMs: number,
): Promise<PlainMessage | undefined> {
  const stop = Date.now() + deadlineMs;
  while (Date.now() < stop) {
    const { messages } = await session.listen(sinceSeq.v, Math.max(200, stop - Date.now()));
    for (const m of messages) sinceSeq.v = Math.max(sinceSeq.v, m.seq);
    const hit = messages.find((m) => {
      if (m.kind !== 'artifact') return false;
      try {
        return (JSON.parse(m.text) as { id?: string }).id === artifactId;
      } catch {
        return false;
      }
    });
    if (hit) return hit;
  }
  return undefined;
}

const opened: TunnelSession[] = [];
function track(s: TunnelSession): TunnelSession {
  opened.push(s);
  return s;
}

// Every temp file this run creates (sources + save paths), removed in the
// `finally` below regardless of whether the run passes or fails.
const tempFiles: string[] = [];
function tempPath(suffix: string): string {
  const p = join(tmpdir(), `artifact-smoke-${randomUUID()}${suffix}`);
  tempFiles.push(p);
  return p;
}

async function assertByteIdentical(path: string, original: Buffer, what: string): Promise<void> {
  const got = await readFile(path);
  assert(
    Buffer.compare(got, original) === 0,
    `${what}: received bytes were not byte-identical to the original`,
  );
}

async function main(): Promise<void> {
  try {
    // --- 1. host opens a room with 2 invites; two members join over the real tunnel
    const host = track(new TunnelSession());
    const room = await host.open('artifact smoke', 'Host', { invites: 2 });
    assert(room.invites.length === 2, `expected 2 invites, got ${room.invites.length}`);
    log(`host opened room with ${room.invites.length} invites`);

    const ana = track(new TunnelSession());
    const anaJoin = await ana.join(room.invites[0].joinLink, 'Ana');
    assert(
      anaJoin.members.length === 2,
      `Ana: expected roster of 2 after joining, got ${anaJoin.members.length}`,
    );
    log('Ana joined over the real tunnel');

    const ben = track(new TunnelSession());
    const benJoin = await ben.join(room.invites[1].joinLink, 'Ben');
    assert(
      benJoin.members.length === 3,
      `Ben: expected roster of 3 after joining, got ${benJoin.members.length}`,
    );
    log('Ben joined over the real tunnel');

    const since = { ben: { v: 0 } };

    // --- 2. Ana writes a text file AND a binary file, and shares both --------
    const textPayload = Buffer.from(
      'Artifact smoke test — plain text payload with unicode: héllo wörld 🚀\n'.repeat(200),
      'utf8',
    );
    const binPayload = randomBytes(200 * 1024); // spans multiple 64KiB chunks, binary

    const textSrc = tempPath('-src.txt');
    const binSrc = tempPath('-src.bin');
    await writeFile(textSrc, textPayload);
    await writeFile(binSrc, binPayload);

    const textShare = await ana.share(textSrc);
    assert(
      textShare.kind === 'text',
      `expected the text file to be detected as text, got "${textShare.kind}"`,
    );
    assert(
      textShare.offeredTo === 2,
      `expected text share offeredTo=2 (Host + Ben), got ${textShare.offeredTo}`,
    );
    log(`Ana shared the text file (${textShare.size} bytes, offered to ${textShare.offeredTo})`);

    const binShare = await ana.share(binSrc);
    assert(
      binShare.kind === 'binary',
      `expected the binary file to be detected as binary, got "${binShare.kind}"`,
    );
    assert(
      binShare.offeredTo === 2,
      `expected binary share offeredTo=2 (Host + Ben), got ${binShare.offeredTo}`,
    );
    log(`Ana shared the binary file (${binShare.size} bytes, offered to ${binShare.offeredTo})`);

    // --- 3. both offers reach Ben over the real internet, right fromName -----
    const textOfferOnBen = await waitForArtifactOffer(ben, since.ben, textShare.artifactId, 30_000);
    assert(textOfferOnBen, 'Ben never saw the text artifact offer over the real internet');
    assert(
      textOfferOnBen.fromName === 'Ana',
      `Ben saw the text offer fromName="${textOfferOnBen.fromName}", expected "Ana"`,
    );

    const binOfferOnBen = await waitForArtifactOffer(ben, since.ben, binShare.artifactId, 30_000);
    assert(binOfferOnBen, 'Ben never saw the binary artifact offer over the real internet');
    assert(
      binOfferOnBen.fromName === 'Ana',
      `Ben saw the binary offer fromName="${binOfferOnBen.fromName}", expected "Ana"`,
    );
    log('both offers reached Ben over the real tunnel, with the correct fromName');

    // Cross-check via status() too, on both the host and Ben.
    const hostStatus = host.status();
    for (const share of [textShare, binShare]) {
      const entry = hostStatus.artifacts.find((a) => a.id === share.artifactId);
      assert(entry, `host status() is missing artifact ${share.artifactId}`);
      assert(
        entry.fromName === 'Ana',
        `host status() shows fromName="${entry.fromName}" for ${share.artifactId}, expected "Ana"`,
      );
    }
    const benStatus = ben.status();
    for (const share of [textShare, binShare]) {
      assert(
        benStatus.artifacts.some((a) => a.id === share.artifactId),
        `Ben's status() is missing artifact ${share.artifactId}`,
      );
    }
    log('both offers confirmed via status() on the host and Ben');

    // --- 4. two DIFFERENT members (Host and Ben) each receive both artifacts -
    const textDstHost = tempPath('-text-host.out');
    const textDstBen = tempPath('-text-ben.out');
    const binDstHost = tempPath('-bin-host.out');
    const binDstBen = tempPath('-bin-ben.out');

    const textRecvHost = await host.receive(textShare.artifactId, textDstHost);
    assert(
      textRecvHost.sha256 === textShare.sha256,
      'host: received text sha256 did not match the offer',
    );
    await assertByteIdentical(textDstHost, textPayload, 'text file received by Host');

    const textRecvBen = await ben.receive(textShare.artifactId, textDstBen);
    assert(
      textRecvBen.sha256 === textShare.sha256,
      'Ben: received text sha256 did not match the offer',
    );
    await assertByteIdentical(textDstBen, textPayload, 'text file received by Ben');
    log('text artifact received byte-identically by both Host and Ben');

    const binRecvHost = await host.receive(binShare.artifactId, binDstHost);
    assert(
      binRecvHost.sha256 === binShare.sha256,
      'host: received binary sha256 did not match the offer',
    );
    await assertByteIdentical(binDstHost, binPayload, 'binary file received by Host');

    const binRecvBen = await ben.receive(binShare.artifactId, binDstBen);
    assert(
      binRecvBen.sha256 === binShare.sha256,
      'Ben: received binary sha256 did not match the offer',
    );
    await assertByteIdentical(binDstBen, binPayload, 'binary file received by Ben');
    log('binary artifact received byte-identically by both Host and Ben');

    // --- 5. a fetch of an artifact id nobody ever offered is rejected --------
    // Note: the public API rejects a truly unknown id client-side, in
    // session.receive()'s own offer-log guard, before any network round trip
    // — "no such artifact offered: <id>". The wire-level "artifact expired or
    // not found" error (src/relay/hostRelay.ts) is what a *known* offer gets
    // back if its TTL has since lapsed or it was evicted from the host's
    // store; it isn't reachable from a bogus id that was never offered in the
    // first place. This assertion accepts either wording so it stays
    // meaningful if that error path is ever unified, while matching today's
    // real, observable behavior against the public TunnelSession API.
    const bogusId = `bogus-${randomUUID()}`;
    let bogusRejected = false;
    try {
      await ben.receive(bogusId, tempPath('-bogus.out'));
    } catch (e) {
      const msg = String((e as Error).message);
      assert(
        /no such artifact offered|artifact expired or not found/i.test(msg),
        `bogus artifactId was rejected for the wrong reason: ${msg}`,
      );
      bogusRejected = true;
      log(`bogus artifactId correctly rejected — ${msg}`);
    }
    assert(bogusRejected, 'a bogus/unknown artifactId was accepted instead of rejected');

    // --- 6. teardown -----------------------------------------------------------
    await ben.close();
    await ana.close();
    await host.close('artifact smoke done');
    log('all sessions closed cleanly');
  } finally {
    await Promise.all(tempFiles.map((f) => rm(f, { force: true }).catch(() => {})));
    log(`cleaned up ${tempFiles.length} temp file(s)`);
  }
}

main()
  .then(() => {
    console.log(`[${el()}] ARTIFACT SMOKE PASSED`);
    process.exit(0);
  })
  .catch(async (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`✗ ARTIFACT SMOKE FAILED: ${msg}`);
    if (!(err instanceof SmokeFailure) && err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    // Best-effort cleanup so a failed run doesn't leak cloudflared processes.
    await Promise.all(opened.map((s) => s.close().catch(() => {})));
    process.exit(1);
  });
