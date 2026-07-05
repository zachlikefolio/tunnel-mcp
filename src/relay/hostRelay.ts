import { EventEmitter } from 'node:events';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { Key, makeChallenge, verifyChallenge } from '../protocol/crypto.js';
import {
  ControlFrame,
  RosterEntry,
  ParticipantId,
  WireMessage,
  buildSystem,
  decodeFrame,
  encodeFrame,
  newParticipantId,
} from '../protocol/messages.js';
import { SessionLog } from '../log/sessionLog.js';
import {
  DEFAULT_IDLE_TEARDOWN_MS,
  DEFAULT_JOIN_LINK_TTL_MS,
  MAX_ROOM_MEMBERS,
  PROTOCOL_VERSION,
  MIN_PROTOCOL_VERSION,
  ARTIFACT_PROTOCOL_VERSION,
} from '../config.js';
import { InviteLedger } from './inviteLedger.js';

export interface HostRelayOptions {
  tunnelId: string;
  key: Key;
  goal: string;
  hostName: string;
  idleMs?: number;
  joinTtlMs?: number;
}

const INCOMPATIBLE = 'incompatible client — upgrade: npx -y tunnel-mcp@latest';

export class HostRelay extends EventEmitter {
  readonly hostId: ParticipantId = newParticipantId();
  private members = new Map<
    ParticipantId,
    { ws: WebSocket; name: string; protocolVersion: number }
  >();
  private byWs = new WeakMap<WebSocket, ParticipantId>();
  private roster = new Map<ParticipantId, RosterEntry>();
  private ledger: InviteLedger;
  private challenges = new Map<WebSocket, string>();
  private server?: http.Server;
  private wss?: WebSocketServer;
  private idleTimer?: NodeJS.Timeout;

  constructor(
    private opts: HostRelayOptions,
    private log: SessionLog,
  ) {
    super();
    this.ledger = new InviteLedger(opts.joinTtlMs ?? DEFAULT_JOIN_LINK_TTL_MS);
    this.roster.set(this.hostId, {
      id: this.hostId,
      name: opts.hostName,
      isHost: true,
      connected: true,
      protocolVersion: PROTOCOL_VERSION,
    });
  }

  // ---- invites & introspection ------------------------------------------

  mintInvites(count: number): { token: string; expiresAt: number }[] {
    const seats = MAX_ROOM_MEMBERS - 1 - this.members.size - this.ledger.pendingCount();
    if (count < 1 || count > seats) {
      throw new Error(`cannot mint ${count} invite(s): ${seats} seat(s) remaining`);
    }
    return Array.from({ length: count }, () => this.ledger.mint());
  }

  pendingInvites(): number {
    return this.ledger.pendingCount();
  }

  rosterEntries(): RosterEntry[] {
    return [...this.roster.values()];
  }

  connectedMembers(): number {
    let n = 0;
    for (const m of this.members.values()) if (m.ws.readyState === WebSocket.OPEN) n++;
    return n;
  }

  /** True iff at least one member is connected (used by session.status). */
  get peerConnected(): boolean {
    return this.connectedMembers() > 0;
  }

  // ---- lifecycle ----------------------------------------------------------

