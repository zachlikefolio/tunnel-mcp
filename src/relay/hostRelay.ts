import http from 'node:http';
import { EventEmitter } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';
import { Key, makeChallenge, verifyChallenge } from '../protocol/crypto.js';
import { SessionLog } from '../log/sessionLog.js';
import {
  WireMessage,
  ControlFrame,
  encodeFrame,
  decodeFrame,
  buildSystem,
} from '../protocol/messages.js';
import { DEFAULT_IDLE_TEARDOWN_MS, DEFAULT_JOIN_LINK_TTL_MS } from '../config.js';

export interface HostRelayOptions {
  tunnelId: string;
  key: Key;
  goal: string;
  hostName: string;
  idleMs?: number;
  joinTtlMs?: number;
}

export class HostRelay extends EventEmitter {
  private server: http.Server;
  private wss: WebSocketServer;
  private guest?: WebSocket;
  private guestName?: string;
  private challenges = new WeakMap<WebSocket, string>();
  private idleTimer?: NodeJS.Timeout;
  private tearingDown = false;
  // Single-use, expiring join link: the link is valid until `joinDeadline`, and
  // is consumed by the first successful authentication so it can never be reused
  // (even after that guest disconnects).
  private consumed = false;
  private joinDeadline: number;

  constructor(
    private opts: HostRelayOptions,
    private log: SessionLog,
  ) {
    super();
    this.joinDeadline = Date.now() + (opts.joinTtlMs ?? DEFAULT_JOIN_LINK_TTL_MS);
    this.server = http.createServer();
    this.wss = new WebSocketServer({ server: this.server, path: `/t/${opts.tunnelId}` });
    this.wss.on('connection', (ws) => this.onConnection(ws));
    // A routine socket-level error (e.g. ECONNRESET on a flaky tunnel hop)
    // must never crash the host process.
    this.wss.on('error', (err) => {
      console.error('[tunnel] relay server error:', err);
    });
  }

  start(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        this.resetIdle();
        const addr = this.server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
  }

  get peerConnected(): boolean {
    return !!this.guest && this.guest.readyState === WebSocket.OPEN;
  }

  // (Re)start the single-use join link's expiry window. The session calls this
  // once the link is actually minted (after cloudflared provisioning), so the
  // window is measured from when the host receives the link to share — not from
  // relay construction, which happens before provisioning could burn time.
  armJoinDeadline(ttlMs?: number): void {
    this.joinDeadline = Date.now() + (ttlMs ?? this.opts.joinTtlMs ?? DEFAULT_JOIN_LINK_TTL_MS);
  }

  submitLocal(msg: WireMessage): WireMessage {
    return this.submit(msg);
  }

  // Third teardown trigger: no activity within idleMs → warn, then emit 'idle'.
  private resetIdle(): void {
    if (this.tearingDown) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.tearingDown = true; // stop further reschedules from the warning's submit()
      this.submit(buildSystem('host', 'idle timeout — closing tunnel'));
      this.emit('idle');
    }, this.opts.idleMs ?? DEFAULT_IDLE_TEARDOWN_MS);
  }

  private submit(msg: WireMessage): WireMessage {
    this.resetIdle();
    const finalized = this.log.append(msg);
    this.broadcast({ t: 'msg', msg: finalized });
    this.emit('message', finalized);
    return finalized;
  }

  private broadcast(frame: ControlFrame): void {
    if (this.guest && this.guest.readyState === WebSocket.OPEN) {
      this.guest.send(encodeFrame(frame));
    }
  }

  private onConnection(ws: WebSocket): void {
    const nonce = makeChallenge();
    this.challenges.set(ws, nonce);
    ws.send(encodeFrame({ t: 'challenge', nonce }));

    ws.on('message', (data) => {
      // A malformed or schema-invalid frame must never crash the process.
      // decodeFrame is a blind `as ControlFrame` cast (no runtime
      // validation), so anything downstream that assumes a field's shape
      // must be defensively checked here, inside the try/catch.
      try {
        let frame: ControlFrame;
        try {
          frame = decodeFrame(data.toString());
        } catch {
          return;
        }

        if (frame.t === 'auth') {
          if (typeof frame.response !== 'string' || typeof frame.name !== 'string') {
            ws.send(encodeFrame({ t: 'auth_fail', reason: 'malformed auth' }));
            ws.close();
            return;
          }
          const challenge = this.challenges.get(ws);
          if (!challenge || !verifyChallenge(challenge, frame.response, this.opts.key)) {
            ws.send(encodeFrame({ t: 'auth_fail', reason: 'bad key' }));
            ws.close();
            return;
          }
          if (Date.now() > this.joinDeadline) {
            ws.send(encodeFrame({ t: 'auth_fail', reason: 'join link expired' }));
            ws.close();
            return;
          }
          if (this.consumed) {
            // The single-use link was already redeemed. Distinguish the case
            // where the original guest is still connected ('tunnel full') from a
            // reuse attempt after they left ('join link already used').
            const connected = !!this.guest && this.guest.readyState === WebSocket.OPEN;
            ws.send(
              encodeFrame({
                t: 'auth_fail',
                reason: connected ? 'tunnel full' : 'join link already used',
              }),
            );
            ws.close();
            return;
          }
          this.consumed = true;
          this.guest = ws;
          this.guestName = frame.name;
          const sinceSeq = Number.isFinite(frame.sinceSeq) ? frame.sinceSeq : 0;
          ws.send(
            encodeFrame({
              t: 'auth_ok',
              goal: this.opts.goal,
              peerName: this.opts.hostName,
              backlog: this.log.since(sinceSeq),
            }),
          );
          this.submit(buildSystem('host', `${frame.name} joined`));
        } else if (frame.t === 'send') {
          if (ws !== this.guest) return; // only the authenticated guest may send
          const msg = frame.msg;
          if (
            !msg ||
            typeof msg !== 'object' ||
            typeof msg.id !== 'string' ||
            typeof msg.body !== 'string' ||
            msg.kind !== 'chat' // a guest may only originate chat; system/presence are host-only events
          ) {
            return; // ignore malformed or forged send frames
          }
          this.submit({ ...msg, from: 'guest', seq: -1, ts: 0 });
        }
      } catch (err) {
        // Never let a bad frame (or a downstream throw) crash the host
        // process. stderr only — stdout is the MCP stdio channel.
        console.error('[tunnel] relay frame error:', err);
        return;
      }
    });

    ws.on('close', () => {
      if (ws === this.guest) {
        this.guest = undefined;
        // During teardown, close() has already terminated this socket and
        // may have already deleted the session log; don't emit a "left"
        // event (and don't let this late callback resurrect the log file —
        // SessionLog.append() is itself a no-op once closed, belt-and-suspenders).
        if (!this.tearingDown)
          this.submit(buildSystem('host', `${this.guestName ?? 'guest'} left`));
      }
    });

    // A routine socket-level error must never crash the process.
    ws.on('error', (err) => {
      console.error('[tunnel] relay connection error:', err);
    });
  }

  close(): Promise<void> {
    this.tearingDown = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    return new Promise((resolve) => {
      for (const c of this.wss.clients) c.terminate();
      this.wss.close(() => this.server.close(() => resolve()));
    });
  }
}
