import { describe, it, expect } from 'vitest';
import { dohQueryOnce, dohResolve, DohProvider } from '../src/net/doh.js';

const P: DohProvider = {
  name: 'p1',
  url: (h, t) => `https://1.1.1.1/dns-query?name=${h}&type=${t}`,
};
const P2: DohProvider = {
  name: 'p2',
  url: (h, t) => `https://1.0.0.1/dns-query?name=${h}&type=${t}`,
};

function resp(body: unknown, { ok = true, status = 200, jsonThrows = false } = {}) {
  return {
    ok,
    status,
    headers: { get: () => 'application/dns-json' },
    json: async () => {
      if (jsonThrows) throw new SyntaxError('Unexpected token < in JSON');
      return body;
    },
  };
}
// A fetch that returns a scripted response per successive call (one per provider).
function scriptedFetch(
  seq: Array<{
    body?: unknown;
    throw?: string;
    ok?: boolean;
    status?: number;
    jsonThrows?: boolean;
  }>,
) {
  let i = 0;
  return (async () => {
    const item = seq[Math.min(i++, seq.length - 1)];
    if (item.throw) throw new Error(item.throw);
    return resp(item.body, item);
  }) as unknown as typeof fetch;
}
const oneShot = (item: Parameters<typeof scriptedFetch>[0][number]) => scriptedFetch([item]);

describe('dohQueryOnce', () => {
  it('RESOLVED for Status 0 with an A record', async () => {
    const r = await dohQueryOnce(
      P,
      'x.trycloudflare.com',
      4,
      3000,
      oneShot({ body: { Status: 0, Answer: [{ type: 1, data: '203.0.113.7' }] } }),
    );
    expect(r.klass).toBe('RESOLVED');
    expect(r.addresses).toEqual([{ address: '203.0.113.7', family: 4 }]);
  });

  it('NXDOMAIN for Status 3', async () => {
    const r = await dohQueryOnce(P, 'x', 4, 3000, oneShot({ body: { Status: 3 } }));
    expect(r.klass).toBe('NXDOMAIN');
    expect(r.addresses).toEqual([]);
  });

  it('NXDOMAIN for Status 0 but CNAME-only (no usable A)', async () => {
    const r = await dohQueryOnce(
      P,
      'x',
      4,
      3000,
      oneShot({ body: { Status: 0, Answer: [{ type: 5, data: 'x.cdn.cloudflare.net' }] } }),
    );
    expect(r.klass).toBe('NXDOMAIN');
  });

  it('NXDOMAIN when the A answer is not a valid IP', async () => {
    const r = await dohQueryOnce(
      P,
      'x',
      4,
      3000,
      oneShot({ body: { Status: 0, Answer: [{ type: 1, data: 'not-an-ip' }] } }),
    );
    expect(r.klass).toBe('NXDOMAIN');
  });

  it('INDETERMINATE on transport error, non-2xx, non-JSON body, or non-numeric Status', async () => {
    expect((await dohQueryOnce(P, 'x', 4, 3000, oneShot({ throw: 'ECONNREFUSED' }))).klass).toBe(
      'INDETERMINATE',
    );
    expect(
      (await dohQueryOnce(P, 'x', 4, 3000, oneShot({ ok: false, status: 403, body: {} }))).klass,
    ).toBe('INDETERMINATE');
    expect((await dohQueryOnce(P, 'x', 4, 3000, oneShot({ jsonThrows: true }))).klass).toBe(
      'INDETERMINATE',
    );
    expect((await dohQueryOnce(P, 'x', 4, 3000, oneShot({ body: { Status: 'nope' } }))).klass).toBe(
      'INDETERMINATE',
    );
    expect((await dohQueryOnce(P, 'x', 4, 3000, oneShot({ body: { Status: 2 } }))).klass).toBe(
      'INDETERMINATE',
    );
  });

  it('queries AAAA and filters type 28 when family is 6', async () => {
    let capturedUrl = '';
    const fetchImpl = (async (u: string) => {
      capturedUrl = u;
      return resp({
        Status: 0,
        Answer: [
          { type: 1, data: '203.0.113.7' },
          { type: 28, data: '2606:4700::1' },
        ],
      });
    }) as unknown as typeof fetch;
    const r = await dohQueryOnce(P, 'x', 6, 3000, fetchImpl);
    expect(capturedUrl).toContain('type=AAAA');
    expect(r.klass).toBe('RESOLVED');
    expect(r.addresses).toEqual([{ address: '2606:4700::1', family: 6 }]);
  });

  it('passes an AbortSignal (timeout) to fetch', async () => {
    let init: RequestInit | undefined;
    const fetchImpl = (async (_u: string, i: RequestInit) => {
      init = i;
      return resp({ Status: 0, Answer: [{ type: 1, data: '1.2.3.4' }] });
    }) as unknown as typeof fetch;
    await dohQueryOnce(P, 'x', 4, 1234, fetchImpl);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('dohResolve (provider fallthrough)', () => {
  it('returns the first RESOLVED provider and stops', async () => {
    const r = await dohResolve(
      'x',
      4,
      [P, P2],
      3000,
      scriptedFetch([
        { throw: 'ECONNREFUSED' }, // p1 INDETERMINATE
        { body: { Status: 0, Answer: [{ type: 1, data: '198.51.100.9' }] } }, // p2 RESOLVED
      ]),
    );
    expect(r.klass).toBe('RESOLVED');
    expect(r.addresses[0].address).toBe('198.51.100.9');
  });

  it('folds to NXDOMAIN when any provider says NXDOMAIN and none RESOLVED', async () => {
    const r = await dohResolve(
      'x',
      4,
      [P, P2],
      3000,
      scriptedFetch([
        { body: { Status: 3 } }, // p1 NXDOMAIN
        { throw: 'ETIMEDOUT' }, // p2 INDETERMINATE
      ]),
    );
    expect(r.klass).toBe('NXDOMAIN');
  });

  it('folds to INDETERMINATE when every provider is unreachable', async () => {
    const r = await dohResolve(
      'x',
      4,
      [P, P2],
      3000,
      scriptedFetch([{ throw: 'ENETUNREACH' }, { throw: 'ENETUNREACH' }]),
    );
    expect(r.klass).toBe('INDETERMINATE');
  });
});
