import { describe, expect, it } from 'vitest';
import { browse } from './browse';
import { fixtureWantedRow, makeFetch, type MockResponse } from './test-helpers';

describe('browse', () => {
  it('overlays fork branches onto upstream main', async () => {
    const responses: MockResponse[] = [
      // 1. SELECT * FROM wanted on upstream main
      {
        status: 200,
        body: {
          query_execution_status: 'Success',
          rows: [
            fixtureWantedRow({ id: 'w-1', status: 'open' }),
            fixtureWantedRow({ id: 'w-2', status: 'open' }),
          ],
        },
      },
      // 2. listBranches on fork
      {
        status: 200,
        body: {
          branches: [
            { branch_name: 'main' },
            { branch_name: 'wl/alice/w-1' },
            { branch_name: 'wl/bob/w-2' }, // not mine
          ],
        },
      },
      // 3. read wanted on wl/alice/w-1 (the only mine branch)
      {
        status: 200,
        body: {
          query_execution_status: 'Success',
          rows: [fixtureWantedRow({ id: 'w-1', status: 'claimed', claimed_by: 'alice' })],
        },
      },
    ];
    const { fetch: f, calls } = makeFetch(responses);
    const result = await browse({
      auth: { token: 't' },
      upstream: { owner: 'hop', db: 'wl' },
      fork: { forkOwner: 'alice', forkDb: 'wl' },
      rigHandle: 'alice',
      fetch: f,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(result.data.map(e => [e.wantedId, e]));
    expect(byId.get('w-1')?.source).toBe('fork');
    expect(byId.get('w-1')?.fork?.row.status).toBe('claimed');
    expect(byId.get('w-2')?.source).toBe('main');
    expect(byId.get('w-2')?.fork).toBeNull();
    // First call is the upstream main read.
    expect(calls[0].url).toContain('/hop/wl?q=');
  });

  it('applies status filter in SQL', async () => {
    const responses: MockResponse[] = [
      {
        status: 200,
        body: { query_execution_status: 'Success', rows: [] },
      },
      { status: 200, body: { branches: [] } },
    ];
    const { fetch: f, calls } = makeFetch(responses);
    const result = await browse({
      auth: { token: 't' },
      upstream: { owner: 'hop', db: 'wl' },
      fork: { forkOwner: 'alice', forkDb: 'wl' },
      rigHandle: 'alice',
      filter: { status: 'open', limit: 10 },
      fetch: f,
    });
    expect(result.ok).toBe(true);
    expect(decodeURIComponent(calls[0].url)).toContain("status = 'open'");
    expect(decodeURIComponent(calls[0].url)).toContain('LIMIT 10');
  });
});