  start(): Promise<number> {
    return new Promise((resolve) => {
      this.server = http.createServer();
      this.wss = new WebSocketServer({ server: this.server, path: `/t/${this.opts.tunnelId}` });
      // A post-listen server-level error (e.g. ECONNRESET on a flaky tunnel
      // hop) must never crash the relay — log to stderr only, same stance as
      // the per-socket 'error' handler below.
      this.wss.on('error', (err) => console.error('[tunnel] relay server error:', err));
      this.wss.on('connection', (ws) => this.onConnection(ws));
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address();
        this.armIdle();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
  }

  async close(): Promise<void> {
    this.broadcast({ t: 'msg', msg: this.stamp(buildSystem(this.hostId, 'room closed by host')) });
    for (const m of this.members.values()) {
      try {
        m.ws.close();
      } catch {
        /* gone */
      }
    }
    clearTimeout(this.idleTimer);
    await new Promise<void>((resolve) => {
      this.wss?.close(() => {
        this.server?.close(() => resolve());
      });
    });
  }

  // ---- message pipeline ---------------------------------------------------

  /** Assign seq/ts, record, emit locally, and fan out to every connected member. */
  private stamp(msg: WireMessage): WireMessage {
    const seq = this.log.lastSeq + 1;
    const stamped = { ...msg, seq, ts: Date.now() };
    this.log.record(stamped);
    return stamped;
  }

  private submit(msg: WireMessage): WireMessage {
    const stamped = this.stamp(msg);
    this.armIdle();
    this.emit('message', stamped);
    // Fanout INCLUDES the sender: the echoed frame is the sender's delivery
    // ack (MemberClient.say resolves when its own msg id echoes back).
    this.broadcast({ t: 'msg', msg: stamped });
    return stamped;
  }

  submitLocal(msg: WireMessage): WireMessage {
    return this.submit(msg);
  }

  private broadcast(frame: ControlFrame, exceptId?: ParticipantId): void {
    const data = encodeFrame(frame);
    // Artifact offers reach v3+ members only; a v2 member never sees an unknown kind.
    const artifactOffer = frame.t === 'msg' && frame.msg.kind === 'artifact';
    for (const [id, m] of this.members) {
      if (id === exceptId) continue;
      if (m.ws.readyState !== WebSocket.OPEN) continue;
      if (artifactOffer && m.protocolVersion < ARTIFACT_PROTOCOL_VERSION) continue;
      m.ws.send(data);
    }
  }

  private armIdle(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(
      () => this.emit('idle'),
      this.opts.idleMs ?? DEFAULT_IDLE_TEARDOWN_MS,
    );
    this.idleTimer.unref?.();
  }

  // ---- connection handling -------------------------------------------------

  private onConnection(ws: WebSocket): void {
    ws.on('error', () => {
      /* never crash on socket errors */
    });
    const nonce = makeChallenge();
    this.challenges.set(ws, nonce);
    ws.send(encodeFrame({ t: 'challenge', nonce }));

    ws.on('message', (data) => {
      // Malformed or schema-invalid frames must never crash the room.
      try {
        let frame: ControlFrame;
        try {
          frame = decodeFrame(data.toString());
        } catch {
          return;
        }

        if (frame.t === 'auth') {
          this.onAuth(ws, frame);
        } else if (frame.t === 'send') {
          const senderId = this.byWs.get(ws);
          if (!senderId) return; // only authenticated members may send
          const msg = frame.msg;
          if (
            !msg ||
            typeof msg.id !== 'string' ||
            typeof msg.body !== 'string' ||
            msg.kind !== 'chat' // members may only originate chat
          ) {
            return;
          }
          this.submit({ ...msg, from: senderId, seq: -1, ts: 0 });
        }
      } catch {
        /* untrusted-frame guard */
      }
    });

    ws.on('close', () => {
      this.challenges.delete(ws);
      const id = this.byWs.get(ws);
      if (!id) return;
      const entry = this.roster.get(id);
      this.members.delete(id);
      if (entry) entry.connected = false; // roster RETAINS departed members
      this.submit(buildSystem(this.hostId, `${entry?.name ?? 'member'} left`));
      this.broadcast({ t: 'roster', members: this.rosterEntries() });
    });
  }

  private onAuth(ws: WebSocket, frame: Extract<ControlFrame, { t: 'auth' }>): void {
    const deny = (reason: string) => {
      ws.send(encodeFrame({ t: 'auth_fail', reason }));
      ws.close();
    };
    // v1 clients send no token/protocolVersion → incompatible, not malformed.
    if (
      typeof frame.token !== 'string' ||
      typeof frame.protocolVersion !== 'number' ||
      frame.protocolVersion < MIN_PROTOCOL_VERSION
    ) {
      return deny(INCOMPATIBLE);
    }
    if (typeof frame.response !== 'string' || typeof frame.name !== 'string') {
      return deny('malformed auth');
    }
    const challenge = this.challenges.get(ws);
    if (!challenge || !verifyChallenge(challenge, frame.response, this.opts.key)) {
      return deny('bad key');
    }
    if (this.members.size >= MAX_ROOM_MEMBERS - 1) {
      return deny('room at capacity'); // checked BEFORE redeem: a full room never burns a token
    }
    const id = newParticipantId();
    const verdict = this.ledger.redeem(frame.token, id);
    if (verdict === 'expired') return deny('invite expired');
    if (verdict === 'used') return deny('invite already used');
    if (verdict === 'unknown') return deny('invalid invite');

    this.challenges.delete(ws);
    this.members.set(id, { ws, name: frame.name, protocolVersion: frame.protocolVersion });
    this.byWs.set(ws, id);
    this.roster.set(id, {
      id,
      name: frame.name,
      isHost: false,
      connected: true,
      protocolVersion: frame.protocolVersion,
    });

    const sinceSeq = Number.isFinite(frame.sinceSeq) ? frame.sinceSeq : 0;
    ws.send(
      encodeFrame({
        t: 'auth_ok',
        goal: this.opts.goal,
        selfId: id,
        roster: this.rosterEntries(),
        backlog:
          frame.protocolVersion >= ARTIFACT_PROTOCOL_VERSION
            ? this.log.since(sinceSeq)
            : this.log.since(sinceSeq).filter((m) => m.kind !== 'artifact'),
      }),
    );
    this.submit(buildSystem(this.hostId, `${frame.name} joined`));
    this.broadcast({ t: 'roster', members: this.rosterEntries() }, id);
  }
}
