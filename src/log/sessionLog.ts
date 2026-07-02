import { WireMessage } from '../protocol/messages.js';

/**
 * In-memory-only transcript for a single tunnel session. There is no
 * disk-writing path here — the security docs promise the transcript never
 * touches disk, and that is structural: no file handle, no fs import, no
 * append(). See the 0.2.0 final-review wave for the removal of the old
 * fs.appendFileSync-backed append() method.
 */
export class SessionLog {
  private msgs: WireMessage[] = [];
  private seqCounter = 0;
  // Set once delete() has run. After that point record() must be a no-op
  // with respect to the in-memory store — otherwise a late event (e.g. a
  // guest socket's 'close' handler firing after teardown) can resurrect
  // state moments after delete() cleared it.
  private closed = false;

  constructor(_tunnelId: string) {}

  record(finalized: WireMessage): void {
    if (this.closed) return;
    // seq comes from an untrusted host over the wire; a non-finite value
    // must not poison the member-side lastSeq cursor. Keep the message in
    // the transcript, just don't let it advance the cursor.
    this.msgs.push(finalized);
    if (Number.isFinite(finalized.seq)) {
      this.seqCounter = Math.max(this.seqCounter, finalized.seq);
    }
  }

  since(sinceSeq: number): WireMessage[] {
    return this.msgs.filter((m) => m.seq > sinceSeq);
  }

  all(): WireMessage[] {
    return [...this.msgs];
  }

  get lastSeq(): number {
    return this.seqCounter;
  }

  /** Clears in-memory state. Safe no-op if already cleared. */
  delete(): void {
    this.msgs = [];
    this.closed = true;
  }
}
