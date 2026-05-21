import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  escapeSqlString,
  createDatabase,
  createBranch,
  listBranches,
  execWrite,
  mergeBranchIntoMain,
} from './dolthub-write';
import { DoltHubApiError } from '../util/dolthub-api.util';

/** Decode a stringified JSON body from a captured RequestInit. */
function readJsonBody(init: RequestInit | undefined): Record<string, unknown> {
  const body = init?.body;
  if (typeof body !== 'string') {
    throw new Error(`expected string body, got ${typeof body}`);
  }
  return z.record(z.string(), z.unknown()).parse(JSON.parse(body));
}

describe('escapeSqlString', () => {
  it('doubles single quotes', () => {
    expect(escapeSqlString("o'malley")).toBe("o''malley");
  });

  it('escapes backslashes', () => {
    expect(escapeSqlString('path\\to\\file')).toBe('path\\\\to\\\\file');
  });

  it('handles both at once (backslash applied first)', () => {
    expect(escapeSqlString("\\'")).toBe("\\\\''");
  });

  it('returns the input unchanged when no special chars', () => {
    expect(escapeSqlString('plain-handle_42')).toBe('plain-handle_42');
  });
});

describe('createDatabase', () => {
  const originalFetch = globalThis.fetch;
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('POSTs to /database with the expected body and returns created=true on success', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'Success',
          repository_owner: 'hop',
          repository_name: 'new-commons',
        }),
        { status: 200 }
      )
    );

    const result = await createDatabase('tok-1', { owner: 'hop', db: 'new-commons' });
    expect(result).toEqual({ created: true });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://www.dolthub.com/api/v1alpha1/database');
    expect(init.method).toBe('POST');
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('token tok-1');
    expect(headers.get('content-type')).toBe('application/json');
    expect(readJsonBody(init)).toEqual({
      ownerName: 'hop',
      repoName: 'new-commons',
      visibility: 'public',
    });
  });

  it('treats 409 as idempotent (created=false)', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'already exists' }), { status: 409 })
    );
    const result = await createDatabase('tok', { owner: 'a', db: 'b' });
    expect(result).toEqual({ created: false });
  });

  it('treats 4xx with "already exists" message as idempotent', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'database already exists' }), { status: 400 })
    );
    const result = await createDatabase('tok', { owner: 'a', db: 'b' });
    expect(result).toEqual({ created: false });
  });

  it('throws DoltHubApiError on other non-OK responses', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
    );
    await expect(createDatabase('tok', { owner: 'a', db: 'b' })).rejects.toBeInstanceOf(
      DoltHubApiError
    );
  });

  it("surfaces DoltHub's `message` field in the thrown error (400 envelope)", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'Error',
          message: 'private repos require a paid DoltHub account',
        }),
        { status: 400 }
      )
    );
    let caught: Error | null = null;
    try {
      await createDatabase('tok', { owner: 'a', db: 'b' });
    } catch (err) {
      caught = err instanceof Error ? err : new Error(String(err));
    }
    expect(caught).toBeInstanceOf(DoltHubApiError);
    expect(caught?.message).toContain('private repos require a paid DoltHub account');
  });

  it('treats a 200 response with status=Error as a failure (not idempotent success)', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'Error', message: 'something broke' }), { status: 200 })
    );
    await expect(createDatabase('tok', { owner: 'a', db: 'b' })).rejects.toBeInstanceOf(
      DoltHubApiError
    );
  });

  it('respects an explicit visibility option', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'Success' }), { status: 200 })
    );
    await createDatabase('tok', { owner: 'a', db: 'b', visibility: 'public' });
    const init = fetchSpy.mock.calls[0]?.[1];
    expect(readJsonBody(init).visibility).toBe('public');
  });
});

