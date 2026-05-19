import { describe, expect, it } from 'vitest';
import { done } from './done';
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

describe('done', () => {
  it('happy path: fans the two-statement DML across two writes', async () => {
    const responses: MockResponse[] = [
      // branch status read: claimed
      readWantedRow(fixtureWantedRow({ status: 'claimed', claimed_by: 'alice' })),
      // fork-currency preamble: not stale
      ...forkCurrentResponses(),
      // statement 1: UPDATE wanted ...
      syncWriteOk(),
      // statement 2: INSERT IGNORE INTO completions ...
      syncWriteOk(),
      // upstream main row
      readWantedRow(fixtureWantedRow({ status: 'claimed', claimed_by: 'alice' })),
      // fork branch row after writes: in_review
      readWantedRow(fixtureWantedRow({ status: 'in_review', claimed_by: 'alice' })),
    ];
    const { fetch: f, calls } = makeFetch(responses);
    const result = await done({
      ctx: ctx(f),
      wantedId: 'w-1',
      evidence: 'https://example.com/pr/1',
      completionId: 'c-w-1-alice-abc',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.completionId).toBe('c-w-1-alice-abc');
    // Two write POSTs.
    const writes = calls.filter(c => c.method === 'POST' && c.url.includes('/write/'));
    expect(writes).toHaveLength(2);
    // First write branches off main; second commits onto the branch.
    expect(writes[0].url).toContain('/write/main/wl%2Falice%2Fw-1');
    expect(writes[1].url).toContain('/write/wl%2Falice%2Fw-1/wl%2Falice%2Fw-1');
  });

  it('idempotency: branch already in_review → no writes', async () => {
    const { fetch: f, calls } = makeFetch([
      readWantedRow(fixtureWantedRow({ status: 'in_review', claimed_by: 'alice' })),
    ]);
    const result = await done({
      ctx: ctx(f),
      wantedId: 'w-1',
      evidence: 'x',
      completionId: 'c-x',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.alreadyApplied).toBe(true);
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(0);
  });
});
