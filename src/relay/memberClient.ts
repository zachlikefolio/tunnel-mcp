import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { JoinLink } from '../protocol/link.js';
import { SessionLog } from '../log/sessionLog.js';
import { respondChallenge } from '../protocol/crypto.js';
import {
  WireMessage,
  ControlFrame,
  RosterEntry,
  ParticipantId,
  encodeFrame,
  decodeFrame,
} from '../protocol/messages.js';
import { ArtifactMeta } from './artifactStore.js';
import {
  DEFAULT_LISTEN_TIMEOUT_MS,
  GUEST_HANDSHAKE_TIMEOUT_MS,
  GUEST_CONNECT_DEADLINE_MS,
  PROTOCOL_VERSION,
  MAX_ARTIFACT_BYTES,
  ARTIFACT_CHUNK_BYTES,
} from '../config.js';
import { makeGuestLookup } from './guestLookup.js';

// A legitimate artifact never has more chunks than the largest allowed upload
// could produce (mirrors ArtifactStore.begin()'s bound on the relay side). The
// host relay is untrusted from the member's point of view, so a `fetch_chunk`
// seq is bounded by this before it ever indexes into the chunks array — closing
// off an absurd seq (e.g. near Number.MAX_SAFE_INTEGER) growing that array
// without bound.
const MAX_FETCH_CHUNK_COUNT = Math.ceil(MAX_ARTIFACT_BYTES / ARTIFACT_CHUNK_BYTES);

export interface GuestNetOptions {
  handshakeTimeoutMs?: number;
  connectDeadlineMs?: number;
  lookup?: unknown; // custom dns.lookup; defaults to makeGuestLookup()
}

