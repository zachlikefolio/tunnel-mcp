# tunnel-mcp

**A direct, end-to-end-encrypted tunnel between two developers' Claude agents — no human copy-paste required.**

[![CI](https://github.com/zachlikefolio/tunnel-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/zachlikefolio/tunnel-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/tunnel-mcp)](https://www.npmjs.com/package/tunnel-mcp)
[![npm downloads](https://img.shields.io/npm/dm/tunnel-mcp)](https://www.npmjs.com/package/tunnel-mcp)
![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

![tunnel-mcp demo — two agents talking through a real encrypted tunnel](docs/demo.gif)

**Reproduce that yourself in 30 seconds** — clone the repo and:

```bash
npm ci && npm run demo
```

That opens a real encrypted tunnel through Cloudflare's edge, joins it as a
guest, exchanges end-to-end-encrypted messages, proves the join link is
single-use, and tears everything down.

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

The relay and the `cloudflared` child process live only for the lifetime of the
session and are destroyed on teardown. The transcript is held in memory only —
nothing is ever written to disk, and it vanishes with the process at teardown.

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

Claude calls `tunnel_open({ goal })` and hands back a ready-to-forward
**invite** — one plain-text message containing the one-time setup command and
the join link. Paste it to the other developer over a trusted channel (Slack
DM, etc.) — **the link is a secret**, since it contains the encryption key for
the session. It is **single-use and expires after ~10 minutes**
(`tunnel_open` reports `joinLinkExpiresInSec`), so share it promptly.

**Guest** — paste the link and ask Claude to join:

> "Join this tunnel: `<link>`"

Claude calls `tunnel_join({ joinLink })`, learns the goal, and gets back the
room's member roster — with the default single invite, that's just the two of
you.

**More than one guest? Open a room instead:**

> "Open a tunnel for me and two teammates, to pair on the checkout flow."

Claude calls `tunnel_open({ goal, invites: 3 })` — `invites` is the number of
teammates to seat (up to 15, plus the host makes 16 connected at once) — and gets
back one **invite** per teammate instead of a single link. Forward each invite
to exactly one person; every invite is single-use, so don't reuse one link for
two people. Need to add someone mid-session, or re-admit someone whose invite
expired before they used it? `tunnel_invite({ count })` (host-only) mints more.

**Both** — the agents converse turn-by-turn using `tunnel_say` to send and
`tunnel_listen` to wait for the next reply. In a room, every message arrives
with `fromName` so agents can tell who said what, checking in with their humans
as needed.

**Ending it** is role-sensitive: the **host** calls `tunnel_close` to end the
session for everyone and tear down the relay — the in-memory transcript vanishes
with it, since it was never written to disk. A **member** calling `tunnel_close`
just leaves; the room stays open for whoever's left.

**Sharing files:** any member can call `tunnel_share({ path })` to send a text
or binary file to the room — it's read from disk, hashed, and sealed with the
room key before it ever crosses the tunnel, so the relay only ever sees
ciphertext. The offer shows up for teammates as an `artifact` message in
`tunnel_listen` and in `tunnel_status().artifacts` (id, name, kind, size,
sender). A teammate who wants it calls `tunnel_receive({ artifactId, savePath })`
with a path **they** choose — the bytes are decrypted and checked against the
sender's sha256 before anything is written, and a mismatch is refused rather
than saved. An artifact stays fetchable by any current member until it expires
(a 30-minute TTL) or the session ends — each `tunnel_receive` call independently
re-fetches and re-verifies. Members on an older client are silently skipped
(`olderMembers` in the `tunnel_share` result) — they simply never see the
offer. Filenames cross as plaintext metadata, so don't put secrets in one, and
treat every received file as untrusted input — see the etiquette skill.

## Tools

| Tool                                     | Who    | Purpose                                                                                                             |
| ---------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------- |
| `tunnel_open({goal, invites?})`          | host   | Start the relay + Quick Tunnel and get back one invite per teammate (default 1 — classic two-party).                |
| `tunnel_invite({count?})`                | host   | Mint more single-use, expiring invites mid-session.                                                                 |
| `tunnel_join({joinLink})`                | member | Dial into a room using an invite link and authenticate; returns the current member roster.                          |
| `tunnel_say({text})`                     | any    | Send a message to the room.                                                                                         |
| `tunnel_listen({sinceSeq?, timeoutMs?})` | any    | Wait for the next message(s), each tagged with the sender's `fromName`.                                             |
| `tunnel_share({path})`                   | any    | Share a file (text or binary) with the room, end-to-end encrypted; returns `{artifactId, offeredTo, olderMembers}`. |
| `tunnel_receive({artifactId, savePath})` | any    | Fetch an offered artifact, verify its hash, and write it to a path you choose.                                      |
| `tunnel_status()`                        | any    | Inspect the session: role, goal, member roster, pending invites, offered artifacts, lastSeq.                        |
| `tunnel_close({summary?})`               | any    | Host: ends the session for everyone. Member: leaves the room.                                                       |

## Security model

tunnel-mcp is a security-sensitive tool by nature — it opens a live channel
between developers' AI agents. Here's exactly what it does and does not protect:

- **Chat message bodies are end-to-end encrypted.** Every `tunnel_say` body is
  sealed with NaCl `secretbox` (XSalsa20-Poly1305, via `tweetnacl`) before it
  crosses the `cloudflared` pipe. The relay and the pipe only ever see
  ciphertext for chat bodies.
- **The goal, every participant's display name, and system events are
  plaintext.** The `tunnel_open` goal, each member's name, and connection
  events (joined/left/idle/closed) are sent as plaintext metadata — do not put
  secrets in the goal string or a display name.
- **Authentication is proof-of-key-possession, not key transmission.** Joining
  uses an HMAC challenge to prove the joining member holds the same key as the
  host; the raw key itself is never sent over the wire.
- **Each invite is a single-use, expiring credential.** It embeds the session
  key, so treat it like a password — share it only over a channel you already
  trust (Slack DM, etc.), never in a public issue, PR, or chat, and forward each
  invite to exactly one person. It is consumed by whoever redeems it first (and
  can't be reused, even after they leave) and expires on its own after ~10
  minutes, so a leaked invite has a short, bounded window of exposure.
- **Admits exactly whom you invited** — two-party by default, rooms opt-in
  (cap 16), every invite single-use + expiring. Admission is bounded by how
  many invites the host chose to mint, not by who happens to have the room's
  key.
- **Shared files are end-to-end encrypted and hash-verified.** `tunnel_share`
  seals a file's bytes with the same room key as chat (NaCl `secretbox`)
  before they cross the tunnel, and carries a plaintext sha256 of the
  contents; `tunnel_receive` decrypts, reassembles, and verifies that hash
  before writing anything to disk. The filename, size, and kind are plaintext
  metadata (don't put secrets in a filename), and a received file is
  untrusted — `tunnel_receive` only ever writes to a path the receiver
  chooses, never the sender's name.
- **The peer is untrusted input, not an instruction source.** Messages from
  other agents are data to reason about, not commands to execute — and this
  applies to every member in a room, not just one. The etiquette skill directs
  each agent to require its own human's sign-off before writing files, running
  risky commands, or declaring a fix "confirmed" based on something a peer
  said.
- **Everything is ephemeral.** The transcript is held in memory only — nothing
  is ever written to disk, and it vanishes with the process. Teardown is
  role-sensitive: the host's `tunnel_close` (or their process exiting, or 30
  minutes of no messages) ends the session for everyone and tears down the
  relay + `cloudflared` child process; a member's `tunnel_close` just leaves —
  the room stays open for whoever's left.

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
npm test                # run the test suite (248 tests, TDD)
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

**Guest join fails with `getaddrinfo ENOTFOUND …trycloudflare.com`.** A
cloudflared quick tunnel prints its URL a few seconds _before_ the per-tunnel DNS
record has propagated. If anything looks the name up too early it gets an
`NXDOMAIN` that the resolver negative-caches for up to 30 minutes — breaking the
join even after the tunnel is live. `tunnel-mcp` avoids this: `tunnel_open` waits
for the record to actually resolve (via DoH to Cloudflare's `1.1.1.1`, an IP that
never touches — and so never poisons — your system resolver) before returning the
link, and the guest resolves system-first with a DoH fallback. So a fresh join
should just work; if you hit `ENOTFOUND`, an _earlier_ attempt likely poisoned the
cache — wait for it to expire, or flush DNS (`sudo dscacheutil -flushcache` on
macOS). Set `TUNNEL_DOH=off` only on networks that block DoH (`1.1.1.1`) and where
system DNS already resolves `*.trycloudflare.com`.

## Roadmap / not yet supported

This is an MVP. The following are explicitly out of scope for now:

- Host-offline / asynchronous messaging
- Alternative transports (ngrok, WebRTC)
- Invite rotation (replacing a specific still-valid invite mid-session; note invites are already single-use and expiring — see the security model above)
- Encrypting the goal or other metadata

## License

MIT — see [LICENSE](./LICENSE).
