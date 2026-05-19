import { describe, expect, it } from 'vitest';
import { unclaim } from './unclaim';
import {
  fixtureWantedRow,
  forkCurrentResponses,
  makeFetch,
  readWantedRow,
  syncWriteOk,
  type MockResponse,
} from './test-helpers';
import type { MutationContext } from './types';

const ctx = (f: typeof fetch): MutationContext => ({
  auth: { token: 'tok' },
  upstream: { owner: 'hop', db: 'wl' },
  fork: { forkOwner: 'alice', forkDb: 'wl' },
  rigHandle: 'alice',
  fetch: f,
});

describe('unclaim', () => {
  it('happy path: writes and skips cleanup when branch ≠ main', async () => {
    const responses: MockResponse[] = [
      // 1. branch status read: claimed (so unclaim is needed)
      readWantedRow(fixtureWantedRow({ status: 'claimed', claimed_by: 'alice' })),
      // 2. fork-currency preamble: not stale
      ...forkCurrentResponses(),
      // 3. write
      syncWriteOk(),
      // 4. upstream main: still has the original 'open' row
      readWantedRow(fixtureWantedRow({ status: 'open' })),
      // 5. fork branch row after write: open with claimed_by NULL —
      //    differs from main on `updated_at` (NOW vs original) but
      //    wantedRowsEquivalent ignores updated_at; here we mark the
      //    description differently to force cleanup=false.
      readWantedRow(fixtureWantedRow({ status: 'open', description: 'pending tweak' })),
    ];
    const { fetch: f } = makeFetch(responses);
    const result = await unclaim({ ctx: ctx(f), wantedId: 'w-1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.cleanedUp).toBe(false);
    expect(result.data.branchName).toBe('wl/alice/w-1');
  });

  it('auto-cleanup: claim then unclaim with no other state deletes the branch', async () => {
    // Sequence:
    //   1. branch status read: claimed (idempotency miss)
    //   2. write unclaim DML        → ok
    //   3. read upstream main row   → 'open' fixture
    //   4. read fork branch row     → identical 'open' fixture
    //      → wantedRowsEquivalent → true → cleanup
    //   5. delete branch            → 200
    const sameRow = fixtureWantedRow({ status: 'open' });
    const responses: MockResponse[] = [
      readWantedRow(fixtureWantedRow({ status: 'claimed', claimed_by: 'alice' })),
      ...forkCurrentResponses(),
      syncWriteOk(),
      readWantedRow(sameRow),
      readWantedRow(sameRow),
      { status: 200, body: {} },
    ];
    const { fetch: f, calls } = makeFetch(responses);
    const result = await unclaim({ ctx: ctx(f), wantedId: 'w-1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      branchName: '',
      alreadyApplied: false,
      cleanedUp: true,
    });
    // The last call should be the DELETE on the fork branch.
    const last = calls[calls.length - 1];
    expect(last.method).toBe('DELETE');
    expect(last.url).toContain('/alice/wl/branches/wl%2Falice%2Fw-1');
  });

  it('idempotency: branch already at open → no write, no cleanup', async () => {
    const { fetch: f, calls } = makeFetch([readWantedRow(fixtureWantedRow({ status: 'open' }))]);
    const result = await unclaim({ ctx: ctx(f), wantedId: 'w-1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.alreadyApplied).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
