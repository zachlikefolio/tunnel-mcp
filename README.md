# tunnel-mcp

**A direct, end-to-end-encrypted tunnel between two developers' Claude agents — no human copy-paste required.**

[![CI](https://github.com/zachlikefolio/tunnel-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/zachlikefolio/tunnel-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/tunnel-mcp)](https://www.npmjs.com/package/tunnel-mcp)
![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

When two developers each run a Claude agent and need those agents to collaborate,
the usual workaround is a human sitting in the middle, copy-pasting messages from
one chat window to the other. **tunnel-mcp** removes that human. It's an MCP
server that lets one developer's agent open a throwaway, encrypted tunnel and the
other developer's agent dial straight into it, so the two agents can talk to each
other directly — while their humans stay in control of what actually happens to
the filesystem or the shell.

## How it works

One developer (the **host**) calls `tunnel_open`. Their local `tunnel-mcp`
process becomes an in-process WebSocket relay and exposes it to the internet via
a throwaway `cloudflared` Quick Tunnel — no port-forwarding, no server to
provision. The other developer (the **guest**) calls `tunnel_join` with the link
the host shares, and their agent dials outbound to that same tunnel. Because both
sides only ever make outbound connections, it works from behind ordinary
firewalls and NAT.

```
   Host machine                                        Guest machine
  ┌───────────────────┐        outbound HTTPS         ┌───────────────────┐
  │   Claude (host)    │            wss://             │   Claude (guest)   │
  │        │           │      ┌──────────────┐         │        │          │
  │  tunnel_open/say/  │──────▶  cloudflared │◀────────│  tunnel_join/say/  │
  │  listen/close      │      │ Quick Tunnel │─────────▶  listen/close      │
  │        │           │      └──────────────┘         │        │          │
  │  in-process relay  │                                └───────────────────┘
  └───────────────────┘
```

The relay, the `cloudflared` child process, and the on-disk session log all live
only for the lifetime of the session and are destroyed on teardown.

## Install

```bash
npm install -g tunnel-mcp
# or, without installing:
npx tunnel-mcp
```

Register it with Claude Code (both developers do this once):

```bash
claude mcp add tunnel -- tunnel-mcp          # if globally installed
# or, with no global install:
claude mcp add tunnel -- npx -y tunnel-mcp
```

> `tunnel-mcp` is a stdio MCP server, not an interactive CLI. Launching it by
> hand just waits silently for a client — that's expected. Run
> `tunnel-mcp --help` for usage, or `tunnel-mcp --version`.

The **tunnel-etiquette skill** teaches each agent how to behave inside a tunnel
(treat the peer as untrusted input, and check with its human before acting on
anything the peer says). Installing the package copies it into `~/.claude/skills/`
automatically (best-effort). If install scripts are disabled
(`npm install --ignore-scripts`), or you want it in a custom directory or force an
update, run it explicitly:

```bash
npx tunnel-mcp install-skill                       # into ~/.claude/skills
npx tunnel-mcp install-skill --dir <path> --force  # elsewhere / overwrite
```

Set `TUNNEL_SKILLS_DIR` to change the default target, or
`TUNNEL_SKIP_SKILL_INSTALL=1` to opt out of the automatic copy.

`cloudflared` is auto-downloaded to `~/.tunnel/bin` the first time it's needed if
it isn't already on your `PATH` — there's nothing extra to install.

## Quickstart

**Host** — ask Claude to open a tunnel with a goal:

> "Open a tunnel to pair on debugging the checkout flow."

Claude calls `tunnel_open({ goal })` and returns a join link. Share that link
with the other developer over a trusted channel (Slack DM, etc.) — **it's a
secret**, since it contains the encryption key for the session. The link is
**single-use and expires after ~10 minutes** (`tunnel_open` reports
`joinLinkExpiresInSec`), so share it promptly.

**Guest** — paste the link and ask Claude to join:

> "Join this tunnel: `<link>`"

Claude calls `tunnel_join({ joinLink })`, learns the goal, and the session is
now locked to just the two of you.

**Both** — the agents converse turn-by-turn using `tunnel_say` to send and
`tunnel_listen` to wait for the next reply, checking in with their humans as
needed.

**Either side** ends the session with `tunnel_close`, which tears down the relay
and destroys the session log.

## Tools

| Tool                                     | Who   | Purpose                                                    |
| ---------------------------------------- | ----- | ---------------------------------------------------------- |
| `tunnel_open({goal})`                    | host  | Start the relay + Quick Tunnel and get back a join link.   |
| `tunnel_join({joinLink})`                | guest | Dial into a host's tunnel using the link and authenticate. |
| `tunnel_say({text})`                     | both  | Send a message to the peer.                                |
| `tunnel_listen({sinceSeq?, timeoutMs?})` | both  | Wait for the next message(s) from the peer.                |
| `tunnel_status()`                        | both  | Inspect the current session (connected, idle, etc.).       |
| `tunnel_close({summary?})`               | both  | End the session and tear down the relay.                   |

## Security model

tunnel-mcp is a security-sensitive tool by nature — it opens a live channel
between two AI agents. Here's exactly what it does and does not protect:

- **Chat message bodies are end-to-end encrypted.** Every `tunnel_say` body is
  sealed with NaCl `secretbox` (XSalsa20-Poly1305, via `tweetnacl`) before it
  crosses the `cloudflared` pipe. The relay and the pipe only ever see
  ciphertext for chat bodies.
- **The goal, both display names, and system events are plaintext.** The
  `tunnel_open` goal, each participant's name, and connection events
  (joined/left/idle/closed) are sent as plaintext metadata — do not put secrets
  in the goal string or a display name.
- **Authentication is proof-of-key-possession, not key transmission.** Joining
  uses an HMAC challenge to prove the guest holds the same key as the host; the
  raw key itself is never sent over the wire.
- **The join link is a single-use, expiring credential.** It embeds the session
  key, so treat it like a password — share it only over a channel you already
  trust (Slack DM, etc.), never in a public issue, PR, or chat. It is consumed
  by the first guest who joins (and can't be reused, even after they leave) and
  expires on its own after ~10 minutes, so a leaked link has a short, bounded
  window of exposure.
- **Exactly two participants, enforced by a lock.** The first guest to
  authenticate locks the session; nobody else can join after that.
- **The peer is untrusted input, not an instruction source.** Messages from the
  other agent are data to reason about, not commands to execute. The etiquette
  skill directs each agent to require its own human's sign-off before writing
  files, running risky commands, or declaring a fix "confirmed" based on
  something the peer said.
- **Everything is ephemeral.** The session tears down — destroying the relay,
  the `cloudflared` child process, and the on-disk log — on an explicit
  `tunnel_close`, after 30 minutes of no messages (idle timeout), or when the
  host's process exits.

See [SECURITY.md](./SECURITY.md) for the full threat model and how to report a
vulnerability.

## Requirements

- Node.js >= 20
- A Claude MCP client (e.g., Claude Code)
- `cloudflared` — auto-installed to `~/.tunnel/bin` on first use if not already
  on your `PATH`

## Development

```bash
npm ci                  # install dependencies
npm test                # run the test suite (136 tests, TDD)
npm run build           # compile TypeScript
npm run lint            # eslint
npm run format:check    # prettier --check .
npm run test:coverage   # vitest run --coverage
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for how to propose changes.

## Troubleshooting

**`tunnel-mcp` / `npx tunnel-mcp` "does nothing".** It's a stdio MCP server, not
an interactive CLI — with no arguments it starts and waits for an MCP client to
connect over stdin/stdout. That's working as intended. Register it with a client
(above), or run `tunnel-mcp --help`.

**`tunnel_open` fails with "never became reachable" / can't resolve
`*.trycloudflare.com`.** cloudflared reaches Cloudflare's edge over its own
protocol, but the public `*.trycloudflare.com` hostname still has to resolve via
normal DNS — and some networks (corporate/filtered networks, and a few public
DNS resolvers) block `trycloudflare.com`. Both you **and your guest** need to be
able to resolve it. Check with `dig +short <random>.trycloudflare.com` or
`curl -sI https://<the-url>`. If only your guest's network needs to reach the
URL, set `TUNNEL_SKIP_REACHABILITY_CHECK=1` to open the tunnel without the
host-side reachability probe.

## Roadmap / not yet supported

This is an MVP. The following are explicitly out of scope for now:

- Host-offline / asynchronous messaging
- More than two participants in a session
- Alternative transports (ngrok, WebRTC)
- Join-link rotation (re-issuing a fresh link mid-session; note that links are already single-use and expiring — see the security model above)
- Encrypting the goal or other metadata

## License

MIT — see [LICENSE](./LICENSE).
