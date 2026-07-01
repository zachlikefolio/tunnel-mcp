import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { JoinLink } from '../protocol/link.js';
import { SessionLog } from '../log/sessionLog.js';
import { respondChallenge } from '../protocol/crypto.js';
import {
  WireMessage, ControlFrame, encodeFrame, decodeFrame,
} from '../protocol/messages.js';
import { DEFAULT_LISTEN_TIMEOUT_MS } from '../config.js';

export class GuestClient extends EventEmitter {
  private ws?: WebSocket;
  private pending = new Map<string, { resolve: (seq: number) => void; reject: (e: Error) => void }>();

  constructor(private link: JoinLink, private guestName: string, private log: SessionLog) {
    super();
  }

  connect(sinceSeq = 0): Promise<{ goal: string; peerName: string }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.link.wsUrl);
      this.ws = ws;
      ws.on('message', (data) => {
        let frame: ControlFrame;
        try { frame = decodeFrame(data.toString()); } catch { return; }

        if (frame.t === 'challenge') {
          ws.send(encodeFrame({
            t: 'auth',
            response: respondChallenge(frame.nonce, this.link.key),
            name: this.guestName,
            sinceSeq,
          }));
        } else if (frame.t === 'auth_ok') {
          for (const m of frame.backlog) this.log.record(m);
          resolve({ goal: frame.goal, peerName: frame.peerName });
        } else if (frame.t === 'auth_fail') {
          reject(new Error(`auth failed: ${frame.reason}`));
          ws.close();
        } else if (frame.t === 'msg') {
          this.log.record(frame.msg);
          const waiter = this.pending.get(frame.msg.id);
          if (waiter) { this.pending.delete(frame.msg.id); waiter.resolve(frame.msg.seq); }
          this.emit('message', frame.msg);
        }
      });
      ws.on('close', () => this.failPending(new Error('tunnel disconnected')));
      ws.on('error', (err) => { reject(err); this.failPending(err as Error); });
    });
  }

  // Reject every in-flight say() so a lost echo surfaces as an error, never a hang.
  private failPending(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  say(msg: WireMessage): Promise<number> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new Error('not connected'));
      const timer = setTimeout(() => {
        if (this.pending.delete(msg.id)) reject(new Error('timed out waiting for host ack'));
      }, DEFAULT_LISTEN_TIMEOUT_MS);
      this.pending.set(msg.id, {
        resolve: (seq) => { clearTimeout(timer); resolve(seq); },
        reject: (e) => { clearTimeout(timer); reject(e); },
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
