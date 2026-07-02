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

function fakeDeps(joinTtlMs?: number) {
  return {
    ensureCloudflared: async () => 'fake',
    startCloudflared: async (_b: string, port: number) => ({
      publicUrl: `http://127.0.0.1:${port}`,
      stop() {},
    }),
    joinTtlMs,
  };
}

// Wait until `pred` over fresh listen batches passes or the deadline hits.
async function waitFor(
  s: TunnelSession,
  pred: (texts: { text: string; fromName?: string; kind: string }[]) => boolean,
  deadlineMs = 4000,
) {
  const stop = Date.now() + deadlineMs;
  let since = 0;
  const seen: { text: string; fromName?: string; kind: string }[] = [];
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

describe('room integration (4 participants, fake cloudflared)', () => {
  it('runs a full room lifecycle', async () => {
    const host = new TunnelSession(fakeDeps());
    const [ana, ben, cyd] = [new TunnelSession(), new TunnelSession(), new TunnelSession()];
    sessions.push(host, ana, ben, cyd);

    // open with 2 invites; invite the third mid-session
    const opened = await host.open('room test', 'Host', { invites: 2 });
    expect(opened.status).toBe('waiting_for_members');
    expect(opened.invites).toHaveLength(2);
    expect(opened.joinLink).toBeUndefined(); // continuity trio only when invites == 1

    const j1 = await ana.join(opened.invites[0].joinLink, 'Ana');
    expect(j1.self.id).toMatch(/^[0-9a-f]{16}$/);
    await ben.join(opened.invites[1].joinLink, 'Ben');

    const [third] = host.invite(1);
    const j3 = await cyd.join(third.joinLink, 'Cyd');
    expect(j3.members.map((m) => m.name).sort()).toEqual(['Ana', 'Ben', 'Cyd', 'Host']);

    // everyone hears everyone, with names resolved
    await host.say('hello room');
    await ana.say('ana here');
    await waitFor(cyd, (msgs) =>
      ['hello room', 'ana here'].every((t) => msgs.some((m) => m.kind === 'chat' && m.text === t)),
    );
    const cydSeen = await waitFor(cyd, (m) => m.some((x) => x.text === 'ana here'));
    expect(cydSeen.find((m) => m.text === 'ana here')?.fromName).toBe('Ana');

    // late joiner backlog: Ben left early? No — Ben leaves, roster retains him
    await ben.close();
    await waitFor(host, (msgs) => msgs.some((m) => m.kind === 'system' && /Ben left/.test(m.text)));
    const st = host.status();
    expect(st.members.find((m) => m.name === 'Ben')?.connected).toBe(false);
    expect(st.members).toHaveLength(4); // departed members retained

    // used link is dead
    const stray = new TunnelSession();
    sessions.push(stray);
    await expect(stray.join(opened.invites[0].joinLink, 'Mallory')).rejects.toThrow(/already used/);

    // member-close left the room open; host-close ends it for everyone
    await host.close('done');
    expect(host.isOpen).toBe(false);
  }, 20000);

  it('a member cannot mint invites', async () => {
    const host = new TunnelSession(fakeDeps());
    const ana = new TunnelSession();
    sessions.push(host, ana);
    const opened = await host.open('authz test', 'Host');
    await ana.join(opened.joinLink!, 'Ana');
    expect(() => ana.invite(1)).toThrow('only the host can mint invites');
  });
});
