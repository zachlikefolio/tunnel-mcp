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
});