export class MemberClient extends EventEmitter {
  private ws?: WebSocket;
  selfId?: ParticipantId;
  private rosterMap = new Map<ParticipantId, RosterEntry>();
  private pending = new Map<
    string,
    { resolve: (seq: number) => void; reject: (e: Error) => void }
  >();
  private shares = new Map<
    string,
    { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private fetches = new Map<
    string,
    {
      chunks: (string | undefined)[];
      receivedCount: number; // count of DISTINCT seqs filled so far (dedup on resend)
      maxSeq: number; // highest seq seen so far; -1 = none yet
      resolve: (chunks: string[]) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  constructor(
    private link: JoinLink,
    private memberName: string,
    private log: SessionLog,
    private netOpts: GuestNetOptions = {},
  ) {
    super();
  }

  roster(): RosterEntry[] {
    return [...this.rosterMap.values()];
  }

  connect(sinceSeq = 0): Promise<{ goal: string; selfId: ParticipantId; roster: RosterEntry[] }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.link.wsUrl, {
        // Resolve system-first, DoH-fallback (bypasses a stale NXDOMAIN negative
        // cache). ws keeps SNI/Host = the hostname, so returning a DoH IP here
        // does not break TLS validation or Cloudflare routing.
        lookup: this.netOpts.lookup ?? makeGuestLookup(),
        handshakeTimeout: this.netOpts.handshakeTimeoutMs ?? GUEST_HANDSHAKE_TIMEOUT_MS,
      } as WebSocket.ClientOptions);
      this.ws = ws;

      // Overall connect+auth deadline: handshakeTimeout only bounds DNS+TCP+TLS+
      // upgrade; the post-open challenge/auth round-trip is otherwise unbounded.
      let settled = false;
      const deadline = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.terminate();
        } catch {
          /* gone */
        }
        reject(new Error('timed out establishing tunnel'));
      }, this.netOpts.connectDeadlineMs ?? GUEST_CONNECT_DEADLINE_MS);
      const settleResolve = (v: { goal: string; selfId: ParticipantId; roster: RosterEntry[] }) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolve(v);
      };
      const settleReject = (e: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        reject(e);
      };

      ws.on('message', (data) => {
        // The host is untrusted: malformed frames must never crash a member.
        try {
          let frame: ControlFrame;
          try {
            frame = decodeFrame(data.toString());
          } catch {
            return;
          }

          if (frame.t === 'challenge') {
            ws.send(
              encodeFrame({
                t: 'auth',
                response: respondChallenge(frame.nonce, this.link.key),
                name: this.memberName,
                sinceSeq,
                token: this.link.token,
                protocolVersion: PROTOCOL_VERSION,
              }),
            );
          } else if (frame.t === 'auth_ok') {
            this.selfId = frame.selfId;
            this.rosterMap = new Map(frame.roster.map((r) => [r.id, r]));
            for (const m of frame.backlog) this.log.record(m);
            settleResolve({ goal: frame.goal, selfId: frame.selfId, roster: frame.roster });
          } else if (frame.t === 'auth_fail') {
            settleReject(new Error(`auth failed: ${frame.reason}`));
            ws.close();
          } else if (frame.t === 'roster') {
            this.rosterMap = new Map(frame.members.map((r) => [r.id, r]));
            this.emit('roster', frame.members);
          } else if (frame.t === 'msg') {
            this.log.record(frame.msg);
            const waiter = this.pending.get(frame.msg.id);
            if (waiter) {
              this.pending.delete(frame.msg.id);
              waiter.resolve(frame.msg.seq);
            }
            // A share() resolves when its own offer echoes back through the sequencer.
            if (frame.msg.kind === 'artifact') {
              try {
                const offer = JSON.parse(frame.msg.body) as { id?: string };
                if (offer && typeof offer.id === 'string') {
                  const s = this.shares.get(offer.id);
                  if (s) {
                    clearTimeout(s.timer);
                    this.shares.delete(offer.id);
                    s.resolve();
                  }
                }
              } catch {
                /* malformed offer body — ignore */
              }
            }
            this.emit('message', frame.msg);
          } else if (frame.t === 'error') {
            const aid = typeof frame.artifactId === 'string' ? frame.artifactId : undefined;
            const msg = typeof frame.message === 'string' ? frame.message : 'artifact error';
            const code = typeof frame.code === 'string' ? frame.code : undefined;
            if (aid) {
              const s = this.shares.get(aid);
              if (s) {
                clearTimeout(s.timer);
                this.shares.delete(aid);
                s.reject(Object.assign(new Error(msg), { code }));
              }
              const f = this.fetches.get(aid);
              if (f) {
                clearTimeout(f.timer);
                this.fetches.delete(aid);
                f.reject(Object.assign(new Error(msg), { code }));
              }
            }
          } else if (frame.t === 'fetch_chunk') {
            if (typeof frame.artifactId !== 'string') return;
            const f = this.fetches.get(frame.artifactId);
            if (!f) return;
            if (
              typeof frame.seq === 'number' &&
              Number.isInteger(frame.seq) &&
              frame.seq >= 0 &&
              frame.seq < MAX_FETCH_CHUNK_COUNT &&
              typeof frame.data === 'string'
            ) {
              if (f.chunks[frame.seq] === undefined) f.receivedCount++;
              f.chunks[frame.seq] = frame.data;
              if (frame.seq > f.maxSeq) f.maxSeq = frame.seq;
            }
            if (frame.last === true) {
              clearTimeout(f.timer);
              this.fetches.delete(frame.artifactId);
              // The offer doesn't carry chunkCount, so the expected total isn't
              // known up front; a legitimate stream's `last` frame always carries
              // the highest seq (0..n-1, last on n-1), so maxSeq + 1 IS that total.
              // Checking the distinct-seq COUNT against it, then walking 0..maxSeq
              // with an explicit loop (never `.some` on the sparse array, which
              // silently skips holes), catches a relay that drops a middle chunk
              // yet still sends `last:true` — the old check let that through and
              // crashed reassembleAndVerify with a raw TypeError instead of this
              // clean rejection.
              let complete = f.maxSeq >= 0 && f.receivedCount === f.maxSeq + 1;
              if (complete) {
                for (let i = 0; i <= f.maxSeq; i++) {
                  if (f.chunks[i] === undefined) {
                    complete = false;
                    break;
                  }
                }
              }
              if (!complete) {
                f.reject(new Error('incomplete artifact transfer'));
              } else {
                f.resolve(f.chunks.slice(0, f.maxSeq + 1) as string[]);
              }
            }
          }
        } catch {
          /* untrusted-frame guard */
        }
      });
      ws.on('close', () => this.failPending(new Error('tunnel disconnected')));
      ws.on('error', (err) => {
        settleReject(err as Error);
        this.failPending(err as Error);
      });
    });
  }

  // Reject every in-flight say()/share()/fetch() so a lost echo surfaces as an
  // error, never a hang.
  private failPending(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
    for (const [, s] of this.shares) {
      clearTimeout(s.timer);
      s.reject(err);
    }
    this.shares.clear();
    for (const [, f] of this.fetches) {
      clearTimeout(f.timer);
      f.reject(err);
    }
    this.fetches.clear();
  }

  say(msg: WireMessage): Promise<number> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN)
        return reject(new Error('not connected'));
      const timer = setTimeout(() => {
        if (this.pending.delete(msg.id)) reject(new Error('timed out waiting for host ack'));
      }, DEFAULT_LISTEN_TIMEOUT_MS);
      this.pending.set(msg.id, {
        resolve: (seq) => {
          clearTimeout(timer);
          resolve(seq);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(encodeFrame({ t: 'send', msg }));
    });
  }

  share(artifactId: string, meta: ArtifactMeta, chunks: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN)
        return reject(new Error('not connected'));
      const timer = setTimeout(() => {
        if (this.shares.delete(artifactId))
          reject(new Error('timed out waiting for the share to be accepted'));
      }, DEFAULT_LISTEN_TIMEOUT_MS);
      this.shares.set(artifactId, { resolve, reject, timer });
      this.ws.send(
        encodeFrame({
          t: 'share_begin',
          artifactId,
          name: meta.name,
          kind: meta.kind,
          size: meta.size,
          sha256: meta.sha256,
          chunkCount: meta.chunkCount,
        }),
      );
      for (let seq = 0; seq < chunks.length; seq++) {
        this.ws.send(encodeFrame({ t: 'share_chunk', artifactId, seq, data: chunks[seq] }));
      }
      this.ws.send(encodeFrame({ t: 'share_end', artifactId }));
    });
  }

  receive(artifactId: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN)
        return reject(new Error('not connected'));
      const timer = setTimeout(() => {
        if (this.fetches.delete(artifactId)) reject(new Error('timed out fetching artifact'));
      }, DEFAULT_LISTEN_TIMEOUT_MS);
      this.fetches.set(artifactId, {
        chunks: [],
        receivedCount: 0,
        maxSeq: -1,
        resolve,
        reject,
        timer,
      });
      this.ws.send(encodeFrame({ t: 'fetch', artifactId }));
    });
  }

  get connected(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.failPending(new Error('closed'));
    this.ws?.close();
  }
}
