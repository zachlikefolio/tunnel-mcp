import { describe, it, expect } from 'vitest';
import { SessionLog } from '../src/log/sessionLog.js';

const ID = 'testsession01';

describe('SessionLog', () => {
  it('record stores an already-seq message without re-seqing', () => {
    const log = new SessionLog(ID);
    log.record({ id: 'x', seq: 5, from: 'guest', kind: 'system', body: 'hi', ts: 1 });
    expect(log.lastSeq).toBe(5);
    expect(log.since(4).map((m) => m.id)).toEqual(['x']);
  });

  it('delete clears memory', () => {
    const log = new SessionLog(ID);
    log.record({ id: 'a', seq: 1, from: 'host', kind: 'system', body: 'one', ts: 1 });
    log.delete();
    expect(log.all()).toHaveLength(0);
  });

  it('record after delete is a no-op', () => {
    const log = new SessionLog(ID);
    log.record({ id: 'a', seq: 1, from: 'host', kind: 'system', body: 'one', ts: 1 });
    log.delete();
    log.record({ id: 'late', seq: 99, from: 'guest', kind: 'system', body: 'hi', ts: 1 });
    expect(log.all()).toHaveLength(0);
    expect(log.lastSeq).not.toBe(99);
  });
});

describe('SessionLog (edge cases)', () => {
  const uniqueId = () =>
    `sessionlog-edge-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  it('record() advances lastSeq to the max seq seen, in memory only', () => {
    const log = new SessionLog(uniqueId());

    log.record({ id: 'a', seq: 3, from: 'host', kind: 'system', body: 'a', ts: 1 });
    expect(log.lastSeq).toBe(3);

    // A lower seq should not decrease lastSeq.
    log.record({ id: 'b', seq: 2, from: 'guest', kind: 'system', body: 'b', ts: 2 });
    expect(log.lastSeq).toBe(3);

    // A higher seq should advance lastSeq to that value.
    log.record({ id: 'c', seq: 10, from: 'host', kind: 'system', body: 'c', ts: 3 });
    expect(log.lastSeq).toBe(10);
  });

  it('record() ignores a non-finite seq for cursor purposes but keeps the message', () => {
    const log = new SessionLog(uniqueId());
    log.record({ id: 'a', seq: 5, from: 'host', kind: 'system', body: 'a', ts: 1 });
    expect(log.lastSeq).toBe(5);

    // NaN must not poison lastSeq (an untrusted host could send a bad seq).
    log.record({ id: 'nan', seq: NaN, from: 'guest', kind: 'system', body: 'bad', ts: 2 });
    expect(log.lastSeq).toBe(5);

    // Infinity must not poison lastSeq either.
    log.record({ id: 'inf', seq: Infinity, from: 'guest', kind: 'system', body: 'bad', ts: 3 });
    expect(log.lastSeq).toBe(5);

    // record() never throws on bad input, and the message is still retained.
    expect(log.all().map((m) => m.id)).toEqual(['a', 'nan', 'inf']);

    // A subsequent valid, higher seq still advances the cursor normally.
    log.record({ id: 'b', seq: 8, from: 'host', kind: 'system', body: 'b', ts: 4 });
    expect(log.lastSeq).toBe(8);
  });

  it('since(0) returns all, since(lastSeq) returns empty, since(mid) returns only the tail', () => {
    const log = new SessionLog(uniqueId());
    const a = { id: 'a', seq: 1, from: 'host', kind: 'system' as const, body: 'one', ts: 1 };
    const b = { id: 'b', seq: 2, from: 'host', kind: 'system' as const, body: 'two', ts: 2 };
    const c = { id: 'c', seq: 3, from: 'host', kind: 'system' as const, body: 'three', ts: 3 };
    log.record(a);
    log.record(b);
    log.record(c);

    expect(log.since(0).map((m) => m.id)).toEqual([a.id, b.id, c.id]);
    expect(log.since(log.lastSeq)).toEqual([]);
    expect(log.since(b.seq).map((m) => m.id)).toEqual([c.id]);
  });

  it('delete() is idempotent — calling twice does not throw', () => {
    const log = new SessionLog(uniqueId());
    log.record({ id: 'a', seq: 1, from: 'host', kind: 'system', body: 'one', ts: 1 });

    expect(() => log.delete()).not.toThrow();
    expect(() => log.delete()).not.toThrow();
    expect(log.all()).toHaveLength(0);
  });

  it('all() returns a copy — mutating the returned array does not affect the log', () => {
    const log = new SessionLog(uniqueId());
    log.record({ id: 'a', seq: 1, from: 'host', kind: 'system', body: 'one', ts: 1 });
    log.record({ id: 'b', seq: 2, from: 'host', kind: 'system', body: 'two', ts: 2 });

    const snapshot = log.all();
    expect(snapshot).toHaveLength(2);

    snapshot.push({ id: 'injected', seq: 999, from: 'guest', kind: 'system', body: 'x', ts: 1 });
    snapshot.length = 0;

    // Mutations to the returned array must not leak back into the log.
    expect(log.all()).toHaveLength(2);
    expect(log.lastSeq).toBe(2);
  });
});
