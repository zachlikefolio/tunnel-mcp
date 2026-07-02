import { EventEmitter } from 'node:events';
import { Key, generateKey } from './protocol/crypto.js';
import { generateTunnelId, mintLink, parseLink } from './protocol/link.js';
import {
  buildChat,
  buildSystem,
  decrypt,
  PlainMessage,
  Role,
  WireMessage,
} from './protocol/messages.js';
import { SessionLog } from './log/sessionLog.js';
import { HostRelay } from './relay/hostRelay.js';
import { GuestClient } from './relay/guestClient.js';
import { ensureCloudflared as realEnsure } from './cloudflared/provision.js';
import { startCloudflared as realStart, TunnelHandle } from './cloudflared/tunnelProcess.js';
import {
  DEFAULT_LISTEN_TIMEOUT_MS,
  DEFAULT_IDLE_TEARDOWN_MS,
  DEFAULT_JOIN_LINK_TTL_MS,
  OPEN_RETRY_ATTEMPTS,
} from './config.js';
import { buildInvite } from './invite.js';

export interface SessionDeps {
  ensureCloudflared: () => Promise<string>;
  startCloudflared: (bin: string, port: number) => Promise<TunnelHandle>;
  idleMs?: number;
  joinTtlMs?: number;
}

export interface SessionStatus {
  role: Role;
  peerConnected: boolean;
  goal: string;
  lastSeq: number;
  openedAt: number;
}

const DEFAULT_DEPS: SessionDeps = {
  ensureCloudflared: realEnsure,
  startCloudflared: (bin, port) => realStart(bin, port),
};

export class TunnelSession {
  private role?: Role;
  private key?: Key;
  private tunnelId?: string;
  private goal = '';
  private openedAt = 0;
  private log?: SessionLog;
  private source?: HostRelay | GuestClient; // both are EventEmitters emitting 'message'
  private relay?: HostRelay;
  private guest?: GuestClient;
  private tunnel?: TunnelHandle;

  constructor(private deps: SessionDeps = DEFAULT_DEPS) {}

  get isOpen(): boolean {
    return !!this.role;
  }

  async open(
    goal: string,
    hostName: string,
  ): Promise<{
    tunnelId: string;
    joinLink: string;
    status: string;
    joinLinkExpiresInSec: number;
    invite: string;
  }> {
    if (this.isOpen) throw new Error('a tunnel is already open in this process');
    const key = generateKey();
    const tunnelId = generateTunnelId();
    const idleMs = this.deps.idleMs ?? DEFAULT_IDLE_TEARDOWN_MS;
    const joinTtlMs = this.deps.joinTtlMs ?? DEFAULT_JOIN_LINK_TTL_MS;
    const log = new SessionLog(tunnelId);
    const relay = new HostRelay({ tunnelId, key, goal, hostName, idleMs, joinTtlMs }, log);
    const port = await relay.start();

    // Bounded retry: cloudflared may crash or never yield a URL; re-spawn before giving up.
    let tunnel: TunnelHandle | undefined;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= OPEN_RETRY_ATTEMPTS; attempt++) {
      try {
        const bin = await this.deps.ensureCloudflared();
        tunnel = await this.deps.startCloudflared(bin, port);
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!tunnel) {
      await relay.close(); // no half-open state on failure
      log.delete();
      throw new Error(
        `could not establish a cloudflared tunnel after ${OPEN_RETRY_ATTEMPTS} attempts: ${String(lastErr)}`,
      );
    }

    // Start the single-use link's expiry window now that the link exists —
    // measured from mint time, not from relay construction (which happened
    // before cloudflared provisioning could burn part of the window).
    relay.armJoinDeadline();
    const joinLink = mintLink(tunnel.publicUrl, tunnelId, key);
    this.role = 'host';
    this.key = key;
    this.tunnelId = tunnelId;
    this.goal = goal;
    this.openedAt = Date.now();
    this.log = log;
    this.relay = relay;
    this.source = relay;
    this.tunnel = tunnel;

    // Third teardown trigger: the relay's idle timer asks the session to close.
    relay.once('idle', () => {
      void this.close();
    });

    relay.submitLocal(buildSystem('host', `tunnel opened — goal: ${goal}`));
    const joinLinkExpiresInSec = Math.round(joinTtlMs / 1000);
    return {
      tunnelId,
      joinLink,
      status: 'waiting_for_guest',
      joinLinkExpiresInSec,
      invite: buildInvite({ goal, joinLink, expiresInSec: joinLinkExpiresInSec }),
    };
  }

  async join(
    joinLink: string,
    guestName: string,
  ): Promise<{ tunnelId: string; goal: string; peer: string }> {
    if (this.isOpen) throw new Error('a tunnel is already open in this process');
    const link = parseLink(joinLink);
    const log = new SessionLog(`${link.tunnelId}-guest`);
    const guest = new GuestClient(link, guestName, log);
    const res = await guest.connect(0);

    this.role = 'guest';
    this.key = link.key;
    this.tunnelId = link.tunnelId;
    this.goal = res.goal;
    this.openedAt = Date.now();
    this.log = log;
    this.guest = guest;
    this.source = guest;
    return { tunnelId: link.tunnelId, goal: res.goal, peer: res.peerName };
  }

  async say(text: string): Promise<{ seq: number }> {
    // Check isOpen (not just log/key, which close() never clears) so a call
    // after close() throws cleanly instead of risking a crash downstream.
    if (!this.isOpen || !this.role || !this.key) throw new Error('no open tunnel');
    const msg = buildChat(this.role, text, this.key);
    if (this.role === 'host') return { seq: this.relay!.submitLocal(msg).seq };
    return { seq: await this.guest!.say(msg) };
  }

  async listen(
    sinceSeq: number,
    timeoutMs = DEFAULT_LISTEN_TIMEOUT_MS,
  ): Promise<{ messages: PlainMessage[]; status: SessionStatus }> {
    // close() clears role/source but leaves log/key set, so this must check
    // isOpen/source (not log/key) or a post-close call falls through to
    // `(this.source as EventEmitter).on(...)` with source === undefined.
    if (!this.isOpen || !this.source || !this.log || !this.key) throw new Error('no open tunnel');
    const ready = () => this.log!.since(sinceSeq);
    let batch = ready();
    if (batch.length === 0) {
      batch = await new Promise<WireMessage[]>((resolve) => {
        const onMsg = () => {
          const b = ready();
          if (b.length) {
            cleanup();
            resolve(b);
          }
        };
        const timer = setTimeout(() => {
          cleanup();
          resolve([]);
        }, timeoutMs);
        const cleanup = () => {
          clearTimeout(timer);
          (this.source as EventEmitter).off('message', onMsg);
        };
        (this.source as EventEmitter).on('message', onMsg);
      });
    }
    return { messages: batch.map((m) => decrypt(m, this.key!)), status: this.status() };
  }

  status(): SessionStatus {
    const peerConnected =
      this.role === 'host' ? !!this.relay?.peerConnected : !!this.guest?.connected;
    return {
      role: this.role ?? 'host',
      peerConnected,
      goal: this.goal,
      lastSeq: this.log?.lastSeq ?? 0,
      openedAt: this.openedAt,
    };
  }

  async close(summary?: string): Promise<{ ok: true }> {
    if (this.role === 'host' && this.relay) {
      if (summary) this.relay.submitLocal(buildSystem('host', `closed — ${summary}`));
      await this.relay.close();
      this.tunnel?.stop();
      this.log?.delete();
    } else if (this.role === 'guest' && this.guest) {
      this.guest.close();
    }
    this.role = undefined;
    this.source = undefined;
    return { ok: true };
  }
}
