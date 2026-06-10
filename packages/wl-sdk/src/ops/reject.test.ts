import { describe, expect, it } from 'vitest';
import { reject } from './reject';
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

describe('reject', () => {
  it('fans DELETE + UPDATE onto the branch', async () => {
    const responses: MockResponse[] = [
      readWantedRow(fixtureWantedRow({ status: 'in_review', claimed_by: 'bob' })),
      ...forkCurrentResponses(),
      syncWriteOk(),
      syncWriteOk(),
      // cleanup reads — diverges from main, no cleanup
      readWantedRow(fixtureWantedRow({ status: 'in_review', claimed_by: 'bob' })),
      readWantedRow(fixtureWantedRow({ status: 'claimed', claimed_by: 'bob' })),
    ];
    const { fetch: f, calls } = makeFetch(responses);
    const result = await reject({
      ctx: ctx(f),
      wantedId: 'w-1',
      reason: 'evidence link 404s',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const writes = calls.filter(c => c.method === 'POST' && c.url.includes('/write/'));
    expect(writes).toHaveLength(2);
  });

  it('idempotency: branch already at claimed → no writes', async () => {
    const { fetch: f, calls } = makeFetch([
      readWantedRow(fixtureWantedRow({ status: 'claimed', claimed_by: 'bob' })),
    ]);
    const result = await reject({ ctx: ctx(f), wantedId: 'w-1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.alreadyApplied).toBe(true);
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(0);
  });
});
