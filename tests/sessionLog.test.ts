import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SESSIONS_DIR } from '../src/config.js';
import { SessionLog } from '../src/log/sessionLog.js';
import { buildSystem } from '../src/protocol/messages.js';

const ID = 'testsession01';
afterEach(() => {
  try {
    fs.rmSync(path.join(SESSIONS_DIR, `${ID}.jsonl`));
  } catch {}
});

describe('SessionLog', () => {
  it('append assigns monotonic seq and persists to jsonl', () => {
    const log = new SessionLog(ID);
    const a = log.append(buildSystem('host', 'one'));
    const b = log.append(buildSystem('host', 'two'));
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(log.lastSeq).toBe(2);
    const file = fs
      .readFileSync(path.join(SESSIONS_DIR, `${ID}.jsonl`), 'utf8')
      .trim()
      .split('\n');
    expect(file).toHaveLength(2);
  });

  it('since returns only newer messages', () => {
    const log = new SessionLog(ID);
    log.append(buildSystem('host', 'one'));
    const b = log.append(buildSystem('host', 'two'));
    expect(log.since(1).map((m) => m.id)).toEqual([b.id]);
  });

  it('record stores an already-seq message without re-seqing', () => {
    const log = new SessionLog(ID);
    log.record({ id: 'x', seq: 5, from: 'guest', kind: 'system', body: 'hi', ts: 1 });
    expect(log.lastSeq).toBe(5);
    expect(log.since(4).map((m) => m.id)).toEqual(['x']);
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

describe('SessionLog (edge cases)', () => {
  const uniqueId = () =>
    `sessionlog-edge-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let currentId: string;

  afterEach(() => {
    if (currentId) {
      try {
        fs.rmSync(path.join(SESSIONS_DIR, `${currentId}.jsonl`));
      } catch {}
    }
  });

  it('record() advances lastSeq to the max seq seen and never writes to disk', () => {
    currentId = uniqueId();
    const log = new SessionLog(currentId);
    const filePath = path.join(SESSIONS_DIR, `${currentId}.jsonl`);

    log.record({ id: 'a', seq: 3, from: 'host', kind: 'system', body: 'a', ts: 1 });
    expect(log.lastSeq).toBe(3);

    // A lower seq should not decrease lastSeq.
    log.record({ id: 'b', seq: 2, from: 'guest', kind: 'system', body: 'b', ts: 2 });
    expect(log.lastSeq).toBe(3);

    // A higher seq should advance lastSeq to that value.
    log.record({ id: 'c', seq: 10, from: 'host', kind: 'system', body: 'c', ts: 3 });
    expect(log.lastSeq).toBe(10);

    // record() must never touch disk, regardless of how many calls happen.
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('since(0) returns all, since(lastSeq) returns empty, since(mid) returns only the tail', () => {
    currentId = uniqueId();
    const log = new SessionLog(currentId);
    const a = log.append(buildSystem('host', 'one'));
    const b = log.append(buildSystem('host', 'two'));
    const c = log.append(buildSystem('host', 'three'));

    expect(log.since(0).map((m) => m.id)).toEqual([a.id, b.id, c.id]);
    expect(log.since(log.lastSeq)).toEqual([]);
    expect(log.since(b.seq).map((m) => m.id)).toEqual([c.id]);
  });

  it('multiple appends write multiple jsonl lines with monotonically increasing seq', () => {
    currentId = uniqueId();
    const log = new SessionLog(currentId);
    const filePath = path.join(SESSIONS_DIR, `${currentId}.jsonl`);

    const n = 5;
    const results = [];
    for (let i = 0; i < n; i++) {
      results.push(log.append(buildSystem('host', `msg-${i}`)));
    }

    const seqs = results.map((m) => m.seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5]);

    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(n);
    const parsedSeqs = lines.map((l) => JSON.parse(l).seq);
    expect(parsedSeqs).toEqual([1, 2, 3, 4, 5]);
  });

  it('delete() is idempotent — calling twice does not throw', () => {
    currentId = uniqueId();
    const log = new SessionLog(currentId);
    log.append(buildSystem('host', 'one'));

    expect(() => log.delete()).not.toThrow();
    expect(() => log.delete()).not.toThrow();
    expect(log.all()).toHaveLength(0);
    expect(fs.existsSync(path.join(SESSIONS_DIR, `${currentId}.jsonl`))).toBe(false);
  });

  it('all() returns a copy — mutating the returned array does not affect the log', () => {
    currentId = uniqueId();
    const log = new SessionLog(currentId);
    log.append(buildSystem('host', 'one'));
    log.append(buildSystem('host', 'two'));

    const snapshot = log.all();
    expect(snapshot).toHaveLength(2);

    snapshot.push({ id: 'injected', seq: 999, from: 'guest', kind: 'system', body: 'x', ts: 1 });
    snapshot.length = 0;

    // Mutations to the returned array must not leak back into the log.
    expect(log.all()).toHaveLength(2);
    expect(log.lastSeq).toBe(2);
  });
});
