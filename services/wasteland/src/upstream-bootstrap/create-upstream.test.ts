import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createUpstream, CreateUpstreamError } from './create-upstream';

/** Decode a stringified JSON body from a captured RequestInit. */
function readJsonBody(init: RequestInit | undefined): Record<string, unknown> {
  const body = init?.body;
  if (typeof body !== 'string') {
    throw new Error(`expected string body, got ${typeof body}`);
  }
  return z.record(z.string(), z.unknown()).parse(JSON.parse(body));
}

/**
 * Filter out poll-loop GET calls so the test can reason about the
 * write API POSTs by index regardless of how many polls fire per
 * write.
 */
function writeApiPosts(calls: readonly unknown[][]): Array<[string, RequestInit]> {
  return calls.filter(
    (call): call is [string, RequestInit] =>
      typeof call[0] === 'string' &&
      call[0].includes('/write/') &&
      (call[1] as RequestInit | undefined)?.method === 'POST'
  );
}

/**
 * Integration-style test for the bootstrap orchestration. Stubs
 * `fetch` and asserts that the right DoltHub endpoints are hit, in
 * the right order, with the right SQL.
 *
 * The 30s suite-level timeout accommodates `pollWriteOperation`'s
 * 500ms initial backoff: a full bootstrap is 1 create + 10 schema
 * statements + 1 wasteland_name + 1 rig + 1 merge (≈13 polls × 500ms).
 * Real DoltHub timing isn't being asserted here — only call ordering
 * and bodies.
 */
