/**
 * Tests for the `@kilocode/wl-sdk` adapter.
 *
 * Strategy: the inner `*ViaSdk` functions take a pre-resolved
 * {@link SdkContext} and an injectable fetch, so each test can drive
 * the SDK at the fetch boundary with a scripted response queue. This
 * mirrors the wl-sdk's own per-op tests and avoids mocking the SDK
 * itself.
 *
 * Coverage:
 *  - Each adapter (browse/claim/unclaim/post/done/accept/reject/close)
 *    issues the right DoltHub HTTPS calls in the right order on the
 *    happy path.
 *  - The shape returned to the tRPC caller matches the historical
 *    contract (e.g. claim returns `{ success, pr_url }`).
 */

import { describe, expect, it } from 'vitest';
import {
  acceptViaSdk,
  browseViaSdk,
  claimViaSdk,
  closeViaSdk,
  doneViaSdk,
  postViaSdk,
  rejectViaSdk,
  unclaimViaSdk,
  type SdkContext,
} from './wanted-board-ops-sdk-inner';

// ── Test-only fetch helpers ─────────────────────────────────────────────

type MockResponse = { status: number; body?: unknown; text?: string };

type FetchCall = { url: string; method: string; body: string | null };

function makeFetch(responses: MockResponse[]): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let i = 0;
  const fakeFetch: typeof fetch = (url, init) => {
    const stringUrl = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : null;
    calls.push({ url: stringUrl, method, body });
    const r = responses[i++] ?? { status: 500, body: { error: 'no more responses' } };
    const text = r.text ?? (r.body !== undefined ? JSON.stringify(r.body) : '');
    return Promise.resolve(new Response(text, { status: r.status }));
  };
  return { fetch: fakeFetch, calls };
}

function syncWriteOk(): MockResponse {
  return { status: 200, body: { query_execution_status: 'Success' } };
}

function readRows(rows: Array<Record<string, unknown>>): MockResponse {
  return { status: 200, body: { query_execution_status: 'Success', rows } };
}

function fixtureWantedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'w-1',
    title: 'Fix the leaky tap',
    description: null,
    project: null,
    type: null,
    priority: 0,
    tags: null,
    posted_by: 'alice',
    claimed_by: null,
    status: 'open',
    effort_level: 'medium',
    evidence_url: null,
    sandbox_required: 0,
    sandbox_scope: null,
    sandbox_min_tier: null,
    created_at: '2024-01-01 00:00:00',
    updated_at: '2024-01-01 00:00:00',
    ...overrides,
  };
}

const baseCtx: SdkContext = {
  upstream: 'hop/wl',
  forkOrg: 'alice',
  rigHandle: 'alice',
  token: 'tok',
  isUpstreamAdmin: false,
};

// ── browseViaSdk ────────────────────────────────────────────────────────

describe('browseViaSdk', () => {
  it('reads upstream main, lists fork branches, returns flat rows', async () => {
    const { fetch, calls } = makeFetch([
      readRows([fixtureWantedRow({ id: 'w-1', status: 'open' })]),
      // listBranches on fork
      { status: 200, body: { branches: [] } },
    ]);

    const result = await browseViaSdk(baseCtx, fetch);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'w-1', status: 'open' });

    // First fetch hits upstream owner/db read endpoint (SQL query
    // is encoded into the URL → GET).
    expect(calls[0].url).toContain('/hop/wl?');
    // Second fetch lists branches on the fork.
    expect(calls[1].url).toContain('/alice/wl/branches');
  });

  it('prefers fork row when a wl/<rig>/* branch exists', async () => {
    const { fetch } = makeFetch([
      readRows([fixtureWantedRow({ id: 'w-1', status: 'open' })]),
      {
        status: 200,
        body: { branches: [{ branch_name: 'wl/alice/w-1' }] },
      },
      readRows([fixtureWantedRow({ id: 'w-1', status: 'claimed', claimed_by: 'alice' })]),
    ]);

    const result = await browseViaSdk(baseCtx, fetch);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('claimed');
    expect(result[0].claimed_by).toBe('alice');
  });
});

// ── claimViaSdk ─────────────────────────────────────────────────────────

