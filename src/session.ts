import { EventEmitter } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { Key, generateKey } from './protocol/crypto.js';
import { generateTunnelId, mintInvite, parseLink } from './protocol/link.js';
import {
  buildChat,
  buildSystem,
  decrypt,
  newId,
  ArtifactOffer,
  PlainMessage,
  ParticipantId,
  RosterEntry,
  WireMessage,
} from './protocol/messages.js';
import { chunkAndSeal, reassembleAndVerify } from './protocol/artifact.js';
import type { ArtifactMeta } from './relay/artifactStore.js';
import { SessionLog } from './log/sessionLog.js';
import { HostRelay } from './relay/hostRelay.js';
import { MemberClient } from './relay/memberClient.js';
import { ensureCloudflared as realEnsure } from './cloudflared/provision.js';
import { startCloudflared as realStart, TunnelHandle } from './cloudflared/tunnelProcess.js';
import {
  DEFAULT_LISTEN_TIMEOUT_MS,
  DEFAULT_IDLE_TEARDOWN_MS,
  DEFAULT_JOIN_LINK_TTL_MS,
  MAX_ROOM_MEMBERS,
  OPEN_RETRY_ATTEMPTS,
  MAX_ARTIFACT_BYTES,
  ARTIFACT_CHUNK_BYTES,
  ARTIFACT_PROTOCOL_VERSION,
} from './config.js';
import { buildInvite } from './invite.js';

export interface SessionDeps {
  ensureCloudflared: () => Promise<string>;
  startCloudflared: (bin: string, port: number) => Promise<TunnelHandle>;
  idleMs?: number;
  joinTtlMs?: number;
}

export type SessionRole = 'host' | 'member';

export interface SessionStatus {
  role: SessionRole;
  goal: string;
  lastSeq: number;
  openedAt: number;
  members: { name: string; isHost: boolean; connected: boolean }[];
  pendingInvites: number;
  artifacts: {
    id: string;
    name: string;
    kind: 'text' | 'binary';
    size: number;
    from: ParticipantId;
    fromName: string;
  }[];
}

export interface MintedInvite {
  joinLink: string;
  expiresInSec: number;
  invite: string;
}

const DEFAULT_DEPS: SessionDeps = {
  ensureCloudflared: realEnsure,
  startCloudflared: (bin, port) => realStart(bin, port),
};

export class TunnelSession {
  private role?: SessionRole;
  private key?: Key;
  private tunnelId?: string;
  private goal = '';
  private openedAt = 0;
  private log?: SessionLog;
  private source?: HostRelay | MemberClient; // both are EventEmitters emitting 'message'
  private relay?: HostRelay;
  private member?: MemberClient;
  private tunnel?: TunnelHandle;
  private publicUrl?: string;

  constructor(private deps: SessionDeps = DEFAULT_DEPS) {}

  get isOpen(): boolean {
    return !!this.role;
  }

  async open(
    goal: string,
    hostName: string,
    opts: { invites?: number } = {},
  ): Promise<{
    tunnelId: string;
    status: string;
    invites: MintedInvite[];
    joinLink?: string;
    invite?: string;
    joinLinkExpiresInSec?: number;
  }> {
    if (this.isOpen) throw new Error('a tunnel is already open in this process');
    const count = opts.invites ?? 1;
    if (!Number.isInteger(count) || count < 1 || count > MAX_ROOM_MEMBERS - 1) {
      throw new Error(`invites must be an integer between 1 and ${MAX_ROOM_MEMBERS - 1}`);
    }
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

    const expiresInSec = Math.round(joinTtlMs / 1000);
    // Mint AFTER cloudflared is up: TTLs are stamped at mint (arm-at-mint preserved).
    const minted = relay.mintInvites(count);
    const invites: MintedInvite[] = minted.map(({ token }) => {
      const link = mintInvite(tunnel!.publicUrl, tunnelId, key, token);
      return {
        joinLink: link,
        expiresInSec,
        invite: buildInvite({ goal, joinLink: link, expiresInSec }),
      };
    });

    this.role = 'host';
    this.key = key;
    this.tunnelId = tunnelId;
    this.goal = goal;
    this.openedAt = Date.now();
    this.log = log;
    this.relay = relay;
    this.source = relay;
    this.tunnel = tunnel;
    this.publicUrl = tunnel.publicUrl;

    // Third teardown trigger: the relay's idle timer asks the session to close.
    relay.once('idle', () => {
      void this.close();
    });

    relay.submitLocal(buildSystem(relay.hostId, `tunnel opened — goal: ${goal}`));
    return {
      tunnelId,
      status: 'waiting_for_members',
      invites,
      ...(invites.length === 1
        ? {
            joinLink: invites[0].joinLink,
            invite: invites[0].invite,
            joinLinkExpiresInSec: expiresInSec,
          }
        : {}),
    };
  }

