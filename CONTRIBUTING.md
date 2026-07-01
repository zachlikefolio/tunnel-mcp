# Contributing to tunnel-mcp

Thanks for your interest in improving tunnel-mcp — an MCP server that lets two
developers' Claude agents talk directly to each other through a host-owned,
ephemeral, end-to-end-encrypted relay. This guide covers everything you need
to set up the project, run the test suite, and get a change merged.

Before you start, please read [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) and
[SECURITY.md](./SECURITY.md). This is a security-sensitive tool (it relays
messages between two people's AI agents), so please report vulnerabilities
privately per SECURITY.md rather than filing a public issue.

## Prerequisites

- Node.js >= 20
- npm

No other runtime dependencies are required for development. `cloudflared` is
downloaded automatically to `~/.tunnel/bin` the first time a tunnel is opened,
so you don't need it pre-installed to run the unit/integration test suite.

## Setup

```sh
git clone https://github.com/zachlikefolio/tunnel-mcp.git
cd tunnel-mcp
npm ci
npm run build
```

`npm ci` installs exact dependency versions from `package-lock.json`.
`npm run build` compiles TypeScript (`src/`) to `dist/` via `tsc`; this is
also what produces the `tunnel-mcp` binary defined in `package.json`.

## Running tests

```sh
npm test            # vitest run — 109 tests
npm run test:coverage
```

The test suite intentionally runs test **files sequentially, not in
parallel** (see `vitest.config.ts`, `fileParallelism: false`). Several
integration suites — the host relay, the guest client, and the session
live-loop — bind real TCP/WebSocket sockets on localhost. Running them
concurrently oversubscribes ports and CPU, causing flaky timeouts, so please
don't try to "speed up" CI by re-enabling parallelism.

If you add a new integration-style test that binds a real socket, follow the
existing pattern in `tests/hostRelay.test.ts` / `tests/guestClient.test.ts`
(bind to an ephemeral port, always close it in a `finally`/`afterEach`).

## Code standards

- **ESM + TypeScript, `NodeNext` module resolution.** All relative imports
  must include the `.js` extension, even though the source files are `.ts`
  (e.g. `import { openSession } from './session.js';`). This is required by
  `NodeNext` and will fail the build otherwise.
- `npm run lint` (eslint) must pass.
- `npm run format:check` (prettier) must pass; run `npm run format` to
  auto-fix formatting before committing.
- `npx tsc --noEmit` must be clean — no type errors.

Run all four locally before opening a PR:

```sh
npx tsc --noEmit
npm run lint
npm run format:check
npm test
```

## Test-Driven Development

This project is built test-first. All 109 existing tests were written before
their corresponding implementation, and new work should follow the same
red → green rhythm:

1. Write a failing test that describes the behavior you want (a new tool
   argument, an edge case in the protocol, a bugfix reproduction). Run it and
   confirm it fails for the reason you expect — not because of a typo or a
   missing import.
2. Write the minimal implementation change needed to make that test pass.
3. Refactor with the safety net of the passing test, re-running the suite to
   confirm nothing else broke.

PRs that add a feature or fix a bug without an accompanying test (in
`tests/`) will generally be asked to add one before merge. If a bug isn't
straightforward to reproduce in a unit test, explain why in the PR
description so reviewers can weigh in on an alternative verification
strategy.

## Project layout

```
src/
  index.ts        MCP server entry point — registers the six tools and starts stdio transport
  tools.ts         Tool definitions/handlers: tunnel_open, tunnel_join, tunnel_say,
                   tunnel_listen, tunnel_status, tunnel_close
  session.ts       Session/state machine shared by host and guest sides
  config.ts        Runtime configuration (paths under ~/.tunnel, timeouts, etc.)
  protocol/        Wire message shapes, join-link encoding, crypto (NaCl secretbox, HMAC auth)
  relay/           In-process WebSocket relay (host side) and outbound client (guest side)
  log/             On-disk session log (created per-session, destroyed on teardown)
  cloudflared/     Locates/downloads the cloudflared binary and manages the Quick Tunnel child process
tests/             vitest test suites, one file per module above plus integration suites
skill/
  tunnel-etiquette/  Claude skill instructing agents to treat peer messages as untrusted data
docs/              Supplementary docs (e.g. superpowers reference material)
```

## Manual end-to-end testing

Automated tests cover the protocol, crypto, relay, and session logic, but
some things (real cloudflared tunnels, real Claude Code processes, actual
NAT/firewall traversal) can only be verified by running two real Claude Code
instances against each other. To do a manual end-to-end test:

1. Build and link the package locally so `tunnel-mcp` resolves to your
   working tree:
   ```sh
   npm run build
   npm link
   ```
2. In one terminal/machine (the **host**), register the MCP server with
   Claude Code and start a Claude Code session:
   ```sh
   claude mcp add tunnel -- tunnel-mcp
   claude
   ```
   In that session, ask Claude to call `tunnel_open` with a `goal` describing
   what you're working on. This starts the in-process relay and an outbound
   `cloudflared` Quick Tunnel, and returns a join link containing the
   session's key.
3. Share the join link with the guest over a trusted channel (e.g. a Slack
   DM) — the link is effectively a password to the session.
4. On the second machine/terminal (the **guest**), also register the server
   (`claude mcp add tunnel -- tunnel-mcp`) and start Claude Code. Ask Claude
   to call `tunnel_join` with the `joinLink` you received. The guest dials
   out over the tunnel, authenticates via HMAC proof-of-key-possession, and
   locks the session to these two participants.
5. On either side, ask Claude to call `tunnel_say` to send a message and
   `tunnel_listen` to receive the other side's replies; use `tunnel_status`
   to check connection state. Confirm messages round-trip correctly and that
   the etiquette skill (installed from `skill/tunnel-etiquette/` into your
   Claude skills directory) causes each agent to treat the peer's messages as
   untrusted input rather than instructions.
6. Call `tunnel_close` (with an optional `summary`) on either side, or just
   exit the host's Claude Code process, and confirm the relay, the
   `cloudflared` child process, and the on-disk session log are all torn
   down. You can also let the session sit idle for the 30-minute idle
   timeout to confirm automatic teardown, though that's obviously slower to
   verify.

If you're testing a change to the join-link format, the crypto layer, or the
cloudflared provisioning logic, a manual pass like this is strongly
recommended in addition to the automated suite, since those are exactly the
areas the unit tests can't fully exercise against a real network path.

## PR process

- Branch from `main`; use a descriptive branch name.
- Keep PRs focused — one logical change per PR. Large or unrelated changes
  are harder to review and more likely to get stuck.
- Before opening a PR, make sure CI would pass locally:
  - `npm run lint`
  - `npx tsc --noEmit`
  - `npm run build`
  - `npm test`
- Use conventional-commit-style messages for your commits and PR title
  (e.g. `fix: handle idle timeout during guest handshake`,
  `feat: add sinceSeq cursor to tunnel_listen`, `docs: clarify join-link
security model`, `test: cover relay reconnect edge case`).
- Reference and link any related issues in the PR description (e.g.
  `Fixes #12`).
- Be precise about security claims in your PR description. Chat message
  bodies are end-to-end encrypted; the goal, display names, and system
  events are plaintext metadata — don't describe a change as encrypting
  something it doesn't.

Questions? Open a discussion or issue on the repo.
