/**
 * Tests for the lifecycle-ops adapter (M2.7 join ceremony).
 *
 * Strategy mirrors `branch-ops.test.ts`: the inner `joinViaSdk`
 * accepts a pre-resolved {@link LifecycleOpsInnerContext} and an
 * injectable `fetch`, so each test drives the underlying wl-sdk at
 * the fetch boundary with a scripted response queue. Avoids dragging
 * the WastelandDO into the Node vitest pool.
 *
 * Coverage:
 *  - happy path: fork + registration write + PR creation
 *    produces a non-null PR URL and `alreadyJoined=false`.
 *  - idempotent path: fork already existed AND a registration PR is
 *    already open with the matching title → returns the existing PR
 *    URL and `alreadyJoined=true`.
 */

import { describe, expect, it } from 'vitest';
import { joinViaSdk, type LifecycleOpsInnerContext } from './lifecycle-ops-inner';

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

const baseCtx: LifecycleOpsInnerContext = {
  upstream: 'hop/wl',
  forkOrg: 'alice',
  rigHandle: 'alice',
  displayName: 'Alice',
  ownerEmail: 'alice@example.com',
  token: 'tok',
};

describe('joinViaSdk', () => {
  it('forks, writes registration, opens PR — returns PR URL and alreadyJoined=false', async () => {
    // SDK call sequence (see ops/join.ts):
    //   1. POST /fork → sync success body (no operation_name → no polling)
    //                   The SDK treats `status: 'Success'` as
    //                   `created: true` (forkResult.created).
    //   2. GET upstream rigs read (findRegisteredRig) — empty rows
    //   3. GET listPulls (open) — empty so we fall through to write+create
    //   4. POST /write registration on wl/register/alice
    //   5. POST /pulls → returns pull_id
    const { fetch, calls } = makeFetch([
      { status: 200, body: { status: 'Success' } },
      { status: 200, body: { query_execution_status: 'Success', rows: [] } },
      { status: 200, body: { pulls: [] } },
      { status: 200, body: { query_execution_status: 'Success' } },
      { status: 200, body: { pull_id: '42' } },
    ]);

    const result = await joinViaSdk(baseCtx, fetch);

    expect(result.forkOwner).toBe('alice');
    expect(result.forkRepo).toBe('wl');
    expect(result.rigHandle).toBe('alice');
    expect(result.registrationBranch).toBe('wl/register/alice');
    expect(result.registrationPullId).toBe('42');
    expect(result.registrationPullUrl).toContain('/hop/wl/pulls/42');
    expect(result.alreadyJoined).toBe(false);
    expect(result.forkUrl).toContain('/alice/wl');

    const writeCall = calls.find(
      c => c.method === 'POST' && c.url.includes('/alice/wl/write/main/wl%2Fregister%2Falice')
    );
    expect(writeCall).toBeDefined();
  });

  it('is idempotent when fork already exists and PR is open — returns existing PR and alreadyJoined=true', async () => {
    // Sequence when the fork already existed and a registration PR is
    // already open under the matching title:
    //   1. POST /fork → DoltHub returns a 2xx body with an "already
    //      exists" message, which `forkDatabase` resolves as
    //      `created: false` (see dolthub/database.ts).
    //   2. GET upstream rigs read (findRegisteredRig) — empty rows so
    //      we keep going down the PR-detection path.
    //   3. GET listPulls → returns the prior PR with matching title
    //                      "Register rig: alice"; we return it instead
    //                      of writing/opening another.
    const { fetch, calls } = makeFetch([
      { status: 200, body: { message: 'database already exists' } },
      { status: 200, body: { query_execution_status: 'Success', rows: [] } },
      {
        status: 200,
        body: {
          pulls: [
            {
              pull_id: '42',
              title: 'Register rig: alice',
              state: 'open',
              created_at: '2026-05-16T00:00:00Z',
              updated_at: '2026-05-16T00:00:00Z',
              creator_name: 'alice',
            },
          ],
        },
      },
      // read the token's own account → the org the caller claims.
      { status: 200, body: { status: 'Success', username: 'alice' } },
    ]);

    const result = await joinViaSdk(baseCtx, fetch);

    expect(result.alreadyJoined).toBe(true);
    expect(result.registrationPullId).toBe('42');
    expect(result.registrationPullUrl).toContain('/hop/wl/pulls/42');

    // Verify no second `POST /pulls` call was issued — the fourth
    // response (we only queued 3) would be served from the default
    // 500 fallback if the SDK tried.
    const createPullCalls = calls.filter(
      c => c.method === 'POST' && c.url.endsWith('/hop/wl/pulls')
    );
    expect(createPullCalls).toHaveLength(0);
  });

  it('accepts a re-join with a handle the caller already registered without any write', async () => {
    const { fetch, calls } = makeFetch([
      { status: 200, body: { message: 'database already exists' } },
      {
        status: 200,
        body: {
          query_execution_status: 'Success',
          rows: [{ handle: 'alice', dolthub_org: 'alice' }],
        },
      },
      { status: 200, body: { status: 'Success', username: 'alice' } },
    ]);

    const result = await joinViaSdk(baseCtx, fetch);

    expect(result.rigHandle).toBe('alice');
    expect(result.registrationPullId).toBeNull();
    expect(result.registrationPullUrl).toBeNull();
    expect(calls.some(c => c.url.includes('/write/'))).toBe(false);
  });

  it('refuses a handle registered by another org and reports a precondition failure', async () => {
    const { fetch, calls } = makeFetch([
      { status: 200, body: { message: 'database already exists' } },
      {
        status: 200,
        body: {
          query_execution_status: 'Success',
          rows: [{ handle: 'bob', dolthub_org: 'bob' }],
        },
      },
    ]);

    const ctx = { ...baseCtx, rigHandle: 'bob' };
    await expect(joinViaSdk(ctx, fetch)).rejects.toMatchObject({
      name: 'WantedBoardOpError',
      code: 'PRECONDITION_FAILED',
    });
    expect(calls.some(c => c.url.includes('/write/'))).toBe(false);
    expect(calls.some(c => c.url.includes('/pulls'))).toBe(false);
  });

  it('re-joins a connection made under an org whose proof the credential already holds', async () => {
    const { fetch, calls } = makeFetch([
      { status: 200, body: { message: 'database already exists' } },
      {
        status: 200,
        body: {
          query_execution_status: 'Success',
          rows: [{ handle: 'acme-tools', dolthub_org: 'acme' }],
        },
      },
    ]);

    const ctx = {
      ...baseCtx,
      forkOrg: 'acme',
      rigHandle: 'acme-tools',
      ownerEmail: 'bob@example.com',
      orgProven: true,
    };
    const result = await joinViaSdk(ctx, fetch);

    expect(result.alreadyJoined).toBe(true);
    expect(result.registrationPullId).toBeNull();
    expect(calls.some(c => c.url.includes('/write/'))).toBe(false);
    expect(calls.some(c => c.url.includes('/pulls'))).toBe(false);
    expect(calls.some(c => c.url.includes('/user'))).toBe(false);
  });

  it('refuses an org-based re-join until a verified flow records the org', async () => {
    const { fetch, calls } = makeFetch([
      { status: 200, body: { message: 'database already exists' } },
      {
        status: 200,
        body: {
          query_execution_status: 'Success',
          rows: [{ handle: 'acme-tools', dolthub_org: 'acme' }],
        },
      },
      { status: 200, body: { status: 'Success', username: 'bob' } },
    ]);

    const ctx = { ...baseCtx, forkOrg: 'acme', rigHandle: 'acme-tools' };
    await expect(joinViaSdk(ctx, fetch)).rejects.toMatchObject({
      name: 'WantedBoardOpError',
      code: 'PRECONDITION_FAILED',
    });
    expect(calls.some(c => c.url.includes('/write/'))).toBe(false);
  });

  it('reports an unrecognised fork response as an upstream failure', async () => {
    // The join hands the caller a rig identity when the fork is
    // confirmed under its org, so a body that confirms nothing — an
    // error envelope, an unknown status, a malformed error — must end
    // the join before it returns a handle to persist.
    for (const body of [
      { status: 'Error', message: 'user has no access to this owner' },
      { status: 'Unexpected' },
      { status: 'Error', error: { message: 'denied' } },
      { status: 'Pending', owner_name: 'alice', database_name: 'wl' },
      { status: 'Unexpected', owner_name: 'alice', database_name: 'wl' },
    ]) {
      const { fetch, calls } = makeFetch([{ status: 200, body }]);

      await expect(joinViaSdk(baseCtx, fetch)).rejects.toMatchObject({
        name: 'WantedBoardOpError',
        code: 'UPSTREAM_ERROR',
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain('/fork');
    }
  });
});
