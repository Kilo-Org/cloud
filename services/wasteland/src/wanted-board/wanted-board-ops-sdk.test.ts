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

/**
 * The two `HASHOF('main')` reads `applyMutation`'s stale-fork guard
 * issues — upstream main HEAD followed by fork main HEAD. Default:
 * both equal (fork is current).
 */
function forkCurrentResponses(): MockResponse[] {
  return [readRows([{ h: 'upstream-head' }]), readRows([{ h: 'upstream-head' }])];
}

/**
 * `publish` first checks for an open PR on the branch, then compares
 * branch HEAD vs upstream main HEAD to short-circuit when there is
 * nothing new to publish. For the create-new-PR happy path:
 *  - the open-PR list comes back empty, AND
 *  - branch HEAD differs from main HEAD (so we fall through to
 *    createPull instead of returning the no-op idempotency case).
 *
 * Two distinct hash values keep the path explicit; a `null` from
 * either read would also fall through, but masks the intent.
 */
function publishNoExistingPull(): MockResponse[] {
  return [
    // listPulls(open) → empty
    { status: 200, body: { pulls: [] } },
    // branch HEAD
    readRows([{ h: 'branch-head' }]),
    // upstream main HEAD — different so branch is "ahead"
    readRows([{ h: 'main-head' }]),
  ];
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
    // browse() with no filter fans out one read per BoardStatuses entry
    // (open, claimed, in_review, completed, validated, withdrawn).
    // Only the first response carries a row; the rest are empty.
    const { fetch, calls } = makeFetch([
      readRows([fixtureWantedRow({ id: 'w-1', status: 'open' })]),
      readRows([]),
      readRows([]),
      readRows([]),
      readRows([]),
      readRows([]),
      // listBranches on fork
      { status: 200, body: { branches: [] } },
    ]);

    const result = await browseViaSdk(baseCtx, fetch);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'w-1', status: 'open' });

    // The first six fetches hit the upstream owner/db read endpoint
    // (SQL query is encoded into the URL → GET).
    expect(calls[0].url).toContain('/hop/wl?');
    // Subsequent fetch lists branches on the fork.
    const branchListCall = calls.find(c => c.url.includes('/alice/wl/branches'));
    expect(branchListCall).toBeDefined();
  });

  it('prefers fork row when a wl/<rig>/* branch is ahead of upstream main', async () => {
    // Fork wins only when its `updated_at` is strictly newer than the
    // upstream main row's — that's the SDK's "fork has fresh in-progress
    // work" signal.
    const { fetch } = makeFetch([
      // 6 status reads on upstream main
      readRows([
        fixtureWantedRow({ id: 'w-1', status: 'open', updated_at: '2024-01-01 00:00:00' }),
      ]),
      readRows([]),
      readRows([]),
      readRows([]),
      readRows([]),
      readRows([]),
      // listBranches on fork
      {
        status: 200,
        body: { branches: [{ branch_name: 'wl/alice/w-1' }] },
      },
      // per-branch read on fork — claim updated_at is strictly newer
      readRows([
        fixtureWantedRow({
          id: 'w-1',
          status: 'claimed',
          claimed_by: 'alice',
          updated_at: '2024-01-02 00:00:00',
        }),
      ]),
    ]);

    const result = await browseViaSdk(baseCtx, fetch);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('claimed');
    expect(result[0].claimed_by).toBe('alice');
  });

  it('shows upstream when a stale wl/<rig>/* branch lags behind main', async () => {
    // Reproduces the post-accept stale-branch case: the user's `wl done`
    // got merged upstream by an admin (main now shows `completed`), but
    // their fork branch still holds the older `in_review` snapshot.
    // Browse should surface the freshly-completed upstream row, not
    // the stale branch view.
    const { fetch } = makeFetch([
      // 6 upstream main reads — the row appears in the 'completed' fanout
      readRows([]),
      readRows([]),
      readRows([]),
      readRows([
        fixtureWantedRow({
          id: 'w-1',
          status: 'completed',
          claimed_by: 'alice',
          updated_at: '2024-02-10 00:00:00',
        }),
      ]),
      readRows([]),
      readRows([]),
      // listBranches: stale wl/alice/w-1 still around
      { status: 200, body: { branches: [{ branch_name: 'wl/alice/w-1' }] } },
      // branch read: older `in_review` snapshot
      readRows([
        fixtureWantedRow({
          id: 'w-1',
          status: 'in_review',
          claimed_by: 'alice',
          updated_at: '2024-02-09 00:00:00',
        }),
      ]),
    ]);

    const result = await browseViaSdk(baseCtx, fetch);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('completed');
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
    //   5. listPulls fanout (open, merged, closed) → all []
    //   6. read branch wanted row     → claimed (for title)
    //   7. createPull                  → returns pull_id
    const { fetch, calls } = makeFetch([
      readRows([]),
      // fork-currency preamble: not stale
      ...forkCurrentResponses(),
      syncWriteOk(),
      readRows([fixtureWantedRow({ id: 'w-1', status: 'open' })]),
      readRows([fixtureWantedRow({ id: 'w-1', status: 'claimed', claimed_by: 'alice' })]),
      ...publishNoExistingPull(),
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
      // 2. publish: listPulls fanout (open/merged/closed) → all empty
      ...publishNoExistingPull(),
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
      ...forkCurrentResponses(),
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
      // fork-currency preamble: not stale
      ...forkCurrentResponses(),
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
  it('writes done DMLs and auto-publishes a PR; returns pr_url', async () => {
    const { fetch, calls } = makeFetch([
      // idempotency read
      readRows([fixtureWantedRow({ id: 'w-1', status: 'claimed', claimed_by: 'alice' })]),
      // fork-currency preamble: not stale
      ...forkCurrentResponses(),
      // two write statements
      syncWriteOk(),
      syncWriteOk(),
      // auto-cleanup compare reads
      readRows([fixtureWantedRow({ id: 'w-1', status: 'open' })]),
      readRows([fixtureWantedRow({ id: 'w-1', status: 'in_review' })]),
      // publish: listPulls fanout (open/merged/closed) → all empty
      ...publishNoExistingPull(),
      // publish: read branch row for title
      readRows([fixtureWantedRow({ id: 'w-1', status: 'in_review' })]),
      // publish: createPull
      { status: 200, body: { pull_id: 'pr-77' } },
    ]);

    const result = await doneViaSdk(
      baseCtx,
      { itemId: 'w-1', evidence: 'https://github.com/x/y/pull/1' },
      fetch
    );
    expect(result.success).toBe(true);
    expect(result.pr_url).toContain('pr-77');

    const writes = calls.filter(c => c.method === 'POST' && c.url.includes('/write/'));
    // Two statements → two writes (publish itself is a separate API).
    expect(writes).toHaveLength(2);
  });

  it('returns pr_url=null when publish fails but done write succeeds', async () => {
    const { fetch, calls } = makeFetch([
      // idempotency read
      readRows([fixtureWantedRow({ id: 'w-1', status: 'claimed', claimed_by: 'alice' })]),
      // fork-currency preamble: not stale
      ...forkCurrentResponses(),
      // two write statements
      syncWriteOk(),
      syncWriteOk(),
      // auto-cleanup compare reads
      readRows([fixtureWantedRow({ id: 'w-1', status: 'open' })]),
      readRows([fixtureWantedRow({ id: 'w-1', status: 'in_review' })]),
      // publish: listPulls fans out 3x (open/merged/closed); each
      // 5xx is swallowed by `findPullForBranchInState` → returns null.
      { status: 500, body: { error: 'upstream down' } },
      { status: 500, body: { error: 'upstream down' } },
      { status: 500, body: { error: 'upstream down' } },
      // publish: read branch row for title (still attempted)
      { status: 500, body: { error: 'upstream down' } },
      // publish: createPull also fails
      { status: 500, body: { error: 'upstream down' } },
    ]);

    const result = await doneViaSdk(
      baseCtx,
      { itemId: 'w-1', evidence: 'https://github.com/x/y/pull/1' },
      fetch
    );
    expect(result).toEqual({ success: true, pr_url: null });

    const writes = calls.filter(c => c.method === 'POST' && c.url.includes('/write/'));
    expect(writes).toHaveLength(2);
  });
});

// ── acceptViaSdk ────────────────────────────────────────────────────────

describe('acceptViaSdk', () => {
  it('writes the 5-statement accept-upstream DML stack and auto-publishes the admin PR', async () => {
    const { fetch, calls } = makeFetch([
      // applyMutation: idempotency read on admin's branch wl/alice/w-1
      readRows([fixtureWantedRow({ id: 'w-1', status: 'in_review' })]),
      // fork-currency preamble: not stale
      ...forkCurrentResponses(),
      // five accept-upstream statements (DELETE, INSERT, UPDATE wanted, INSERT stamp, UPDATE completion)
      syncWriteOk(),
      syncWriteOk(),
      syncWriteOk(),
      syncWriteOk(),
      syncWriteOk(),
      // auto-cleanup compare reads (main vs admin's branch tip)
      readRows([fixtureWantedRow({ id: 'w-1', status: 'in_review' })]),
      readRows([fixtureWantedRow({ id: 'w-1', status: 'completed' })]),
      // publish: listPulls fanout (open/merged/closed) → all empty
      ...publishNoExistingPull(),
      // publish: read branch row for title
      readRows([fixtureWantedRow({ id: 'w-1', status: 'completed' })]),
      // publish: createPull
      { status: 200, body: { pull_id: 'pr-200' } },
    ]);

    const adminCtx: SdkContext = {
      upstream: 'hop/wl',
      forkOrg: 'alice',
      rigHandle: 'alice',
      token: 'tok',
      isUpstreamAdmin: true,
    };
    const result = await acceptViaSdk(
      adminCtx,
      {
        itemId: 'w-1',
        submitterRigHandle: 'charlie',
        submitterForkOwner: 'charlie',
        completionId: 'c-w-1-charlie-abc123',
        evidence: 'https://github.com/x/y/pull/77',
        quality: 'good',
        reliability: 'good',
        severity: 'leaf',
        message: 'nice work',
      },
      fetch
    );
    expect(result.success).toBe(true);
    expect(result.pr_url).toContain('pr-200');
    expect(result.pr_id).toBe('pr-200');

    const writes = calls.filter(c => c.method === 'POST' && c.url.includes('/write/'));
    // Five accept-upstream statements → five writes.
    expect(writes).toHaveLength(5);
    // Adoption commits must land on the admin's branch, not the submitter's.
    expect(writes.every(w => w.url.includes('/alice/wl/write/'))).toBe(true);
    expect(writes.every(w => w.url.includes('wl%2Falice%2Fw-1'))).toBe(true);
  });

  it('refuses to stamp yourself when admin == submitter', async () => {
    const { fetch } = makeFetch([]);
    await expect(
      acceptViaSdk(
        baseCtx,
        {
          itemId: 'w-1',
          submitterRigHandle: 'alice',
          submitterForkOwner: 'alice',
          completionId: 'c-w-1-alice-abc',
          evidence: 'https://x/y',
          quality: 'good',
        },
        fetch
      )
    ).rejects.toThrow(/cannot issue a stamp to yourself/);
  });

  it('reads completion id and evidence from the submitter fork when not pre-resolved', async () => {
    const { fetch, calls } = makeFetch([
      // adapter's readLatestCompletion on charlie's fork — single row read
      // returns both id + evidence so the SDK can skip its own re-read.
      readRows([{ id: 'c-w-1-charlie-abc123', evidence: 'https://github.com/x/y/pull/77' }]),
      // applyMutation: idempotency read on admin's branch
      readRows([fixtureWantedRow({ id: 'w-1', status: 'in_review' })]),
      // fork-currency preamble: not stale
      ...forkCurrentResponses(),
      syncWriteOk(),
      syncWriteOk(),
      syncWriteOk(),
      syncWriteOk(),
      syncWriteOk(),
      // cleanup compare
      readRows([fixtureWantedRow({ id: 'w-1', status: 'in_review' })]),
      readRows([fixtureWantedRow({ id: 'w-1', status: 'completed' })]),
      // publish: listPulls fanout (open/merged/closed) → all empty,
      // then read branch row for title, then createPull.
      ...publishNoExistingPull(),
      readRows([fixtureWantedRow({ id: 'w-1', status: 'completed' })]),
      { status: 200, body: { pull_id: 'pr-201' } },
    ]);

    const adminCtx: SdkContext = {
      upstream: 'hop/wl',
      forkOrg: 'alice',
      rigHandle: 'alice',
      token: 'tok',
      isUpstreamAdmin: true,
    };
    const result = await acceptViaSdk(
      adminCtx,
      {
        itemId: 'w-1',
        submitterRigHandle: 'charlie',
        submitterForkOwner: 'charlie',
        // completionId NOT pre-resolved
        quality: 'good',
      },
      fetch
    );
    expect(result.pr_id).toBe('pr-201');

    // The first read must hit charlie's fork, not alice's, because
    // the worker's branch lives on the worker's fork. URL shape:
    //   /api/v1alpha1/<forkOwner>/<forkDb>/<branch>?q=…
    expect(calls[0].url).toContain('/charlie/wl/');
    // And the ref segment targets the worker's branch.
    expect(calls[0].url).toContain('wl%2Fcharlie%2Fw-1');
  });

  it('throws PRECONDITION_FAILED when no completion exists on the submitter branch', async () => {
    const { fetch } = makeFetch([readRows([])]);
    const adminCtx: SdkContext = {
      upstream: 'hop/wl',
      forkOrg: 'alice',
      rigHandle: 'alice',
      token: 'tok',
      isUpstreamAdmin: true,
    };
    await expect(
      acceptViaSdk(
        adminCtx,
        {
          itemId: 'w-missing',
          submitterRigHandle: 'charlie',
          submitterForkOwner: 'charlie',
          quality: 'good',
        },
        fetch
      )
    ).rejects.toThrow(/no completion found/);
  });
});

// ── rejectViaSdk ────────────────────────────────────────────────────────

describe('rejectViaSdk', () => {
  it('runs reject DMLs and returns success', async () => {
    const { fetch, calls } = makeFetch([
      readRows([fixtureWantedRow({ id: 'w-1', status: 'in_review' })]),
      ...forkCurrentResponses(),
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
      ...forkCurrentResponses(),
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
