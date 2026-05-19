import { describe, expect, it } from 'vitest';
import { leave } from './leave';
import { makeFetch, type MockResponse } from './test-helpers';

describe('leave', () => {
  it('deletes all wl/<rig>/* branches on the fork', async () => {
    const responses: MockResponse[] = [
      // listBranches
      {
        status: 200,
        body: {
          branches: [
            { branch_name: 'main' },
            { branch_name: 'wl/alice/w-1' },
            { branch_name: 'wl/alice/w-2' },
            { branch_name: 'wl/bob/w-3' },
          ],
        },
      },
      // delete wl/alice/w-1
      { status: 200, body: { status: 'Success' } },
      // delete wl/alice/w-2
      { status: 200, body: { status: 'Success' } },
    ];
    const { fetch: f, calls } = makeFetch(responses);
    const result = await leave({
      auth: { token: 't' },
      fork: { forkOwner: 'alice', forkDb: 'wl' },
      rigHandle: 'alice',
      fetch: f,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.deletedBranches).toBe(2);
    expect(result.data.failedBranches).toEqual([]);
    // Two DELETEs
    const deletes = calls.filter(c => c.method === 'DELETE');
    expect(deletes.map(d => d.url)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('wl%2Falice%2Fw-1'),
        expect.stringContaining('wl%2Falice%2Fw-2'),
      ])
    );
  });

  it('records best-effort failures rather than aborting', async () => {
    const responses: MockResponse[] = [
      // listBranches
      {
        status: 200,
        body: {
          branches: [{ branch_name: 'wl/alice/w-1' }, { branch_name: 'wl/alice/w-2' }],
        },
      },
      // delete w-1: fails 500
      { status: 500, body: { error: 'oops' } },
      // delete w-2: ok
      { status: 200, body: { status: 'Success' } },
    ];
    const { fetch: f } = makeFetch(responses);
    const result = await leave({
      auth: { token: 't' },
      fork: { forkOwner: 'alice', forkDb: 'wl' },
      rigHandle: 'alice',
      fetch: f,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.deletedBranches).toBe(1);
    expect(result.data.failedBranches).toEqual(['wl/alice/w-1']);
  });
});