describe('createUpstream', { timeout: 30_000 }, () => {
  const originalFetch = globalThis.fetch;
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** Mock the `POST /database` create-database call. */
  function mockCreateDatabase(opts: { exists?: boolean } = {}) {
    if (opts.exists) {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'already exists' }), { status: 409 })
      );
    } else {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'Success' }), { status: 200 })
      );
    }
  }

  /**
   * Queue a successful async write+poll pair: the initial POST returns
   * an `operation_name`, the immediate GET poll resolves with
   * `done: true`, status=Success, and distinct commit IDs so the
   * orchestrator sees `committed: true`. Each call adds two fetch
   * mocks to the queue (one POST, one poll).
   */
  let mockedWriteCount = 0;
  function mockSuccessfulWrite() {
    const opName = `op-${mockedWriteCount++}`;
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ operation_name: opName }), { status: 200 })
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          done: true,
          res_details: {
            query_execution_status: 'Success',
            from_commit_id: `from-${opName}`,
            to_commit_id: `to-${opName}`,
          },
        }),
        { status: 200 }
      )
    );
  }

  /** Mock the diagnostic `GET /branches` call at the end of bootstrap. */
  function mockListBranches(branches: string[] = ['main', 'bootstrap']) {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'Success',
          branches: branches.map(name => ({ branch_name: name })),
        }),
        { status: 200 }
      )
    );
  }

  it('creates the database, applies each schema statement onto bootstrap, registers the rig, and merges to main', async () => {
    // 1 create + 10 schema + 1 wasteland_name + 1 rig + 1 merge + 1 list-branches.
    mockCreateDatabase();
    for (let i = 0; i < 10; i++) mockSuccessfulWrite();
    mockSuccessfulWrite(); // wasteland_name
    mockSuccessfulWrite(); // rig
    mockSuccessfulWrite(); // merge
    mockListBranches();

    const result = await createUpstream({
      upstream: 'hop/wl-commons',
      token: 'oauth-1',
      rigHandle: 'polecat',
      rigDisplayName: 'Polecat',
      ownerEmail: 'john@example.com',
      dolthubOrg: 'hop',
      wastelandName: 'My Wasteland',
    });

    expect(result.databaseCreated).toBe(true);

    // First call: create-database POST.
    const createCall = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(createCall[0]).toBe('https://www.dolthub.com/api/v1alpha1/database');
    expect(readJsonBody(createCall[1])).toEqual({
      ownerName: 'hop',
      repoName: 'wl-commons',
      visibility: 'public',
    });

    const writes = writeApiPosts(fetchSpy.mock.calls);
    expect(writes).toHaveLength(13);

    // First schema write: from=main, to=bootstrap (creates the branch).
    expect(writes[0][0]).toMatch(
      /^https:\/\/www\.dolthub\.com\/api\/v1alpha1\/hop\/wl-commons\/write\/main\/bootstrap\?q=/
    );

    // Subsequent schema writes: from=bootstrap, to=bootstrap.
    expect(writes[1][0]).toMatch(
      /^https:\/\/www\.dolthub\.com\/api\/v1alpha1\/hop\/wl-commons\/write\/bootstrap\/bootstrap\?q=/
    );

    // Last write: merge bootstrap into main, no query string.
    const mergeWrite = writes.at(-1) as [string, RequestInit];
    expect(mergeWrite[0]).toBe(
      'https://www.dolthub.com/api/v1alpha1/hop/wl-commons/write/bootstrap/main'
    );

    // Second-to-last write: rig insert onto bootstrap.
    const rigWrite = writes.at(-2) as [string, RequestInit];
    expect(rigWrite[0]).toMatch(
      /^https:\/\/www\.dolthub\.com\/api\/v1alpha1\/hop\/wl-commons\/write\/bootstrap\/bootstrap\?q=/
    );
    const rigSql = decodeURIComponent(new URL(rigWrite[0]).searchParams.get('q') ?? '');
    expect(rigSql).toContain('INSERT INTO rigs');
    expect(rigSql).toContain("'polecat'");
    expect(rigSql).toContain("'Polecat'");
    expect(rigSql).toContain("'hop'");
    expect(rigSql).toContain("'hop://john@example.com/polecat/'");
    expect(rigSql).toContain("'john@example.com'");
    expect(rigSql).toContain('1, NOW(), NOW()');
    expect(rigSql).toContain('ON DUPLICATE KEY UPDATE');

    // Third-to-last: wasteland_name insert.
    const nameWrite = writes.at(-3) as [string, RequestInit];
    const nameSql = decodeURIComponent(new URL(nameWrite[0]).searchParams.get('q') ?? '');
    expect(nameSql).toContain('INSERT IGNORE INTO _meta');
    expect(nameSql).toContain("'wasteland_name'");
    expect(nameSql).toContain("'My Wasteland'");
  });

  it('omits the wasteland_name write when no name is provided', async () => {
    mockCreateDatabase();
    for (let i = 0; i < 10; i++) mockSuccessfulWrite();
    mockSuccessfulWrite(); // rig
    mockSuccessfulWrite(); // merge
    mockListBranches();

    await createUpstream({
      upstream: 'hop/wl-commons',
      token: 'oauth-1',
      rigHandle: 'polecat',
      ownerEmail: 'john@example.com',
      dolthubOrg: 'hop',
    });

    const writes = writeApiPosts(fetchSpy.mock.calls);
    // 10 schema + 1 rig + 1 merge = 12 (no wasteland_name).
    expect(writes).toHaveLength(12);
  });

  it('treats an existing database as idempotent and still applies schema + rig', async () => {
    mockCreateDatabase({ exists: true });
    for (let i = 0; i < 10; i++) mockSuccessfulWrite();
    mockSuccessfulWrite(); // rig
    mockSuccessfulWrite(); // merge
    mockListBranches();

    const result = await createUpstream({
      upstream: 'hop/wl-commons',
      token: 'oauth-1',
      rigHandle: 'polecat',
      ownerEmail: 'john@example.com',
      dolthubOrg: 'hop',
    });

    expect(result.databaseCreated).toBe(false);
  });

  it('escapes single quotes in rig fields to avoid SQL injection', async () => {
    mockCreateDatabase();
    for (let i = 0; i < 10; i++) mockSuccessfulWrite();
    mockSuccessfulWrite(); // rig
    mockSuccessfulWrite(); // merge
    mockListBranches();

    await createUpstream({
      upstream: 'hop/wl-commons',
      token: 'oauth-1',
      rigHandle: "o'malley",
      ownerEmail: 'john@example.com',
      dolthubOrg: 'hop',
    });

    const writes = writeApiPosts(fetchSpy.mock.calls);
    // Rig is second-to-last (merge is last).
    const rigWrite = writes.at(-2) as [string, RequestInit];
    const sql = decodeURIComponent(new URL(rigWrite[0]).searchParams.get('q') ?? '');
    expect(sql).toContain("'o''malley'");
    expect(sql).not.toContain("'o'malley'");
  });

  it('throws CreateUpstreamError tagged apply-schema when a schema write returns an error envelope', async () => {
    mockCreateDatabase();
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          query_execution_status: 'Error',
          query_execution_message: 'broken',
        }),
        { status: 200 }
      )
    );

    await expect(
      createUpstream({
        upstream: 'hop/wl-commons',
        token: 'oauth-1',
        rigHandle: 'polecat',
        ownerEmail: 'john@example.com',
        dolthubOrg: 'hop',
      })
    ).rejects.toMatchObject({ stage: 'apply-schema' });
  });

  it('throws when DoltHub silently no-ops every schema statement on a freshly-created database', async () => {
    mockCreateDatabase();
    for (let i = 0; i < 10; i++) {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ operation_name: `op-${i}` }), { status: 200 })
      );
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            done: true,
            res_details: {
              query_execution_status: 'Success',
              from_commit_id: 'same',
              to_commit_id: 'same',
            },
          }),
          { status: 200 }
        )
      );
    }

    await expect(
      createUpstream({
        upstream: 'hop/wl-commons',
        token: 'oauth-1',
        rigHandle: 'polecat',
        ownerEmail: 'john@example.com',
        dolthubOrg: 'hop',
      })
    ).rejects.toMatchObject({ stage: 'apply-schema' });
  });

  it('throws when the rig INSERT returns no commit', async () => {
    mockCreateDatabase();
    for (let i = 0; i < 10; i++) mockSuccessfulWrite();
    // Rig insert: done=true but no commit IDs (committed=false).
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ operation_name: 'op-rig' }), { status: 200 })
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          done: true,
          res_details: { query_execution_status: 'Success' },
        }),
        { status: 200 }
      )
    );

    await expect(
      createUpstream({
        upstream: 'hop/wl-commons',
        token: 'oauth-1',
        rigHandle: 'polecat',
        ownerEmail: 'john@example.com',
        dolthubOrg: 'hop',
      })
    ).rejects.toMatchObject({ stage: 'register-rig' });
  });

  it('throws CreateUpstreamError on parse failure for a malformed upstream', async () => {
    await expect(
      createUpstream({
        upstream: 'no-slash',
        token: 'oauth-1',
        rigHandle: 'polecat',
        ownerEmail: 'john@example.com',
        dolthubOrg: 'hop',
      })
    ).rejects.toBeInstanceOf(CreateUpstreamError);
  });
});
