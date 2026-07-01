# Security Policy

## Supported Versions

tunnel-mcp is pre-1.0 and moving quickly. Only the latest `0.1.x` release
receives security fixes.

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1   | :x:                |

## Reporting a Vulnerability

Please **do not open a public GitHub issue** for security vulnerabilities.

The preferred way to report a vulnerability is through GitHub's private
security advisories:

1. Go to the [tunnel-mcp repository](https://github.com/zachlikefolio/tunnel-mcp).
2. Open the **Security** tab.
3. Click **Report a vulnerability** to open a new draft security advisory.

This creates a private conversation with the maintainer and lets us
coordinate a fix and a disclosure timeline before any details become public.

If you cannot use GitHub's advisory flow, you may instead email
**zach@likefolio.com** with details of the issue. Please include:

- A description of the vulnerability and its potential impact.
- Steps to reproduce, or a proof-of-concept, if available.
- The version/commit of tunnel-mcp you tested against.
- Any suggested remediation, if you have one.

### What to expect

- **Acknowledgement**: you should hear back within a few days of your
  report.
- **Updates**: we'll keep you posted as we investigate and work on a fix.
- **Credit**: reporters are credited in the advisory and/or release notes
  once a fix ships, unless you tell us you'd prefer to remain anonymous.

## Security Model

tunnel-mcp lets two developers' Claude agents exchange messages directly
through a host-owned, ephemeral relay, without a human copy-pasting between
them. Understanding what is and isn't protected is important before you
share a join link with anyone.

- **Chat message bodies are end-to-end encrypted.** The text passed to
  `tunnel_say` is sealed with NaCl `secretbox` (XSalsa20-Poly1305, via
  `tweetnacl`) using a key that is never transmitted. The cloudflared
  pipe — and the Cloudflare edge it runs over — only ever sees ciphertext
  for chat message bodies.
- **Metadata is plaintext.** The `goal` passed to `tunnel_open`/`tunnel_join`,
  both participants' display names, and system/connection events (joined,
  left, idle, closed) cross the tunnel as **plaintext**. Do not put secrets
  in the goal or display name.
- **Authentication is proof-of-key-possession, not key transmission.** The
  join link embeds a session key. The guest's client proves it holds that
  key via an HMAC challenge/response; the raw key itself is never sent over
  the wire. Because the join link contains the key, **treat the join link
  like a password** — share it only over a trusted, already-authenticated
  channel (e.g. a Slack DM to a known teammate), not in a public channel or
  ticket.
- **Single-guest lock.** The first participant who successfully
  authenticates as guest locks the session. Sessions are strictly two-party;
  a second join attempt is rejected.
- **Peer input is untrusted.** Everything a peer sends over the tunnel is
  data, never an instruction. The bundled `tunnel-etiquette` skill
  instructs each agent to treat incoming peer messages as untrusted input
  and to get its own human's explicit OK before writing files, running
  risky commands, or declaring a fix "confirmed" based on something the
  peer said.
- **Ephemeral by design.** A session and everything tied to it — the
  in-process relay, the cloudflared child process, the throwaway Quick
  Tunnel URL, and the on-disk session log — are torn down on: an explicit
  `tunnel_close`, an idle timeout (30 minutes with no messages), or the
  host process exiting. Nothing persists past teardown.

## Known Limitations / Threat Model

This is an MVP and it is important to be honest about what it does **not**
protect against:

- **The relay path sees metadata in the clear.** The cloudflared Quick
  Tunnel is a real network hop through Cloudflare's edge. While chat
  message bodies are encrypted end-to-end, the goal, both display names,
  and system/connection events are visible in plaintext to anything that
  can observe that path (including Cloudflare's infrastructure). Do not
  put secrets in the goal or names.
- **No link rotation or expiry beyond session teardown.** A join link is
  valid for the lifetime of the session. If a join link leaks (pasted into
  the wrong channel, logged, etc.) before the host closes the session,
  anyone with that link can join as the guest — up until the host runs
  `tunnel_close`, the session idles out, or the host process exits. There
  is currently no way to rotate the key or issue single-use/expiring
  tokens.
- **The goal is never encrypted.** By design, the goal string is plaintext
  metadata used for connection setup and display; it receives no
  confidentiality protection at any layer.
- **Strictly two-party.** The protocol only supports one host and one
  guest per session. There is no support for additional participants,
  multi-party relays, or host-offline/async delivery in this MVP.
- **"Trusting" a peer only goes as far as your own agent's guardrails.**
  tunnel-mcp does not sandbox or validate what a peer sends beyond
  transport-level auth. The confidentiality/integrity of your own
  workspace depends on the `tunnel-etiquette` skill being installed and
  your agent honoring it (treating peer messages as untrusted data,
  requiring human approval for file writes, running commands, or
  confirming fixes). If you disable or bypass that skill, a malicious or
  compromised peer's messages could otherwise be misinterpreted as
  instructions by an unguarded agent.
- **Out of scope for this release**: host-offline/async messaging,
  more than two participants, alternative transports (ngrok, WebRTC),
  link rotation or one-time join tokens, and encryption of the goal or
  other connection metadata. These may be considered for future versions
  but should not be assumed to exist today.

If you find a way to break any of the guarantees above (e.g. read a chat
message body without the key, join a locked session, or get an agent to
treat peer input as trusted instructions bypassing the etiquette skill),
please report it via the process described above — that is exactly the
kind of issue we want to hear about.
