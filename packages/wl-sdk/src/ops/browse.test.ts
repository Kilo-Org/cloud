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
      { status: 200, body: { query_execution_status: 'Success', rows: [] } },
      { status: 200, body: { query_execution_status: 'Success', rows: [] } },
      { status: 200, body: { query_execution_status: 'Success', rows: [] } },
      { status: 200, body: { query_execution_status: 'Success', rows: [] } },
      { status: 200, body: { query_execution_status: 'Success', rows: [] } },
      // 7. listBranches on fork
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
      // 8. read wanted on wl/alice/w-1 (the only mine branch). The
      //    claim's `updated_at` is later than the upstream main row's,
      //    which is what flips `source` to `'fork'`.
      {
        status: 200,
        body: {
          query_execution_status: 'Success',
          rows: [
            fixtureWantedRow({
              id: 'w-1',
              status: 'claimed',
              claimed_by: 'alice',
              updated_at: '2024-01-02 00:00:00',
            }),
          ],
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
    // Unfiltered browse reads upstream rows by status before listing branches.
    expect(calls[0].url).toContain('/hop/wl?q=');
    expect(decodeURIComponent(calls[0].url)).toContain("status = 'open'");
    expect(decodeURIComponent(calls[0].url)).not.toContain('LIMIT');
  });

  it('returns every upstream row when no limit is requested', async () => {
    const rows = Array.from({ length: 75 }, (_, index) =>
      fixtureWantedRow({
        id: `w-${index + 1}`,
        status: index < 50 ? 'completed' : 'open',
      })
    );
    const { fetch: f, calls } = makeFetch([
      {
        status: 200,
        body: {
          query_execution_status: 'Success',
          rows: rows.filter(row => row.status === 'open'),
        },
      },
      {
        status: 200,
        body: {
          query_execution_status: 'Success',
          rows: rows.filter(row => row.status === 'claimed'),
        },
      },
      {
        status: 200,
        body: {
          query_execution_status: 'Success',
          rows: rows.filter(row => row.status === 'in_review'),
        },
      },
      {
        status: 200,
        body: {
          query_execution_status: 'RowLimit',
          rows: rows.filter(row => row.status === 'completed'),
        },
      },
      { status: 200, body: { query_execution_status: 'Success', rows: [] } },
      { status: 200, body: { query_execution_status: 'Success', rows: [] } },
      { status: 200, body: { branches: [] } },
    ]);

    const result = await browse({
      auth: { token: 't' },
      upstream: { owner: 'hop', db: 'wl' },
      fork: { forkOwner: 'alice', forkDb: 'wl' },
      rigHandle: 'alice',
      fetch: f,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(decodeURIComponent(calls[0].url)).not.toContain('LIMIT');
    expect(decodeURIComponent(calls[0].url)).toContain("status = 'open'");
    expect(decodeURIComponent(calls[3].url)).toContain("status = 'completed'");
    expect(result.data).toHaveLength(75);
    expect(result.data.filter(entry => entry.upstream?.status === 'open')).toHaveLength(25);
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

  it('coerces numeric strings returned by DoltHub', async () => {
    const { fetch: f } = makeFetch([
      {
        status: 200,
        body: {
          query_execution_status: 'Success',
          rows: [fixtureWantedRow({ priority: '2', sandbox_required: '0' })],
        },
      },
      { status: 200, body: { query_execution_status: 'Success', rows: [] } },
      { status: 200, body: { query_execution_status: 'Success', rows: [] } },
      { status: 200, body: { query_execution_status: 'Success', rows: [] } },
      { status: 200, body: { query_execution_status: 'Success', rows: [] } },
      { status: 200, body: { query_execution_status: 'Success', rows: [] } },
      { status: 200, body: { branches: [] } },
    ]);

    const result = await browse({
      auth: { anonymous: true },
      upstream: { owner: 'hop', db: 'wl-commons' },
      fork: { forkOwner: 'alice', forkDb: 'wl-commons' },
      rigHandle: 'alice',
      fetch: f,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0].upstream?.priority).toBe(2);
    expect(result.data[0].upstream?.sandbox_required).toBe(0);
  });

  it('keeps source=main when fork branch is stale (upstream advanced past the branch)', async () => {
    // Reproduces: jfawcett did `wl done` on w-1, the admin merged it
    // upstream to `completed`, but jfawcett's local `wl/alice/w-1`
    // branch still shows `in_review`. The browse API should display
    // the upstream `completed` state, not the stale fork view.
    const responses: MockResponse[] = [
      // 6 status reads on upstream main: w-1 only appears in 'completed'.
      {
        status: 200,
        body: {
          query_execution_status: 'Success',
          rows: [],
        },
      },
      { status: 200, body: { query_execution_status: 'Success', rows: [] } },
      { status: 200, body: { query_execution_status: 'Success', rows: [] } },
      {
        status: 200,
        body: {
          query_execution_status: 'Success',
          rows: [
            fixtureWantedRow({
              id: 'w-1',
              status: 'completed',
              claimed_by: 'alice',
              updated_at: '2024-02-10 00:00:00',
            }),
          ],
        },
      },
      { status: 200, body: { query_execution_status: 'Success', rows: [] } },
      { status: 200, body: { query_execution_status: 'Success', rows: [] } },
      // listBranches: the stale `wl/alice/w-1` is still around
      {
        status: 200,
        body: { branches: [{ branch_name: 'wl/alice/w-1' }] },
      },
      // branch read: the stale `in_review` snapshot
      {
        status: 200,
        body: {
          query_execution_status: 'Success',
          rows: [
            fixtureWantedRow({
              id: 'w-1',
              status: 'in_review',
              claimed_by: 'alice',
              updated_at: '2024-02-09 00:00:00',
            }),
          ],
        },
      },
    ];
    const { fetch: f } = makeFetch(responses);
    const result = await browse({
      auth: { token: 't' },
      upstream: { owner: 'hop', db: 'wl' },
      fork: { forkOwner: 'alice', forkDb: 'wl' },
      rigHandle: 'alice',
      fetch: f,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = result.data.find(e => e.wantedId === 'w-1');
    expect(entry).toBeDefined();
    if (!entry) return;
    // Upstream wins because its updated_at is strictly newer than
    // the branch's. The fork row is still attached so drawer/branch-tab
    // consumers can show "you have a stale branch".
    expect(entry.source).toBe('main');
    expect(entry.upstream?.status).toBe('completed');
    expect(entry.fork?.row.status).toBe('in_review');
    expect(entry.fork?.branchName).toBe('wl/alice/w-1');
  });

  it('preserves upstream read details when browse fails', async () => {
    const { fetch: f } = makeFetch([
      {
        status: 400,
        body: { error: 'Table not found: wanted' },
      },
    ]);

    const result = await browse({
      auth: { anonymous: true },
      upstream: { owner: 'hop', db: 'commons' },
      fork: { forkOwner: 'alice', forkDb: 'commons' },
      rigHandle: 'alice',
      fetch: f,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('browse read failed');
    expect(result.error.message).toContain('Read on hop/commons failed (400)');
    expect(result.error.message).toContain('Table not found: wanted');
  });
});