describe('listBranches', () => {
  const originalFetch = globalThis.fetch;
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns the branch_name field from each entry', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'Success',
          branches: [{ branch_name: 'main' }, { branch_name: 'feature-1' }],
        }),
        { status: 200 }
      )
    );
    const result = await listBranches('tok', { owner: 'hop', db: 'wl-commons' });
    expect(result).toEqual(['main', 'feature-1']);
  });

  it('returns [] when the response shape is unexpected', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ unexpected: true }), { status: 200 })
    );
    const result = await listBranches('tok', { owner: 'hop', db: 'wl-commons' });
    expect(result).toEqual([]);
  });

  it('throws DoltHubApiError on non-OK responses', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'Error', message: 'unauthorized' }), { status: 401 })
    );
    await expect(listBranches('tok', { owner: 'a', db: 'b' })).rejects.toBeInstanceOf(
      DoltHubApiError
    );
  });
});

describe('createBranch', () => {
  const originalFetch = globalThis.fetch;
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('POSTs the right revisionType/Name/newBranchName body', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'Success',
          new_branch_name: 'feature-1',
          revision_name: 'main',
        }),
        { status: 200 }
      )
    );
    const result = await createBranch('tok', {
      owner: 'hop',
      db: 'wl-commons',
      baseBranch: 'main',
      newBranch: 'feature-1',
    });
    expect(result).toEqual({ created: true });

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://www.dolthub.com/api/v1alpha1/hop/wl-commons/branches');
    expect(readJsonBody(init)).toEqual({
      revisionType: 'branch',
      revisionName: 'main',
      newBranchName: 'feature-1',
    });
  });

  it('treats "already exists" as idempotent (created=false)', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'Error', message: 'branch already exists' }), {
        status: 400,
      })
    );
    const result = await createBranch('tok', {
      owner: 'a',
      db: 'b',
      baseBranch: 'main',
      newBranch: 'feature',
    });
    expect(result).toEqual({ created: false });
  });
});

