# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Nothing yet.

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

[Unreleased]: https://github.com/zachlikefolio/tunnel-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/zachlikefolio/tunnel-mcp/releases/tag/v0.1.0
