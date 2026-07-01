import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { JoinLink } from '../protocol/link.js';
import { SessionLog } from '../log/sessionLog.js';
import { respondChallenge } from '../protocol/crypto.js';
import { WireMessage, ControlFrame, encodeFrame, decodeFrame } from '../protocol/messages.js';
import {
  DEFAULT_LISTEN_TIMEOUT_MS,
  GUEST_HANDSHAKE_TIMEOUT_MS,
  GUEST_CONNECT_DEADLINE_MS,
} from '../config.js';
import { makeGuestLookup } from './guestLookup.js';

export interface GuestNetOptions {
  handshakeTimeoutMs?: number;
  connectDeadlineMs?: number;
  lookup?: unknown; // custom dns.lookup; defaults to makeGuestLookup()
}

export class GuestClient extends EventEmitter {
  private ws?: WebSocket;
  private pending = new Map<
    string,
    { resolve: (seq: number) => void; reject: (e: Error) => void }
  >();

  constructor(
    private link: JoinLink,
    private guestName: string,
    private log: SessionLog,
    private netOpts: GuestNetOptions = {},
  ) {
    super();
  }

  connect(sinceSeq = 0): Promise<{ goal: string; peerName: string }> {
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
          /* already gone */
        }
        reject(new Error('timed out establishing tunnel'));
      }, this.netOpts.connectDeadlineMs ?? GUEST_CONNECT_DEADLINE_MS);
      const settleResolve = (v: { goal: string; peerName: string }) => {
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
              name: this.guestName,
              sinceSeq,
            }),
          );
        } else if (frame.t === 'auth_ok') {
          for (const m of frame.backlog) this.log.record(m);
          settleResolve({ goal: frame.goal, peerName: frame.peerName });
        } else if (frame.t === 'auth_fail') {
          settleReject(new Error(`auth failed: ${frame.reason}`));
          ws.close();
        } else if (frame.t === 'msg') {
          this.log.record(frame.msg);
          const waiter = this.pending.get(frame.msg.id);
          if (waiter) {
            this.pending.delete(frame.msg.id);
            waiter.resolve(frame.msg.seq);
          }
          this.emit('message', frame.msg);
        }
      });
      ws.on('close', () => this.failPending(new Error('tunnel disconnected')));
      ws.on('error', (err) => {
        settleReject(err as Error);
        this.failPending(err as Error);
      });
    });
  }

  // Reject every in-flight say() so a lost echo surfaces as an error, never a hang.
  private failPending(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
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

  get connected(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.failPending(new Error('closed'));
    this.ws?.close();
  }
}
