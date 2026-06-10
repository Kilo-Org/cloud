import { describe, expect, it } from 'vitest';
import { close } from './close';
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

describe('close', () => {
  it('writes UPDATE wanted to completed', async () => {
    const responses: MockResponse[] = [
      readWantedRow(fixtureWantedRow({ status: 'in_review', claimed_by: 'bob' })),
      ...forkCurrentResponses(),
      syncWriteOk(),
      readWantedRow(fixtureWantedRow({ status: 'in_review', claimed_by: 'bob' })),
      readWantedRow(fixtureWantedRow({ status: 'completed', claimed_by: 'bob' })),
    ];
    const { fetch: f, calls } = makeFetch(responses);
    const result = await close({ ctx: ctx(f), wantedId: 'w-1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.alreadyApplied).toBe(false);
    const writes = calls.filter(c => c.method === 'POST' && c.url.includes('/write/'));
    expect(writes).toHaveLength(1);
  });

  it('idempotent at completed', async () => {
    const { fetch: f } = makeFetch([
      readWantedRow(fixtureWantedRow({ status: 'completed', claimed_by: 'bob' })),
    ]);
    const result = await close({ ctx: ctx(f), wantedId: 'w-1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.alreadyApplied).toBe(true);
  });
});