describe('claimViaSdk', () => {
  it('writes claim DML then publishes a PR; returns pr_url', async () => {
    // SDK claim sequence:
    //   1. read branch wanted status → null (no branch)
    //   2. write claim DML            → ok
    //   3. read main wanted row       → open
    //   4. read branch wanted row     → claimed (no cleanup)
    // Then publish:
    //   5. listPulls (open)           → []
    //   6. read branch wanted row     → claimed (for title)
    //   7. createPull                  → returns pull_id
    const { fetch, calls } = makeFetch([
      readRows([]),
      syncWriteOk(),
      readRows([fixtureWantedRow({ id: 'w-1', status: 'open' })]),
      readRows([fixtureWantedRow({ id: 'w-1', status: 'claimed', claimed_by: 'alice' })]),
      { status: 200, body: { pulls: [] } },
      readRows([fixtureWantedRow({ id: 'w-1', status: 'claimed' })]),
      { status: 200, body: { pull_id: 'pr-42' } },
    ]);

    const result = await claimViaSdk(baseCtx, 'w-1', fetch);
    expect(result.success).toBe(true);
    expect(result.pr_url).toContain('pr-42');

    // The first write call lands the claim on the wl/alice/w-1 branch.
    const writeCall = calls.find(c => c.method === 'POST' && c.url.includes('/write/'));
    expect(writeCall).toBeDefined();
    expect(writeCall?.url).toContain('/alice/wl/write/');
    expect(writeCall?.url).toContain("claimed_by%3D'alice'");
  });

  it('still resolves an existing PR when claim was a no-op (already claimed)', async () => {
    // Branch idempotency: read returns claimed → no write. The
    // adapter still calls `wl.publish` so an existing PR's url is
    // returned to the caller.
    const { fetch } = makeFetch([
      // 1. claim's idempotency read → already claimed, no write
      readRows([fixtureWantedRow({ id: 'w-1', status: 'claimed', claimed_by: 'alice' })]),
      // 2. publish: listPulls → empty (no existing PR found)
      { status: 200, body: { pulls: [] } },
      // 3. publish: read branch row for title
      readRows([fixtureWantedRow({ id: 'w-1', status: 'claimed' })]),
      // 4. publish: createPull
      { status: 200, body: { pull_id: 'pr-99' } },
    ]);
    const result = await claimViaSdk(baseCtx, 'w-1', fetch);
    expect(result.success).toBe(true);
    expect(result.pr_url).toContain('pr-99');
  });
});

// ── unclaimViaSdk ───────────────────────────────────────────────────────

describe('unclaimViaSdk', () => {
  it('writes unclaim DML and returns success', async () => {
    const { fetch } = makeFetch([
      readRows([fixtureWantedRow({ id: 'w-1', status: 'claimed', claimed_by: 'alice' })]),
      syncWriteOk(),
      // auto-cleanup compare reads
      readRows([fixtureWantedRow({ id: 'w-1', status: 'open' })]),
      readRows([fixtureWantedRow({ id: 'w-1', status: 'open' })]),
      // delete branch (cleanup match)
      { status: 200, body: {} },
    ]);
    const result = await unclaimViaSdk(baseCtx, 'w-1', fetch);
    expect(result).toEqual({ success: true });
  });
});

// ── postViaSdk ──────────────────────────────────────────────────────────

describe('postViaSdk', () => {
  it('inserts a new wanted row with synthesized id', async () => {
    const { fetch, calls } = makeFetch([
      // Idempotency read on freshly-named branch (no row).
      readRows([]),
      // Write the INSERT.
      syncWriteOk(),
    ]);
    const result = await postViaSdk(
      baseCtx,
      { title: 'Fix flicker', description: 'kthx', priority: 'high' },
      fetch
    );
    expect(result.success).toBe(true);
    expect(result.wantedId).toMatch(/^w-[0-9a-f]{12}$/);

    const writeCall = calls.find(c => c.method === 'POST' && c.url.includes('/write/'));
    expect(writeCall).toBeDefined();
    // Title should appear (URI-encoded) in the SQL.
    expect(writeCall?.url).toContain('Fix%20flicker');
    // Priority='high' → numeric 2.
    expect(writeCall?.url).toContain('2');
  });
});

// ── doneViaSdk ──────────────────────────────────────────────────────────

