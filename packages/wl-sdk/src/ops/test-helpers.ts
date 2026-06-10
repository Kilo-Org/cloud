/**
 * Test-only helpers for wl-sdk ops tests.
 *
 * Patterns mirror `src/dolthub/*.test.ts` so tests at this layer feel
 * familiar: a `MockResponse` queue, a `makeFetch` factory that records
 * call URLs/methods/bodies, and small builders that match each
 * DoltHub endpoint.
 *
 * NOTE: this file lives next to test files but is not itself a test
 * (no `.test.ts` suffix). Vitest's `include` pattern only picks up
 * `*.test.ts`, so this file is shared infrastructure.
 */

export type MockResponse = {
  status: number;
  body?: unknown;
  text?: string;
};

export type FetchCall = {
  url: string;
  method: string;
  body: string | null;
  headers: Record<string, string>;
};

export function makeFetch(responses: MockResponse[]): {
  fetch: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let i = 0;
  const fakeFetch = ((url: string | URL | Request, init?: RequestInit) => {
    const stringUrl = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : null;
    const headers: Record<string, string> = {};
    const initHeaders = init?.headers;
    if (initHeaders) {
      if (initHeaders instanceof Headers) {
        initHeaders.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
      } else if (Array.isArray(initHeaders)) {
        for (const [k, v] of initHeaders) headers[k.toLowerCase()] = v;
      } else {
        for (const [k, v] of Object.entries(initHeaders)) {
          headers[k.toLowerCase()] = String(v);
        }
      }
    }
    calls.push({ url: stringUrl, method, body, headers });
    const r = responses[i++] ?? { status: 500, body: { error: 'no more responses' } };
    const text = r.text ?? (r.body !== undefined ? JSON.stringify(r.body) : '');
    return Promise.resolve(new Response(text, { status: r.status }));
  }) as unknown as typeof fetch;
  return { fetch: fakeFetch, calls };
}

/** Build a synchronous-write success response (no operation_name). */
export function syncWriteOk(): MockResponse {
  return { status: 200, body: { query_execution_status: 'Success' } };
}

/** Read response carrying a single wanted row at the given status. */
export function readWantedRow(row: Record<string, unknown> | null): MockResponse {
  return {
    status: 200,
    body: {
      query_execution_status: 'Success',
      rows: row === null ? [] : [row],
    },
  };
}

/**
 * Build a HASHOF row (`{ rows: [{ h: '<hash>' }] }`) — the shape
 * `readBranchHead` reads. Used by the matched-pair fork-currency
 * preamble below; tests can also stamp a custom hash for drift cases.
 */
export function readBranchHead(hash: string): MockResponse {
  return {
    status: 200,
    body: {
      query_execution_status: 'Success',
      rows: [{ h: hash }],
    },
  };
}

/**
 * Helper that produces the two `readBranchHead` responses
 * `applyMutation`'s `assertForkMainCurrent` consumes — upstream main
 * HEAD followed by fork main HEAD. Default: both equal (fork is
 * current). Pass `{ drift: true }` to make them differ so the
 * stale-fork guard fires.
 */
export function forkCurrentResponses(opts: { drift?: boolean } = {}): MockResponse[] {
  return [
    readBranchHead('upstream-head'),
    readBranchHead(opts.drift ? 'fork-head' : 'upstream-head'),
  ];
}

/** A populated wanted row fixture. */
export function fixtureWantedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
