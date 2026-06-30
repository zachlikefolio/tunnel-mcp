# tunnel-mcp

Let two developers' Claude agents talk **directly** instead of copy-pasting
between them. The initiator's machine spins up an ephemeral, end-to-end-encrypted
relay (exposed via a throwaway `cloudflared` Quick Tunnel) and tears it down when
the session ends. No central server, no accounts.

## Install

```bash
npm install -g tunnel-mcp     # or: npx tunnel-mcp
```

Add it to Claude Code (both developers do this once):

```bash
claude mcp add tunnel -- tunnel-mcp
```

Install the etiquette skill (copy `skill/tunnel-etiquette/` into your
`~/.claude/skills/` or a plugin's skills directory) so your agent knows how to
behave inside a tunnel.

`cloudflared` is auto-downloaded to `~/.tunnel/bin` on first use if it isn't
already on your `PATH`.

## Use

**Host** (the developer who starts it): ask Claude to open a tunnel.
- It calls `tunnel_open({ goal })` and gives you a **join link**. Share that link
  with the other developer over a trusted channel (Slack DM, etc.). The link
  contains the encryption key — treat it like a password.

**Guest**: paste the link to your Claude and ask it to join.
- It calls `tunnel_join({ joinLink })`, learns the goal, and the two agents
  converse turn-by-turn via `tunnel_say` / `tunnel_listen`.

Either side ends it with `tunnel_close`. The host's relay and the session log are
destroyed.

## Tools

| Tool | Who | Purpose |
|---|---|---|
| `tunnel_open({goal})` | host | start the relay, get a join link |
| `tunnel_join({joinLink})` | guest | connect to the host |
| `tunnel_say({text})` | both | send a message to the peer |
| `tunnel_listen({sinceSeq?, timeoutMs?})` | both | wait for the next reply |
| `tunnel_status()` | both | inspect the session |
| `tunnel_close({summary?})` | both | end the session / tear down |

## Security model

- **End-to-end encrypted:** chat bodies are sealed with libsodium secretbox; the
  `cloudflared` pipe sees only ciphertext.
- **Auth by key possession:** the join link's key is proven via HMAC challenge,
  never sent over the wire. First valid guest locks the session (exactly 2 people).
- **Untrusted peer:** the etiquette skill makes your agent treat peer messages as
  data, never instructions, and gate on your approval before any write or claim.
- **Ephemeral:** teardown on `tunnel_close`, idle timeout, or host process exit.

## Development

```bash
npm install
npm test          # full vitest suite
npm run build     # emit dist/
```
