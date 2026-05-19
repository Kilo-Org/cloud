import { describe, expect, it } from 'vitest';
import { accept } from './accept';
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

describe('accept', () => {
  it('fans the three-statement DML across three writes onto the branch', async () => {
    const responses: MockResponse[] = [
      // branch status read: in_review
      readWantedRow(fixtureWantedRow({ status: 'in_review', claimed_by: 'bob' })),
      // fork-currency preamble: not stale
      ...forkCurrentResponses(),
      // 3 writes: INSERT stamp, UPDATE completion, UPDATE wanted
      syncWriteOk(),
      syncWriteOk(),
      syncWriteOk(),
      // cleanup reads (no cleanup expected — main is still in_review)
      readWantedRow(fixtureWantedRow({ status: 'in_review', claimed_by: 'bob' })),
      readWantedRow(fixtureWantedRow({ status: 'completed', claimed_by: 'bob' })),
    ];
    const { fetch: f, calls } = makeFetch(responses);
    const result = await accept({
      ctx: ctx(f),
      wantedId: 'w-1',
      completionId: 'c-1',
      stamp: {
        id: 's-1',
        subject: 'bob',
        quality: 1,
        reliability: 1,
        severity: 'leaf',
        skillTags: ['typescript'],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.stampId).toBe('s-1');
    const writes = calls.filter(c => c.method === 'POST' && c.url.includes('/write/'));
    expect(writes).toHaveLength(3);
    // First branches off main; subsequent commits target the same branch.
    expect(writes[0].url).toContain('/write/main/wl%2Falice%2Fw-1');
    expect(writes[1].url).toContain('/write/wl%2Falice%2Fw-1/wl%2Falice%2Fw-1');
    expect(writes[2].url).toContain('/write/wl%2Falice%2Fw-1/wl%2Falice%2Fw-1');
  });

  it('idempotency: branch already at completed → no writes', async () => {
    const { fetch: f, calls } = makeFetch([
      readWantedRow(fixtureWantedRow({ status: 'completed', claimed_by: 'bob' })),
    ]);
    const result = await accept({
      ctx: ctx(f),
      wantedId: 'w-1',
      completionId: 'c-1',
      stamp: {
        id: 's-1',
        subject: 'bob',
        quality: 1,
        reliability: 1,
        severity: 'leaf',
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.alreadyApplied).toBe(true);
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(0);
  });
});
