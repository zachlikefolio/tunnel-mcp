import { describe, it, expect, afterEach } from 'vitest';
import { TunnelSession } from '../src/session.js';

const sessions: TunnelSession[] = [];
afterEach(async () => {
  for (const s of sessions) {
    try {
      await s.close();
    } catch {}
  }
  sessions.length = 0;
});

function fakeDeps() {
  return {
    ensureCloudflared: async () => 'fake',
    startCloudflared: async (_b: string, port: number) => ({
      publicUrl: `http://127.0.0.1:${port}`,
      stop() {},
    }),
  };
}

async function waitFor(
  s: TunnelSession,
  pred: (m: { text: string; kind: string; fromName?: string }[]) => boolean,
  deadlineMs = 4000,
) {
  const stop = Date.now() + deadlineMs;
  let since = 0;
  const seen: { text: string; kind: string; fromName?: string }[] = [];
  while (Date.now() < stop) {
    const { messages } = await s.listen(since, Math.max(100, stop - Date.now()));
    for (const m of messages) {
      since = Math.max(since, m.seq);
      seen.push(m);
    }
    if (pred(seen)) return seen;
  }
  throw new Error('waitFor timed out');
}

describe('artifact sharing integration (share half)', () => {
  it('a member share surfaces as an artifact offer in another member listen + status', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const host = new TunnelSession(fakeDeps());
    const ana = new TunnelSession();
    const ben = new TunnelSession();
    sessions.push(host, ana, ben);

    const opened = await host.open('share room', 'Host', { invites: 2 });
    await ana.join(opened.invites[0].joinLink, 'Ana');
    await ben.join(opened.invites[1].joinLink, 'Ben');

    const file = path.join(os.tmpdir(), `tunnel-int-${Date.now()}.txt`);
    await fs.writeFile(file, 'shared payload');
    const res = await ana.share(file);
    expect(res.offeredTo).toBe(2); // Host + Ben, both v3
    expect(res.olderMembers).toBe(0);

    const seen = await waitFor(ben, (msgs) => msgs.some((m) => m.kind === 'artifact'));
    const offer = JSON.parse(seen.find((m) => m.kind === 'artifact')!.text);
    expect(offer.id).toBe(res.artifactId);
    expect(offer.name).toBe(path.basename(file));
    expect(offer.from).toBeDefined();

    const st = ben.status();
    expect(st.artifacts.some((a) => a.id === res.artifactId && a.fromName === 'Ana')).toBe(true);
    await fs.rm(file, { force: true });
  }, 20000);

  it('round-trips text AND binary byte-identically; a second member also fetches it', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const crypto = await import('node:crypto');

    const host = new TunnelSession(fakeDeps());
    const ana = new TunnelSession();
    const ben = new TunnelSession();
    sessions.push(host, ana, ben);
    const opened = await host.open('rt room', 'Host', { invites: 2 });
    await ana.join(opened.invites[0].joinLink, 'Ana');
    await ben.join(opened.invites[1].joinLink, 'Ben');

    for (const payload of [
      Buffer.from('a text artifact\nwith two lines\n', 'utf8'),
      crypto.randomBytes(70 * 1024), // spans multiple 64KB chunks, binary
    ]) {
      const src = path.join(os.tmpdir(), `tunnel-src-${crypto.randomUUID()}`);
      await fs.writeFile(src, payload);
      const shared = await host.share(src);

      // Ana receives, verifying + writing to HER chosen path.
      await waitFor(ana, (msgs) =>
        msgs.some((m) => m.kind === 'artifact' && JSON.parse(m.text).id === shared.artifactId),
      );
      const dstAna = path.join(os.tmpdir(), `tunnel-dst-ana-${crypto.randomUUID()}`);
      const rA = await ana.receive(shared.artifactId, dstAna);
      expect(rA.sha256).toBe(shared.sha256);
      expect(Buffer.compare(await fs.readFile(dstAna), payload)).toBe(0);

      // Ben fetches the SAME artifact independently.
      await waitFor(ben, (msgs) =>
        msgs.some((m) => m.kind === 'artifact' && JSON.parse(m.text).id === shared.artifactId),
      );
      const dstBen = path.join(os.tmpdir(), `tunnel-dst-ben-${crypto.randomUUID()}`);
      await ben.receive(shared.artifactId, dstBen);
      expect(Buffer.compare(await fs.readFile(dstBen), payload)).toBe(0);

      await Promise.all([
        fs.rm(src, { force: true }),
        fs.rm(dstAna, { force: true }),
        fs.rm(dstBen, { force: true }),
      ]);
    }
  }, 30000);

  it('receive() of an unknown id errors cleanly', async () => {
    const host = new TunnelSession(fakeDeps());
    const ana = new TunnelSession();
    sessions.push(host, ana);
    const opened = await host.open('g', 'Host', { invites: 1 });
    await ana.join(opened.invites[0].joinLink, 'Ana');
    await expect(ana.receive('deadbeefdeadbeef', '/tmp/nope')).rejects.toThrow(
      /no such artifact offered/,
    );
  });
});
