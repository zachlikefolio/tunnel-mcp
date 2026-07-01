import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SESSIONS_DIR } from '../src/config.js';
import { SessionLog } from '../src/log/sessionLog.js';
import { buildSystem } from '../src/protocol/messages.js';

const ID = 'testsession01';
afterEach(() => { try { fs.rmSync(path.join(SESSIONS_DIR, `${ID}.jsonl`)); } catch {} });

describe('SessionLog', () => {
  it('append assigns monotonic seq and persists to jsonl', () => {
    const log = new SessionLog(ID);
    const a = log.append(buildSystem('host', 'one'));
    const b = log.append(buildSystem('host', 'two'));
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(log.lastSeq).toBe(2);
    const file = fs.readFileSync(path.join(SESSIONS_DIR, `${ID}.jsonl`), 'utf8').trim().split('\n');
    expect(file).toHaveLength(2);
  });

  it('since returns only newer messages', () => {
    const log = new SessionLog(ID);
    log.append(buildSystem('host', 'one'));
    const b = log.append(buildSystem('host', 'two'));
    expect(log.since(1).map(m => m.id)).toEqual([b.id]);
  });

  it('record stores an already-seq message without re-seqing', () => {
    const log = new SessionLog(ID);
    log.record({ id: 'x', seq: 5, from: 'guest', kind: 'system', body: 'hi', ts: 1 });
    expect(log.lastSeq).toBe(5);
    expect(log.since(4).map(m => m.id)).toEqual(['x']);
  });

  it('delete clears memory and removes the file', () => {
    const log = new SessionLog(ID);
    log.append(buildSystem('host', 'one'));
    log.delete();
    expect(log.all()).toHaveLength(0);
    expect(fs.existsSync(path.join(SESSIONS_DIR, `${ID}.jsonl`))).toBe(false);
  });

  it('append after delete is a no-op — it never recreates the file (orphan-log regression)', () => {
    const log = new SessionLog(ID);
    log.append(buildSystem('host', 'one'));
    log.delete();
    const lastSeqAfterDelete = log.lastSeq;

    // Simulates a late event (e.g. a guest socket's 'close' handler racing
    // session teardown) calling append() after the log has been deleted.
    const stub = log.append(buildSystem('host', 'late straggler'));

    expect(fs.existsSync(path.join(SESSIONS_DIR, `${ID}.jsonl`))).toBe(false);
    expect(log.lastSeq).toBe(lastSeqAfterDelete);
    expect(log.all()).toHaveLength(0);
    // The caller still gets back a finalized-shaped message (no crash for
    // code that reads msg.seq off the return value), it's just not recorded.
    expect(stub.body).toBe('late straggler');
  });

  it('record after delete is a no-op', () => {
    const log = new SessionLog(ID);
    log.append(buildSystem('host', 'one'));
    log.delete();
    log.record({ id: 'late', seq: 99, from: 'guest', kind: 'system', body: 'hi', ts: 1 });
    expect(log.all()).toHaveLength(0);
    expect(log.lastSeq).not.toBe(99);
  });
});
