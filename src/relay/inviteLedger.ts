import { generateToken } from '../protocol/crypto.js';
import type { ParticipantId } from '../protocol/messages.js';

interface InviteRecord {
  expiresAt: number;
  consumedBy?: ParticipantId;
}

/**
 * Per-person single-use invites. Node's single-threaded event loop makes
 * check-then-consume in one synchronous block atomic: two sockets redeeming
 * the same token can never both win.
 */
export class InviteLedger {
  private invites = new Map<string, InviteRecord>();

  constructor(private ttlMs: number) {}

  mint(now: number = Date.now()): { token: string; expiresAt: number } {
    const token = generateToken();
    const expiresAt = now + this.ttlMs;
    this.invites.set(token, { expiresAt });
    return { token, expiresAt };
  }

  redeem(
    token: string,
    by: ParticipantId,
    now: number = Date.now(),
  ): 'ok' | 'expired' | 'used' | 'unknown' {
    const rec = this.invites.get(token);
    if (!rec) return 'unknown';
    if (rec.consumedBy !== undefined) return 'used';
    if (now > rec.expiresAt) return 'expired';
    rec.consumedBy = by;
    return 'ok';
  }

  pendingCount(now: number = Date.now()): number {
    let n = 0;
    for (const rec of this.invites.values()) {
      if (rec.consumedBy === undefined && now <= rec.expiresAt) n++;
    }
    return n;
  }
}
