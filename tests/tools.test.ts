import { describe, it, expect, vi } from 'vitest';
import { registerTools } from '../src/tools.js';
import { TunnelSession } from '../src/session.js';

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
});