  invite(count = 1): MintedInvite[] {
    if (this.role !== 'host' || !this.relay || !this.publicUrl) {
      throw new Error('only the host can mint invites');
    }
    const joinTtlMs = this.deps.joinTtlMs ?? DEFAULT_JOIN_LINK_TTL_MS;
    const expiresInSec = Math.round(joinTtlMs / 1000);
    return this.relay.mintInvites(count).map(({ token }) => {
      const link = mintInvite(this.publicUrl!, this.tunnelId!, this.key!, token);
      return {
        joinLink: link,
        expiresInSec,
        invite: buildInvite({ goal: this.goal, joinLink: link, expiresInSec }),
      };
    });
  }

  async join(
    joinLink: string,
    name: string,
  ): Promise<{
    tunnelId: string;
    goal: string;
    self: { id: ParticipantId; name: string };
    members: RosterEntry[];
  }> {
    if (this.isOpen) throw new Error('a tunnel is already open in this process');
    const link = parseLink(joinLink); // throws the v1 upgrade message pre-dial
    const log = new SessionLog(`${link.tunnelId}-member`);
    const member = new MemberClient(link, name, log);
    const res = await member.connect(0);
    this.role = 'member';
    this.key = link.key;
    this.tunnelId = link.tunnelId;
    this.goal = res.goal;
    this.openedAt = Date.now();
    this.log = log;
    this.member = member;
    this.source = member;
    return {
      tunnelId: link.tunnelId,
      goal: res.goal,
      self: { id: res.selfId, name },
      members: res.roster,
    };
  }

  async say(text: string): Promise<{ seq: number }> {
    // Check isOpen (not just log/key, which close() never clears) so a call
    // after close() throws cleanly instead of risking a crash downstream.
    if (!this.isOpen || !this.role || !this.key) throw new Error('no open tunnel');
    if (this.role === 'host') {
      return { seq: this.relay!.submitLocal(buildChat(this.relay!.hostId, text, this.key)).seq };
    }
    return {
      seq: await this.member!.say(buildChat(this.member!.selfId ?? 'member', text, this.key)),
    };
  }

  async share(path: string): Promise<{
    artifactId: string;
    name: string;
    size: number;
    kind: 'text' | 'binary';
    sha256: string;
    offeredTo: number;
    olderMembers: number;
  }> {
    if (!this.isOpen || !this.role || !this.key) throw new Error('no open tunnel');
    const bytes = new Uint8Array(await readFile(path));
    if (bytes.length < 1) throw new Error('cannot share an empty file');
    if (bytes.length > MAX_ARTIFACT_BYTES) {
      throw new Error(`artifact exceeds the ${MAX_ARTIFACT_BYTES}-byte per-file limit`);
    }
    const name = basename(path);
    const { chunks, sha256, chunkCount, kind } = chunkAndSeal(
      bytes,
      this.key,
      ARTIFACT_CHUNK_BYTES,
    );
    const artifactId = newId();
    const meta: ArtifactMeta = { name, kind, size: bytes.length, sha256, chunkCount };
    let sharerId: ParticipantId;
    if (this.role === 'host') {
      this.relay!.ingestArtifact(artifactId, meta, chunks, this.relay!.hostId);
      sharerId = this.relay!.hostId;
    } else {
      await this.member!.share(artifactId, meta, chunks);
      sharerId = this.member!.selfId ?? 'member';
    }
    const { offeredTo, olderMembers } = this.artifactAudience(sharerId);
    return { artifactId, name, size: bytes.length, kind, sha256, offeredTo, olderMembers };
  }

