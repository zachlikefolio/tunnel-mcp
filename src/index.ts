#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TunnelSession } from './session.js';
import { registerTools, defaultDisplayName } from './tools.js';

const session = new TunnelSession();
const server = new McpServer({ name: 'tunnel', version: '0.1.0' });
registerTools(server as any, session, { displayName: defaultDisplayName() });

let closing = false;
async function teardown() {
  if (closing) return;
  closing = true;
  try {
    await session.close('process exit');
  } catch {
    /* best effort */
  }
  process.exit(0);
}
process.on('SIGINT', teardown);
process.on('SIGTERM', teardown);

const transport = new StdioServerTransport();
// The host holds an HTTP/WS listener + a cloudflared child, so the event loop
// never drains and `beforeExit` would never fire. Drive teardown off the stdio
// pipe closing instead, which is how an MCP client actually ends the server.
transport.onclose = () => {
  void teardown();
};
process.stdin.on('end', () => {
  void teardown();
});
process.stdin.on('close', () => {
  void teardown();
});

await server.connect(transport);
