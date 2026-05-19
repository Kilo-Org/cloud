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

const baseCtx: LifecycleOpsInnerContext = {
  upstream: 'hop/wl',
  forkOrg: 'alice',
  rigHandle: 'alice',
  displayName: 'Alice',
  ownerEmail: 'alice@example.com',
  token: 'tok',
};

// ── Tests ────────────────────────────────────────────────────────────────

describe('joinViaSdk', () => {
  it('forks, writes registration, opens PR — returns PR URL and alreadyJoined=false', async () => {
    // SDK call sequence (see ops/join.ts):
    //   1. POST /fork → sync success body (no operation_name → no polling)
    //                   The SDK treats `status: 'Success'` as
    //                   `created: true` (forkResult.created).
    //   2. GET upstream rigs read (rigAlreadyRegistered) — empty rows
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

    // Sanity: the registration write hit the right branch endpoint.
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
    //   2. GET upstream rigs read (rigAlreadyRegistered) — empty rows so
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
});