  async receive(
    artifactId: string,
    savePath: string,
  ): Promise<{
    savePath: string;
    name: string;
    kind: 'text' | 'binary';
    size: number;
    sha256: string;
  }> {
    if (!this.isOpen || !this.role || !this.key || !this.log) throw new Error('no open tunnel');
    const offer = this.offerFor(artifactId);
    if (!offer) throw new Error(`no such artifact offered: ${artifactId}`);
    const sealed =
      this.role === 'host'
        ? this.relay!.readArtifact(artifactId)
        : await this.member!.receive(artifactId);
    // Untrusted bytes: verify sha256 of the plaintext BEFORE touching the disk,
    // and write only to the receiver-chosen savePath (never the sender's name).
    const bytes = reassembleAndVerify(sealed, this.key, offer.sha256, offer.size);
    await writeFile(savePath, bytes);
    return { savePath, name: offer.name, kind: offer.kind, size: offer.size, sha256: offer.sha256 };
  }

  private offerFor(artifactId: string): ArtifactOffer | undefined {
    for (const m of this.log?.all() ?? []) {
      if (m.kind !== 'artifact') continue;
      try {
        const o = JSON.parse(m.body) as ArtifactOffer;
        if (o && o.id === artifactId) return o;
      } catch {
        /* skip malformed */
      }
    }
    return undefined;
  }

  private artifactAudience(sharerId: ParticipantId): { offeredTo: number; olderMembers: number } {
    const entries =
      (this.role === 'host' ? this.relay?.rosterEntries() : this.member?.roster()) ?? [];
    let offeredTo = 0;
    let olderMembers = 0;
    for (const e of entries) {
      if (e.id === sharerId) continue;
      if ((e.protocolVersion ?? 0) >= ARTIFACT_PROTOCOL_VERSION) offeredTo++;
      else olderMembers++;
    }
    return { offeredTo, olderMembers };
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
    return {
      messages: batch.map((m) => {
        const pm = decrypt(m, this.key!);
        return { ...pm, fromName: this.nameOf(pm.from) };
      }),
      status: this.status(),
    };
  }

  private nameOf(id: ParticipantId): string {
    const entries = this.role === 'host' ? this.relay?.rosterEntries() : this.member?.roster();
    return entries?.find((e) => e.id === id)?.name ?? 'unknown';
  }

  status(): SessionStatus {
    const entries =
      (this.role === 'host' ? this.relay?.rosterEntries() : this.member?.roster()) ?? [];
    return {
      role: this.role ?? 'host',
      goal: this.goal,
      lastSeq: this.log?.lastSeq ?? 0,
      openedAt: this.openedAt,
      members: entries.map((e) => ({ name: e.name, isHost: e.isHost, connected: e.connected })),
      pendingInvites: this.role === 'host' ? (this.relay?.pendingInvites() ?? 0) : 0,
      artifacts: (this.log?.all() ?? []).flatMap((m) => {
        if (m.kind !== 'artifact') return [];
        try {
          const o = JSON.parse(m.body) as ArtifactOffer;
          return [
            {
              id: o.id,
              name: o.name,
              kind: o.kind,
              size: o.size,
              from: o.from,
              fromName: this.nameOf(o.from),
            },
          ];
        } catch {
          return [];
        }
      }),
    };
  }

  async close(summary?: string): Promise<{ ok: true }> {
    if (this.role === 'host' && this.relay) {
      if (summary) this.relay.submitLocal(buildSystem(this.relay.hostId, `closed — ${summary}`));
      await this.relay.close();
      this.tunnel?.stop();
      this.log?.delete();
    } else if (this.role === 'member' && this.member) {
      this.member.close();
    }
    this.role = undefined;
    this.source = undefined;
    return { ok: true };
  }
}
