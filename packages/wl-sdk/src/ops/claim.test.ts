import { describe, expect, it } from 'vitest';
import { claim } from './claim';
import {
  fixtureWantedRow,
  forkCurrentResponses,
  makeFetch,
  readWantedRow,
  syncWriteOk,
  type MockResponse,
} from './test-helpers';
import type { MutationContext } from './types';

const baseCtx = (fakeFetch: typeof fetch): MutationContext => ({
  auth: { token: 'tok' },
  upstream: { owner: 'hop', db: 'wl' },
  fork: { forkOwner: 'alice', forkDb: 'wl' },
  rigHandle: 'alice',
  fetch: fakeFetch,
});

describe('claim', () => {
  it('happy path: idempotency miss, write, cleanup miss', async () => {
    // Sequence:
    //   1. read fork-branch status      → empty rows (branch absent → null)
    //   2. fork-currency preamble       → upstream HEAD == fork HEAD (no drift)
    //   3. write claim DML              → sync ok
    //   4. read upstream main row       → row at status='open'
    //   5. read fork branch row         → row at status='claimed'
    // upstream != branch → no cleanup, branchName retained.
    const responses: MockResponse[] = [
      readWantedRow(null),
      ...forkCurrentResponses(),
      syncWriteOk(),
      readWantedRow(fixtureWantedRow({ id: 'w-1', status: 'open' })),
      readWantedRow(fixtureWantedRow({ id: 'w-1', status: 'claimed', claimed_by: 'alice' })),
    ];
    const { fetch: fakeFetch, calls } = makeFetch(responses);
    const ctx = baseCtx(fakeFetch);
    const result = await claim({ ctx, wantedId: 'w-1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      branchName: 'wl/alice/w-1',
      alreadyApplied: false,
      cleanedUp: false,
    });
    // First call: status read on the fork branch (idempotency check).
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toContain('/alice/wl/wl%2Falice%2Fw-1');
    // Calls 1-2: stale-fork guard — upstream main HEAD then fork main HEAD.
    expect(calls[1].url).toContain('/hop/wl/main');
    expect(calls[1].url).toContain('HASHOF');
    expect(calls[2].url).toContain('/alice/wl/main');
    expect(calls[2].url).toContain('HASHOF');
    // Call 3: the actual write.
    expect(calls[3].method).toBe('POST');
    expect(calls[3].url).toContain('/alice/wl/write/main/wl%2Falice%2Fw-1');
    expect(calls[3].url).toContain("claimed_by%3D'alice'");
  });

  it('idempotency: branch already claimed → no write', async () => {
    // Branch read returns claimed → applyMutation skips the write.
    const { fetch: fakeFetch, calls } = makeFetch([
      readWantedRow(fixtureWantedRow({ id: 'w-1', status: 'claimed', claimed_by: 'alice' })),
    ]);
    const ctx = baseCtx(fakeFetch);
    const result = await claim({ ctx, wantedId: 'w-1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      branchName: 'wl/alice/w-1',
      alreadyApplied: true,
      cleanedUp: false,
    });
    // Only the idempotency-check read happened.
    expect(calls).toHaveLength(1);
  });

  it('error path: 401 auth failure surfaces as code=auth', async () => {
    const responses: MockResponse[] = [
      // branch read: empty rows (branch absent, write proceeds)
      readWantedRow(null),
      // fork-currency preamble: not stale
      ...forkCurrentResponses(),
      // write: 401
      { status: 401, body: { error: 'bad token' } },
    ];
    const { fetch: fakeFetch } = makeFetch(responses);
    const ctx = baseCtx(fakeFetch);
    const result = await claim({ ctx, wantedId: 'w-1' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('auth');
  });

  it('refuses with code=precondition when fork main is behind upstream', async () => {
    const responses: MockResponse[] = [
      // idempotency: branch absent
      readWantedRow(null),
      // fork-currency preamble: drift!
      ...forkCurrentResponses({ drift: true }),
    ];
    const { fetch: fakeFetch, calls } = makeFetch(responses);
    const ctx = baseCtx(fakeFetch);
    const result = await claim({ ctx, wantedId: 'w-1' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('precondition');
    // Message includes the deep-link to the DoltHub sync UI.
    expect(result.error.message).toMatch(
      /https:\/\/www\.dolthub\.com\/repositories\/alice\/wl\/pulls\/new/
    );
    // No write was issued — only the 3 reads (idempotency + 2 HASHOF).
    expect(calls).toHaveLength(3);
    expect(calls.every(c => c.method === 'GET')).toBe(true);
  });
});
