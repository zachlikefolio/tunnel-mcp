import { describe, it, expect, vi } from 'vitest';
import { registerTools, defaultDisplayName } from '../src/tools.js';
import { TunnelSession } from '../src/session.js';
import { DEFAULT_LISTEN_TIMEOUT_MS } from '../src/config.js';

// Minimal fake McpServer capturing registered tool callbacks.
function fakeServer() {
  const tools: Record<string, (args: any) => Promise<any>> = {};
  return {
    tools,
    registerTool(name: string, _schema: any, cb: (args: any) => Promise<any>) { tools[name] = cb; },
    tool(name: string, _schema: any, cb: (args: any) => Promise<any>) { tools[name] = cb; },
  } as any;
}

describe('registerTools', () => {
  it('registers all six tunnel tools', () => {
    const server = fakeServer();
    registerTools(server, new TunnelSession(), { displayName: 'alice' });
    expect(Object.keys(server.tools).sort()).toEqual(
      ['tunnel_close', 'tunnel_join', 'tunnel_listen', 'tunnel_open', 'tunnel_say', 'tunnel_status'].sort(),
    );
  });

  it('tunnel_open delegates to the session and returns text content', async () => {
    const server = fakeServer();
    const session = new TunnelSession();
    vi.spyOn(session, 'open').mockResolvedValue({ tunnelId: 'id1', joinLink: 'wss://x/t/id1#k', status: 'waiting_for_guest' });
    registerTools(server, session, { displayName: 'alice' });

    const res = await server.tools['tunnel_open']({ goal: 'fix it' });
    expect(session.open).toHaveBeenCalledWith('fix it', 'alice');
    expect(res.content[0].text).toContain('wss://x/t/id1#k');
  });

  it('tunnel_join delegates joinLink and displayName to session.join', async () => {
    const server = fakeServer();
    const session = new TunnelSession();
    const joinResult = { tunnelId: 'id2', goal: 'pair', peer: 'bob' };
    vi.spyOn(session, 'join').mockResolvedValue(joinResult as any);
    registerTools(server, session, { displayName: 'carol' });

    const res = await server.tools['tunnel_join']({ joinLink: 'wss://x/t/id2#k' });
    expect(session.join).toHaveBeenCalledWith('wss://x/t/id2#k', 'carol');
    expect(res).toEqual({ content: [{ type: 'text', text: JSON.stringify(joinResult) }] });
  });

  it('tunnel_say delegates text to session.say', async () => {
    const server = fakeServer();
    const session = new TunnelSession();
    const sayResult = { seq: 3 };
    vi.spyOn(session, 'say').mockResolvedValue(sayResult as any);
    registerTools(server, session, { displayName: 'alice' });

    const res = await server.tools['tunnel_say']({ text: 'hello peer' });
    expect(session.say).toHaveBeenCalledWith('hello peer');
    expect(res).toEqual({ content: [{ type: 'text', text: JSON.stringify(sayResult) }] });
  });

  it('tunnel_listen delegates sinceSeq and timeoutMs to session.listen', async () => {
    const server = fakeServer();
    const session = new TunnelSession();
    const listenResult = { messages: [{ seq: 1, text: 'hi' }] };
    vi.spyOn(session, 'listen').mockResolvedValue(listenResult as any);
    registerTools(server, session, { displayName: 'alice' });

    const res = await server.tools['tunnel_listen']({ sinceSeq: 5, timeoutMs: 1234 });
    expect(session.listen).toHaveBeenCalledWith(5, 1234);
    expect(res).toEqual({ content: [{ type: 'text', text: JSON.stringify(listenResult) }] });
  });

  it('tunnel_listen defaults sinceSeq to 0 and timeoutMs to DEFAULT_LISTEN_TIMEOUT_MS when omitted', async () => {
    const server = fakeServer();
    const session = new TunnelSession();
    vi.spyOn(session, 'listen').mockResolvedValue({ messages: [] } as any);
    registerTools(server, session, { displayName: 'alice' });

    await server.tools['tunnel_listen']({});
    expect(session.listen).toHaveBeenCalledWith(0, DEFAULT_LISTEN_TIMEOUT_MS);
  });

  it('tunnel_listen treats sinceSeq: 0 explicitly the same as default', async () => {
    const server = fakeServer();
    const session = new TunnelSession();
    vi.spyOn(session, 'listen').mockResolvedValue({ messages: [] } as any);
    registerTools(server, session, { displayName: 'alice' });

    await server.tools['tunnel_listen']({ sinceSeq: 0 });
    expect(session.listen).toHaveBeenCalledWith(0, DEFAULT_LISTEN_TIMEOUT_MS);
  });

  it('tunnel_status delegates to session.status with no args', async () => {
    const server = fakeServer();
    const session = new TunnelSession();
    const statusResult = { role: 'host', peerConnected: false, goal: 'x', lastSeq: 0, openedAt: 123 };
    vi.spyOn(session, 'status').mockReturnValue(statusResult as any);
    registerTools(server, session, { displayName: 'alice' });

    const res = await server.tools['tunnel_status']({});
    expect(session.status).toHaveBeenCalledWith();
    expect(res).toEqual({ content: [{ type: 'text', text: JSON.stringify(statusResult) }] });
  });

  it('tunnel_close delegates summary to session.close', async () => {
    const server = fakeServer();
    const session = new TunnelSession();
    const closeResult = { closed: true };
    vi.spyOn(session, 'close').mockResolvedValue(closeResult as any);
    registerTools(server, session, { displayName: 'alice' });

    const res = await server.tools['tunnel_close']({ summary: 'all done' });
    expect(session.close).toHaveBeenCalledWith('all done');
    expect(res).toEqual({ content: [{ type: 'text', text: JSON.stringify(closeResult) }] });
  });

  it('tunnel_close passes undefined summary through when omitted', async () => {
    const server = fakeServer();
    const session = new TunnelSession();
    vi.spyOn(session, 'close').mockResolvedValue({ closed: true } as any);
    registerTools(server, session, { displayName: 'alice' });

    await server.tools['tunnel_close']({});
    expect(session.close).toHaveBeenCalledWith(undefined);
  });
});

describe('defaultDisplayName', () => {
  it('returns a non-empty string', () => {
    const name = defaultDisplayName();
    expect(typeof name).toBe('string');
    expect(name.length).toBeGreaterThan(0);
  });
});
