# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Nothing yet.

## [0.1.6] - 2026-07-01

### Security

- **The auto-downloaded cloudflared binary is now pinned and integrity-verified.**
  Instead of pulling `releases/latest` unverified, tunnel-mcp downloads a pinned
  cloudflared version and checks its SHA-256 against a hash committed in the
  source (and covered by the npm provenance attestation) before the binary is
  extracted, installed, or made executable — so a tampered or wrong-version
  binary is refused, not run. Bump with `scripts/refresh-cloudflared-hashes.mjs`.
- **Supply-chain hardening of the pipeline:** every GitHub Action is pinned to a
  full commit SHA (not a mutable tag), workflow token permissions default to
  read-only, a `dependency-review` gate blocks PRs that introduce known-vulnerable
  dependencies, and OpenSSF Scorecard + CodeQL scanning run on the repository. See
  the new "Supply chain" section in `SECURITY.md`.

## [0.1.5] - 2026-07-01

### Changed

- Housekeeping: package authorship and the security/conduct reporting contacts
  now use the project's GitHub handle and GitHub's private advisory flow instead
  of a personal email. No functional or API changes.

## [0.1.4] - 2026-07-01

### Fixed

- **Guests no longer fail to join with `getaddrinfo ENOTFOUND …trycloudflare.com`.**
  Root cause: a cloudflared quick tunnel prints its URL ~8–25s before the
  per-tunnel DNS record propagates, and the old host-side reachability probe
  looked the name up immediately — seeding an `NXDOMAIN` that the resolver
  negative-cached for up to 30 minutes (the zone's SOA minimum), breaking the
  guest's join even after the tunnel went live. The probe was the cause, not a
  diagnostic.

### Changed

- **`tunnel_open` now gates the join link on real DNS readiness via DoH.** After
  cloudflared reports the URL, the host polls liveness over IP-literal DoH
  endpoints (`1.1.1.1`/`1.0.0.1`/`8.8.8.8`) — which never touch, and so never
  poison, the system resolver — and only returns the link once the record
  resolves (best-effort: it never blocks or hard-fails; after a budget it returns
  the link anyway).
- **The guest resolves system-first with a DoH fallback**, connecting by the
  resolved IP while keeping SNI/Host = the hostname, so a guest whose resolver
  lags or holds a stale negative cache still connects.
- **Guest connection is now time-bounded** (handshake + overall connect deadline),
  so a black-hole link fails fast with a clear error instead of hanging.
- The `0.1.3` `TUNNEL_REACHABILITY` (and `0.1.2` `TUNNEL_SKIP_REACHABILITY_CHECK`)
  environment variables are **no longer read** — they only ever relaxed the
  now-deleted probe. New single knob: `TUNNEL_DOH=off` disables DoH for networks
  that block it and where system DNS already works.

## [0.1.3] - 2026-07-01

### Changed

- **`tunnel_open` no longer hard-fails when the host can't reach
  `*.trycloudflare.com`.** Because this is a cross-network tool, only the guest's
  network has to reach the link — so a host-side reachability-probe failure
  (blocked DNS, or a proxy Node's `fetch` ignores) now **opens the tunnel anyway
  and returns a `reachabilityWarning`** by default, instead of blocking a tunnel
  that would have worked for the guest. Behavior is configurable via
  `TUNNEL_REACHABILITY`: `warn` (default), `strict` (previous hard-fail), or
  `off` (skip the probe). This replaces the `TUNNEL_SKIP_REACHABILITY_CHECK` flag
  from 0.1.2, which is still honored as `off` for backward compatibility.

## [0.1.2] - 2026-07-01

### Added

- **`install-skill` command and automatic skill install.** `tunnel-mcp
install-skill` copies the `tunnel-etiquette` skill into `~/.claude/skills`
  (override with `--dir`/`$TUNNEL_SKILLS_DIR`, overwrite with `--force`), and a
  global `npm install` now installs it best-effort via a postinstall script.
  Set `TUNNEL_SKIP_SKILL_INSTALL=1` to opt out; the postinstall never fails an
  install and is a no-op under `npx`, `--ignore-scripts`, and CI.
- **`--help` and `--version` flags**, plus a one-line stderr startup banner, so
  running the server by hand no longer looks like a silent hang. The server also
  hints how to install the etiquette skill when it isn't present.
- **`TUNNEL_SKIP_REACHABILITY_CHECK` escape hatch.** Opens a tunnel even when the
  host can't reach `*.trycloudflare.com` itself — useful when only the guest's
  network needs to reach the URL.

### Fixed

- The MCP server reported a hardcoded, stale version (`0.1.0`) in its handshake;
  it now reports the real package version.
- A failed cloudflared reachability probe surfaced a generic "never became
  reachable" error. It now names the host and, when the failure is DNS
  resolution, points at `*.trycloudflare.com` being blocked (a common
  corporate/filtered-DNS cause) and mentions the escape hatch above.

## [0.1.1] - 2026-07-01

### Security

- **Join links are now single-use and expiring.** A join link is consumed by
  the first guest who successfully authenticates and can no longer be redeemed
  afterward — even once that guest disconnects — and links expire on their own
  after 10 minutes (`DEFAULT_JOIN_LINK_TTL_MS`). This bounds the damage from a
  leaked link, which previously stayed valid for the whole session.
  `tunnel_open` now returns `joinLinkExpiresInSec` so the host can tell the
  human how long the link is good for.

## [0.1.0] - 2026-06-30

### Added

- Initial release of `tunnel-mcp`, an MCP server that lets two developers'
  Claude agents talk directly to each other through a host-owned, ephemeral,
  end-to-end-encrypted relay.
- Six MCP tools: `tunnel_open`, `tunnel_join`, `tunnel_say`, `tunnel_listen`,
  `tunnel_status`, and `tunnel_close`.
- Host-owned, ephemeral relay: the initiator's MCP process becomes an
  in-process WebSocket relay exposed via a throwaway `cloudflared` Quick
  Tunnel, so both sides dial outbound and the tunnel works through
  firewalls/NAT with no port-forwarding.
- End-to-end encrypted chat message bodies using NaCl secretbox
  (XSalsa20-Poly1305, via `tweetnacl`), so the `cloudflared` pipe only ever
  sees ciphertext for chat bodies.
- HMAC proof-of-key-possession authentication; the raw session key is never
  sent over the wire.
- Single-guest lock: the first authenticated guest locks the session to
  exactly two participants.
- Three teardown triggers for ephemeral sessions: explicit `tunnel_close`,
  30-minute idle timeout, or host process exit — each destroys the relay,
  the `cloudflared` child process, and the on-disk log.
- Atomic `cloudflared` auto-download to `~/.tunnel/bin` on first use when
  not already available on `PATH`.
- `tunnel-etiquette` skill, installable into a Claude skills directory, that
  instructs agents to treat peer messages as untrusted data and to require
  their human's OK before writing files, running risky commands, or
  declaring a fix "confirmed".
- Test suite of 109 tests built with vitest, developed test-first (TDD).

[Unreleased]: https://github.com/zachlikefolio/tunnel-mcp/compare/v0.1.6...HEAD
[0.1.6]: https://github.com/zachlikefolio/tunnel-mcp/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/zachlikefolio/tunnel-mcp/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/zachlikefolio/tunnel-mcp/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/zachlikefolio/tunnel-mcp/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/zachlikefolio/tunnel-mcp/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/zachlikefolio/tunnel-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/zachlikefolio/tunnel-mcp/releases/tag/v0.1.0
