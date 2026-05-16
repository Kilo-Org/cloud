import { describe, expect, it } from 'vitest';
import { claim } from './claim';
import {
  fixtureWantedRow,
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
    //   1. read fork-branch status   → empty rows (branch absent → null)
    //   2. write claim DML           → sync ok
    //   3. read upstream main row    → row at status='open'
    //   4. read fork branch row      → row at status='claimed'
    // upstream != branch → no cleanup, branchName retained.
    const responses: MockResponse[] = [
      readWantedRow(null),
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
    // First call: status read on the fork branch.
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toContain('/alice/wl/wl%2Falice%2Fw-1');
    // Second call: write to fork.
    expect(calls[1].method).toBe('POST');
    expect(calls[1].url).toContain('/alice/wl/write/main/wl%2Falice%2Fw-1');
    expect(calls[1].url).toContain("claimed_by%3D'alice'");
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
});