describe('execWrite', () => {
  const originalFetch = globalThis.fetch;
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('issues a single POST to the write API and returns immediately on synchronous success', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ query_execution_status: 'Success' }), { status: 200 })
    );

    const result = await execWrite('tok', {
      owner: 'hop',
      db: 'wl-commons',
      fromBranch: 'main',
      toBranch: 'main',
      sql: 'CREATE TABLE x (id INT)',
    });
    expect(result.committed).toBe(false);
    expect(result.status).toBe('Success');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://www.dolthub.com/api/v1alpha1/hop/wl-commons/write/main/main?q=CREATE%20TABLE%20x%20(id%20INT)'
    );
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('authorization')).toBe('token tok');
  });

  it('polls operation_name until done=true and reports committed=true on a real commit', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ operation_name: 'op-123' }), { status: 200 })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ done: false }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            done: true,
            res_details: {
              query_execution_status: 'Success',
              query_execution_message: 'Query OK, 1 row affected',
              from_commit_id: 'parent-commit',
              to_commit_id: 'new-commit',
            },
          }),
          { status: 200 }
        )
      );

    const result = await execWrite('tok', {
      owner: 'hop',
      db: 'wl-commons',
      fromBranch: 'main',
      toBranch: 'main',
      sql: 'INSERT INTO x VALUES (1)',
      timeoutMs: 5_000,
    });

    expect(result).toEqual({
      committed: true,
      fromCommitId: 'parent-commit',
      toCommitId: 'new-commit',
      status: 'Success',
      message: 'Query OK, 1 row affected',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('reports committed=false when DoltHub returns done=true but to_commit_id matches from_commit_id', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ operation_name: 'op-noop' }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            done: true,
            res_details: {
              query_execution_status: 'Success',
              from_commit_id: 'same-id',
              to_commit_id: 'same-id',
            },
          }),
          { status: 200 }
        )
      );

    const result = await execWrite('tok', {
      owner: 'hop',
      db: 'wl-commons',
      fromBranch: 'main',
      toBranch: 'main',
      sql: 'INSERT IGNORE INTO _meta VALUES ("k", "v")',
      timeoutMs: 5_000,
    });
    expect(result.committed).toBe(false);
    expect(result.status).toBe('Success');
  });

  it('throws on a write-API error envelope without polling', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          query_execution_status: 'Error',
          query_execution_message: 'syntax error',
        }),
        { status: 200 }
      )
    );

    await expect(
      execWrite('tok', {
        owner: 'hop',
        db: 'wl-commons',
        fromBranch: 'main',
        toBranch: 'main',
        sql: 'BROKEN',
      })
    ).rejects.toBeInstanceOf(DoltHubApiError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('throws on an Error status surfaced through the poll loop', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ operation_name: 'op-err' }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            done: true,
            res_details: { query_execution_status: 'Error', query_execution_message: 'conflict' },
          }),
          { status: 200 }
        )
      );

    let caught: Error | null = null;
    try {
      await execWrite('tok', {
        owner: 'hop',
        db: 'wl-commons',
        fromBranch: 'main',
        toBranch: 'main',
        sql: 'INSERT INTO x VALUES (1)',
        timeoutMs: 5_000,
      });
    } catch (err) {
      caught = err instanceof Error ? err : new Error(String(err));
    }
    expect(caught).toBeInstanceOf(DoltHubApiError);
    expect(caught?.message).toContain('conflict');
  });

  it('fails fast on a 4xx poll response and surfaces the response body', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ operation_name: 'op-bad' }), { status: 200 })
      )
      .mockResolvedValueOnce(new Response('branch not found: main', { status: 400 }));

    let caught: Error | null = null;
    try {
      await execWrite('tok', {
        owner: 'hop',
        db: 'wl-commons',
        fromBranch: 'main',
        toBranch: 'main',
        sql: 'CREATE TABLE x (id INT)',
        timeoutMs: 30_000,
      });
    } catch (err) {
      caught = err instanceof Error ? err : new Error(String(err));
    }
    expect(caught).toBeInstanceOf(DoltHubApiError);
    expect(caught?.message).toContain('branch not found');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('treats a bare-text sqlwrite.toCommitId 400 as a committed=false no-op', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ operation_name: 'op-noop' }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response('sqlwrite.toCommitId is null: nothing to commit', { status: 400 })
      );

    const result = await execWrite('tok', {
      owner: 'hop',
      db: 'wl-commons',
      fromBranch: 'main',
      toBranch: 'main',
      sql: 'INSERT IGNORE INTO _meta VALUES ("k", "v")',
      timeoutMs: 5_000,
    });
    expect(result.committed).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('throws when the sqlwrite.toCommitId 400 carries a JSON error envelope', async () => {
    // DoltHub sometimes returns the toCommitId rejection wrapped in
    // an operation envelope with `query_execution_status: "Error"`.
    // That's a real failure (e.g. parent branch doesn't exist on a
    // freshly-created repo) and must not be swallowed as a no-op.
    fetchSpy
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ operation_name: 'op-real-err' }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            query_execution_status: 'Error',
            query_execution_message:
              'Cannot return null for non-nullable field SqlWrite.toCommitId.',
            operation_name: 'users/test/userOperations/abc',
          }),
          { status: 400 }
        )
      );

    let caught: Error | null = null;
    try {
      await execWrite('tok', {
        owner: 'hop',
        db: 'wl-commons',
        fromBranch: 'main',
        toBranch: 'bootstrap',
        sql: 'CREATE TABLE x (id INT)',
        timeoutMs: 5_000,
      });
    } catch (err) {
      caught = err instanceof Error ? err : new Error(String(err));
    }
    expect(caught).toBeInstanceOf(DoltHubApiError);
    expect(caught?.message).toContain('Cannot return null');
  });
});

describe('mergeBranchIntoMain', () => {
  const originalFetch = globalThis.fetch;
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('POSTs to /write/{from}/{to} with no query string and polls the operation', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ operation_name: 'merge-op' }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            done: true,
            res_details: {
              query_execution_status: 'Success',
              from_commit_id: 'a',
              to_commit_id: 'b',
            },
          }),
          { status: 200 }
        )
      );

    const result = await mergeBranchIntoMain('tok', {
      owner: 'hop',
      db: 'wl-commons',
      fromBranch: 'bootstrap',
      toBranch: 'main',
      timeoutMs: 5_000,
    });
    expect(result.committed).toBe(true);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://www.dolthub.com/api/v1alpha1/hop/wl-commons/write/bootstrap/main');
    expect(init.method).toBe('POST');
  });
});
