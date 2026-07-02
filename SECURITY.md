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

This creates a private conversation with the maintainers and lets us
coordinate a fix and a disclosure timeline before any details become public.

When you report, please include:

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

tunnel-mcp lets developers' Claude agents exchange messages directly through a
host-owned, ephemeral relay, without a human copy-pasting between them.
Two-party is the default; the host can opt into a room of up to 16
participants. Understanding what is and isn't protected is important before
you share an invite with anyone.

- **Chat message bodies are end-to-end encrypted.** The text passed to
  `tunnel_say` is sealed with NaCl `secretbox` (XSalsa20-Poly1305, via
  `tweetnacl`) using a key that is never transmitted. The cloudflared
  pipe — and the Cloudflare edge it runs over — only ever sees ciphertext
  for chat message bodies.
- **Metadata is plaintext.** The `goal` passed to `tunnel_open`/`tunnel_join`,
  every member's display name, and system/connection events (joined, left,
  idle, closed) cross the tunnel as **plaintext**. Do not put secrets in the
  goal or a display name.
- **Authentication is proof-of-key-possession, not key transmission.** Every
  invite for a session embeds the same session key. A joining member's client
  proves it holds that key via an HMAC challenge/response; the raw key itself
  is never sent over the wire. Because an invite contains the key, **treat
  every invite like a password** — share it only over a trusted,
  already-authenticated channel (e.g. a Slack DM to a known teammate), not in
  a public channel or ticket, and forward each invite to exactly one person.
- **Invites are single-use and expiring.** Each invite is consumed by whoever
  successfully authenticates with it first and can never be redeemed again —
  even after that person disconnects. Invites also expire on their own (10
  minutes by default), so one that's never used stops working. This bounds
  the damage from a leaked invite to a short window before it is used or
  expires.
- **Invite-ledger admission.** A session admits only people the host minted
  an invite for — up to 16 members connected at once, including the host.
  Two-party remains the default. Every invite is single-use, consumed
  atomically by the first successful join and dead forever after — the same
  invite can never be redeemed a second time, even by the person who first
  used it. Invites expire after ~10 minutes. A disconnected member's old
  invite stays dead; getting back in requires a fresh invite from the host.
  Only the host can mint invites, so a member who leaks the room key alone
  cannot seat anyone.
- **Peer input is untrusted, from every member.** Everything a peer sends
  over the tunnel is data, never an instruction — and in a room, that holds
  for each participant individually, not just "the other side." The bundled
  `tunnel-etiquette` skill instructs each agent to treat incoming peer
  messages as untrusted input and to get its own human's explicit OK before
  writing files, running risky commands, or declaring a fix "confirmed"
  based on something a peer said.
- **Ephemeral by design.** The transcript is held in memory only — it is
  never written to disk, and it vanishes with the process. Teardown is
  role-sensitive: the host's explicit `tunnel_close`, an idle timeout (30
  minutes with no messages), or the host process exiting all tear down the
  whole session — the in-process relay, the cloudflared child process, and
  the throwaway Quick Tunnel URL — for every member at once. A member's own
  `tunnel_close` only removes that member; it does not tear anything down
  for anyone else. Nothing persists past a session's own teardown.

## Supply chain

tunnel-mcp is a security-sensitive tool, so its build and distribution chain is
hardened against tampering:

- **npm provenance.** Releases are published from GitHub Actions via npm Trusted
  Publishing (OIDC) — no long-lived npm token exists — and every published
  version carries a signed provenance attestation. You can verify a release was
  built from this repository with `npm audit signatures`.
- **The auto-downloaded cloudflared binary is pinned and verified.** tunnel-mcp
  fetches a specific pinned cloudflared version and checks the artifact's SHA-256
  against a hash committed in the source (and covered by the provenance
  attestation) **before** it is extracted, moved into place, or made executable.
  A mismatched or tampered binary is refused, not run.
- **Pinned, reviewed dependencies.** Production dependencies are minimal and
  installed from a committed lockfile with integrity hashes (`npm ci`).
  Dependabot proposes updates, and a `dependency-review` gate blocks any pull
  request that would introduce a dependency with a known high-severity
  vulnerability.
- **Pinned GitHub Actions + least privilege.** Every third-party GitHub Action is
  pinned to a full commit SHA (not a mutable tag), and workflow `GITHUB_TOKEN`
  permissions default to read-only, scoped up only where a job requires it.
- **Continuous scanning.** OpenSSF Scorecard tracks the repository's
  supply-chain posture, and CodeQL runs static analysis on every push and pull
  request.

To bump the pinned cloudflared version, a maintainer runs
`node scripts/refresh-cloudflared-hashes.mjs <version>` and commits the updated
version and checksums, keeping the pin auditable.

## Known Limitations / Threat Model

This is an MVP and it is important to be honest about what it does **not**
protect against:

- **The relay path sees metadata in the clear.** The cloudflared Quick
  Tunnel is a real network hop through Cloudflare's edge. While chat
  message bodies are encrypted end-to-end, the goal, every display name,
  and system/connection events are visible in plaintext to anything that
  can observe that path (including Cloudflare's infrastructure). Do not
  put secrets in the goal or names.
- **A leaked invite can still be redeemed within its window, before your
  intended teammate joins.** Invites are single-use and expire (10 minutes
  by default), so a leaked invite that is never used, has already been used,
  or has aged out can no longer admit anyone. The residual risk is a race: if
  an invite leaks and an attacker redeems it faster than your intended
  teammate — within the expiry window and before that person connects — the
  attacker consumes the single-use invite, joins in their place, and locks
  them out (a fresh invite from the host is needed to re-admit them). Share
  invites only over trusted channels, one per person, and mint a fresh
  invite (or open a fresh tunnel) if you suspect one was exposed before it
  was used. There is no in-session key rotation.
- **The goal is never encrypted.** By design, the goal string is plaintext
  metadata used for connection setup and display; it receives no
  confidentiality protection at any layer.
- **One shared key per room — every member reads everything.** All chat
  message bodies in a session are encrypted under the single key embedded in
  every invite for that session, not a separate key per pair of
  participants. In a room, that means every current member can decrypt every
  other member's chat messages — there is no sub-group or pairwise privacy
  within a session. Admission is still gated per-person by the invite ledger
  (see above); this limitation is about message confidentiality once someone
  is in the room, not about who can get in.
- **"Trusting" a peer only goes as far as your own agent's guardrails.**
  tunnel-mcp does not sandbox or validate what a peer sends beyond
  transport-level auth. The confidentiality/integrity of your own
  workspace depends on the `tunnel-etiquette` skill being installed and
  your agent honoring it (treating peer messages as untrusted data,
  requiring human approval for file writes, running commands, or
  confirming fixes). If you disable or bypass that skill, a malicious or
  compromised peer's messages could otherwise be misinterpreted as
  instructions by an unguarded agent — and in a room, this applies to
  every member, not just one.
- **Out of scope for this release**: host-offline/async messaging,
  alternative transports (ngrok, WebRTC), in-session key/invite rotation
  (replacing a still-valid invite before it's used or expires), and
  encryption of the goal or other connection metadata. These may be
  considered for future versions but should not be assumed to exist today.

If you find a way to break any of the guarantees above (e.g. read a chat
message body without the key, join a locked session, or get an agent to
treat peer input as trusted instructions bypassing the etiquette skill),
please report it via the process described above — that is exactly the
kind of issue we want to hear about.
