import fs from 'node:fs';
import path from 'node:path';
import { SESSIONS_DIR } from '../config.js';
import { WireMessage } from '../protocol/messages.js';

export class SessionLog {
  private msgs: WireMessage[] = [];
  private seqCounter = 0;
  private filePath: string;

  constructor(tunnelId: string) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    this.filePath = path.join(SESSIONS_DIR, `${tunnelId}.jsonl`);
  }

  append(msg: WireMessage): WireMessage {
    const finalized: WireMessage = { ...msg, seq: ++this.seqCounter, ts: Date.now() };
    this.msgs.push(finalized);
    fs.appendFileSync(this.filePath, JSON.stringify(finalized) + '\n');
    return finalized;
  }

  record(finalized: WireMessage): void {
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
  }
}
