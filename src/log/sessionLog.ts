import fs from 'node:fs';
import path from 'node:path';
import { SESSIONS_DIR } from '../config.js';
import { WireMessage } from '../protocol/messages.js';

export class SessionLog {
  private msgs: WireMessage[] = [];
  private seqCounter = 0;
  private filePath: string;
  // Set once delete() has run. After that point append()/record() must be
  // no-ops with respect to the file and in-memory store — otherwise a late
  // event (e.g. a guest socket's 'close' handler firing after teardown) can
  // resurrect the .jsonl file moments after delete() removed it, leaving an
  // orphaned log on disk forever.
  private closed = false;

  constructor(tunnelId: string) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    this.filePath = path.join(SESSIONS_DIR, `${tunnelId}.jsonl`);
  }

  append(msg: WireMessage): WireMessage {
    if (this.closed) {
      // True no-op: stub a finalized-looking message for the caller without
      // advancing seqCounter, touching msgs, or writing to disk — so a late
      // call after delete() can never recreate the file or extend the log.
      return { ...msg, seq: this.seqCounter, ts: Date.now() };
    }
    const finalized: WireMessage = { ...msg, seq: ++this.seqCounter, ts: Date.now() };
    this.msgs.push(finalized);
    fs.appendFileSync(this.filePath, JSON.stringify(finalized) + '\n');
    return finalized;
  }

  record(finalized: WireMessage): void {
    if (this.closed) return;
    this.msgs.push(finalized);
    this.seqCounter = Math.max(this.seqCounter, finalized.seq);
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

  delete(): void {
    try { fs.rmSync(this.filePath); } catch { /* already gone */ }
    this.msgs = [];
    this.closed = true;
  }
}
