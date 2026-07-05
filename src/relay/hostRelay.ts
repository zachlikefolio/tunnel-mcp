import { EventEmitter } from 'node:events';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { Key, makeChallenge, verifyChallenge } from '../protocol/crypto.js';
import {
  ControlFrame,
  RosterEntry,
  ParticipantId,
  WireMessage,
  ArtifactOffer,
  buildSystem,
  buildArtifactMessage,
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
  MAX_ARTIFACT_BYTES,
  MAX_MEMBER_ARTIFACT_BYTES,
  MAX_ROOM_ARTIFACT_BYTES,
  ARTIFACT_TTL_MS,
} from '../config.js';
import { InviteLedger } from './inviteLedger.js';
import { ArtifactStore, ArtifactMeta } from './artifactStore.js';

export interface HostRelayOptions {
  tunnelId: string;
  key: Key;
  goal: string;
  hostName: string;
  idleMs?: number;
  joinTtlMs?: number;
  artifactTtlMs?: number;
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
  private store: ArtifactStore;

  constructor(
    private opts: HostRelayOptions,
    private log: SessionLog,
  ) {
    super();
    this.ledger = new InviteLedger(opts.joinTtlMs ?? DEFAULT_JOIN_LINK_TTL_MS);
    this.store = new ArtifactStore({
      maxArtifactBytes: MAX_ARTIFACT_BYTES,
      maxMemberBytes: MAX_MEMBER_ARTIFACT_BYTES,
      maxRoomBytes: MAX_ROOM_ARTIFACT_BYTES,
      ttlMs: opts.artifactTtlMs ?? ARTIFACT_TTL_MS,
    });
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

  // ---- artifact sharing ---------------------------------------------------

  private sendError(ws: WebSocket, code: string, message: string, artifactId?: string): void {
    ws.send(encodeFrame({ t: 'error', code, message, ...(artifactId ? { artifactId } : {}) }));
  }

  // Store-internal codes that fall outside the wire `error` enum
  // ('too_large' | 'member_full' | 'room_full' | 'duplicate' | 'not_found' |
  // 'unknown' | 'bad_seq' | 'incomplete') are mapped so the wire code is always
  // a member of that enum. `bad_meta` (invalid declared size/chunkCount) has no
  // dedicated wire code, so it surfaces as the generic 'unknown'; `duplicate_chunk`
  // maps to 'duplicate'.
  private toWireCode(code: string): string {
    if (code === 'bad_meta') return 'unknown';
    if (code === 'duplicate_chunk') return 'duplicate';
    return code;
  }

  private capMessage(code: string): string {
    switch (code) {
      case 'too_large':
        return `artifact exceeds the ${MAX_ARTIFACT_BYTES}-byte per-file limit`;
      case 'member_full':
        return `too many bytes buffered for you (limit ${MAX_MEMBER_ARTIFACT_BYTES})`;
      case 'room_full':
        return `the room's artifact buffer is full (limit ${MAX_ROOM_ARTIFACT_BYTES})`;
      case 'duplicate':
        return 'an artifact with that id is already uploading';
      default:
        return 'artifact rejected';
    }
  }

  private handleShareBegin(
    ws: WebSocket,
    by: ParticipantId,
    frame: Extract<ControlFrame, { t: 'share_begin' }>,
  ): void {
    this.store.evictExpired();
    if (
      typeof frame.artifactId !== 'string' ||
      typeof frame.name !== 'string' ||
      (frame.kind !== 'text' && frame.kind !== 'binary') ||
      typeof frame.size !== 'number' ||
      typeof frame.sha256 !== 'string' ||
      typeof frame.chunkCount !== 'number'
    ) {
      return; // malformed — decodeFrame only guaranteed a string `t`
    }
    const meta: ArtifactMeta = {
      name: frame.name,
      kind: frame.kind,
      size: frame.size,
      sha256: frame.sha256,
      chunkCount: frame.chunkCount,
    };
    const res = this.store.begin(frame.artifactId, meta, by);
    if (res !== 'ok') {
      const wire = this.toWireCode(res);
      this.sendError(ws, wire, this.capMessage(wire), frame.artifactId);
    }
  }

  private handleShareChunk(
    ws: WebSocket,
    frame: Extract<ControlFrame, { t: 'share_chunk' }>,
  ): void {
    if (
      typeof frame.artifactId !== 'string' ||
      typeof frame.seq !== 'number' ||
      typeof frame.data !== 'string'
    ) {
      return;
    }
    const res = this.store.putChunk(frame.artifactId, frame.seq, frame.data);
    // 'unknown'/'bad_seq' are reported so a client learns it targeted the wrong
    // upload; cap failures (too_large/member_full/room_full/duplicate_chunk) drop
    // the chunk silently — the missing chunk then surfaces as 'incomplete' at
    // share_end, which is reported there.
    if (res === 'unknown' || res === 'bad_seq') {
      this.sendError(
        ws,
        res,
        res === 'unknown' ? 'no such artifact upload' : 'chunk seq out of range',
        frame.artifactId,
      );
    }
  }

  private handleShareEnd(
    ws: WebSocket,
    by: ParticipantId,
    frame: Extract<ControlFrame, { t: 'share_end' }>,
  ): void {
    if (typeof frame.artifactId !== 'string') return;
    const res = this.store.end(frame.artifactId);
    if (res !== 'ok') {
      this.store.evict(frame.artifactId); // a lying/incomplete upload never lingers
      this.sendError(
        ws,
        res,
        res === 'unknown' ? 'no such artifact upload' : 'artifact upload incomplete',
        frame.artifactId,
      );
      return;
    }
    // Offer ONLY after end() === 'ok': the store never gates get()/chunkOf() on
    // completeness, so broadcasting before end() would advertise a partial upload.
    const stored = this.store.get(frame.artifactId)!;
    const offer: ArtifactOffer = {
      id: frame.artifactId,
      name: stored.meta.name,
      kind: stored.meta.kind,
      size: stored.meta.size,
      sha256: stored.meta.sha256,
      from: by,
    };
    this.submit(buildArtifactMessage(by, offer));
  }

  /** Host-as-participant share: buffer already-sealed chunks, then offer via the sequencer. */
  ingestArtifact(
    artifactId: string,
    meta: ArtifactMeta,
    sealedChunks: string[],
    by: ParticipantId = this.hostId,
  ): ArtifactOffer {
    this.store.evictExpired();
    const res = this.store.begin(artifactId, meta, by);
    if (res !== 'ok') throw new Error(this.capMessage(this.toWireCode(res)));
    for (let seq = 0; seq < sealedChunks.length; seq++) {
      this.store.putChunk(artifactId, seq, sealedChunks[seq]);
    }
    if (this.store.end(artifactId) !== 'ok') {
      this.store.evict(artifactId);
      throw new Error('artifact upload incomplete');
    }
    const offer: ArtifactOffer = {
      id: artifactId,
      name: meta.name,
      kind: meta.kind,
      size: meta.size,
      sha256: meta.sha256,
      from: by,
    };
    this.submit(buildArtifactMessage(by, offer));
    return offer;
  }

  // ---- artifact fetching --------------------------------------------------

  private handleFetch(ws: WebSocket, frame: Extract<ControlFrame, { t: 'fetch' }>): void {
    if (typeof frame.artifactId !== 'string') return;
    this.store.evictExpired();
    const stored = this.store.get(frame.artifactId);
    if (!stored || !stored.complete) {
      this.sendError(ws, 'not_found', 'artifact expired or not found', frame.artifactId);
      return;
    }
    const n = stored.meta.chunkCount;
    for (let seq = 0; seq < n; seq++) {
      const data = this.store.chunkOf(frame.artifactId, seq) ?? '';
      ws.send(
        encodeFrame({
          t: 'fetch_chunk',
          artifactId: frame.artifactId,
          seq,
          data,
          last: seq === n - 1,
        }),
      );
    }
  }

  /** Host-as-receiver: read the ordered sealed chunks straight from the store. */
  readArtifact(artifactId: string): string[] {
    this.store.evictExpired();
    const stored = this.store.get(artifactId);
    if (!stored || !stored.complete) throw new Error('artifact expired or not found');
    const out: string[] = [];
    for (let seq = 0; seq < stored.meta.chunkCount; seq++) {
      const c = this.store.chunkOf(artifactId, seq);
      if (c === undefined) throw new Error('artifact upload incomplete');
      out.push(c);
    }
    return out;
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
        } else if (frame.t === 'share_begin') {
          const by = this.byWs.get(ws);
          if (by) this.handleShareBegin(ws, by, frame);
        } else if (frame.t === 'share_chunk') {
          if (this.byWs.get(ws)) this.handleShareChunk(ws, frame);
        } else if (frame.t === 'share_end') {
          const by = this.byWs.get(ws);
          if (by) this.handleShareEnd(ws, by, frame);
        } else if (frame.t === 'fetch') {
          if (this.byWs.get(ws)) this.handleFetch(ws, frame);
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