describe('doneViaSdk', () => {
  it('writes done DMLs (UPDATE wanted + INSERT completion) on the branch', async () => {
    const { fetch, calls } = makeFetch([
      // idempotency read
      readRows([fixtureWantedRow({ id: 'w-1', status: 'claimed', claimed_by: 'alice' })]),
      // two write statements
      syncWriteOk(),
      syncWriteOk(),
      // auto-cleanup compare reads
      readRows([fixtureWantedRow({ id: 'w-1', status: 'open' })]),
      readRows([fixtureWantedRow({ id: 'w-1', status: 'in_review' })]),
    ]);

    const result = await doneViaSdk(
      baseCtx,
      { itemId: 'w-1', evidence: 'https://github.com/x/y/pull/1' },
      fetch
    );
    expect(result).toEqual({ success: true });

    const writes = calls.filter(c => c.method === 'POST' && c.url.includes('/write/'));
    // Two statements → two writes.
    expect(writes).toHaveLength(2);
  });
});

// ── acceptViaSdk ────────────────────────────────────────────────────────

describe('acceptViaSdk', () => {
  it('reads completion id then runs accept DMLs', async () => {
    const { fetch, calls } = makeFetch([
      // readLatestCompletionId
      readRows([{ id: 'c-w-1-alice-abc123' }]),
      // accept idempotency read
      readRows([fixtureWantedRow({ id: 'w-1', status: 'in_review' })]),
      // three statements: insert stamp, update completion, update wanted
      syncWriteOk(),
      syncWriteOk(),
      syncWriteOk(),
      // cleanup compare
      readRows([fixtureWantedRow({ id: 'w-1', status: 'open' })]),
      readRows([fixtureWantedRow({ id: 'w-1', status: 'completed' })]),
    ]);

    const result = await acceptViaSdk(
      baseCtx,
      { itemId: 'w-1', quality: 'good', message: 'nice' },
      fetch
    );
    expect(result).toEqual({ success: true });

    const writes = calls.filter(c => c.method === 'POST' && c.url.includes('/write/'));
    // Three accept statements → three writes.
    expect(writes).toHaveLength(3);
  });

  it('throws PRECONDITION_FAILED when no completion exists on the branch', async () => {
    const { fetch } = makeFetch([readRows([])]);
    await expect(
      acceptViaSdk(baseCtx, { itemId: 'w-missing', quality: 'good' }, fetch)
    ).rejects.toThrow(/no completion found/);
  });
});

// ── rejectViaSdk ────────────────────────────────────────────────────────

describe('rejectViaSdk', () => {
  it('runs reject DMLs and returns success', async () => {
    const { fetch, calls } = makeFetch([
      readRows([fixtureWantedRow({ id: 'w-1', status: 'in_review' })]),
      syncWriteOk(),
      syncWriteOk(),
      readRows([fixtureWantedRow({ id: 'w-1', status: 'open' })]),
      readRows([fixtureWantedRow({ id: 'w-1', status: 'claimed' })]),
    ]);
    const result = await rejectViaSdk(baseCtx, { itemId: 'w-1', reason: 'try again' }, fetch);
    expect(result).toEqual({ success: true });

    const writes = calls.filter(c => c.method === 'POST' && c.url.includes('/write/'));
    // Two reject statements: DELETE completion, UPDATE wanted.
    expect(writes).toHaveLength(2);
    // Reason should appear in the commit message portion of the SQL.
    expect(writes.some(w => w.url.includes('try%20again'))).toBe(true);
  });
});

// ── closeViaSdk ─────────────────────────────────────────────────────────

describe('closeViaSdk', () => {
  it('runs close DML and returns success', async () => {
    const { fetch, calls } = makeFetch([
      readRows([fixtureWantedRow({ id: 'w-1', status: 'open' })]),
      syncWriteOk(),
      readRows([fixtureWantedRow({ id: 'w-1', status: 'open' })]),
      readRows([fixtureWantedRow({ id: 'w-1', status: 'closed' })]),
    ]);
    const result = await closeViaSdk(baseCtx, 'w-1', fetch);
    expect(result).toEqual({ success: true });

    const writes = calls.filter(c => c.method === 'POST' && c.url.includes('/write/'));
    expect(writes).toHaveLength(1);
  });
});
