/**
 * Tests for the {@link WlClient} class.
 *
 * These tests do NOT re-cover every op — the per-op tests already do
 * that. The goal here is to verify the wiring:
 *
 *  - Constructor input validation.
 *  - Method delegation produces the same DoltHub calls as calling the
 *    op directly.
 *  - `onRequest` / `onError` hooks fire as documented.
 *  - Errors thrown by ops bubble up through `unwrap`.
 */

import { describe, expect, it } from 'vitest';
import { WlClient, type WlClientConfig } from './client';
import { WlError } from './ops/types';
import { claim } from './ops/claim';
import {
  fixtureWantedRow,
  forkCurrentResponses,
  makeFetch,
  readWantedRow,
  syncWriteOk,
  type MockResponse,
} from './ops/test-helpers';

function makeConfig(overrides: Partial<WlClientConfig> = {}): WlClientConfig {
  return {
    upstream: 'hop/wl',
    forkOrg: 'alice',
    rigHandle: 'alice',
    token: 'tok',
    ...overrides,
  };
}

describe('WlClient constructor', () => {
  it('accepts a valid config and parses upstream', () => {
    const c = new WlClient(makeConfig());
    expect(c.upstream).toEqual({ owner: 'hop', db: 'wl' });
    expect(c.fork).toEqual({ forkOwner: 'alice', forkDb: 'wl' });
    expect(c.rigHandle).toBe('alice');
  });

  it('throws when upstream is missing', () => {
    expect(() => new WlClient(makeConfig({ upstream: '' }))).toThrow(WlError);
  });

  it('throws when upstream lacks owner/db separator', () => {
    expect(() => new WlClient(makeConfig({ upstream: 'hop-wl' }))).toThrow(/owner\/db/);
  });

  it('throws when upstream has a trailing slash', () => {
    expect(() => new WlClient(makeConfig({ upstream: 'hop/' }))).toThrow(/owner\/db/);
  });

  it('throws when forkOrg is missing', () => {
    expect(() => new WlClient(makeConfig({ forkOrg: '' }))).toThrow(/forkOrg/);
  });

  it('throws when rigHandle is missing', () => {
    expect(() => new WlClient(makeConfig({ rigHandle: '' }))).toThrow(/rigHandle/);
  });

  it('throws when token is missing', () => {
    expect(() => new WlClient(makeConfig({ token: '' }))).toThrow(/token/);
  });
});

describe('WlClient.claim', () => {
  it('produces the same DoltHub calls as ops/claim directly', async () => {
    // Two mock fetches with identical scripted responses; one driven
    // by the class, one by the free function.
    const responses = (): MockResponse[] => [
      readWantedRow(null),
      ...forkCurrentResponses(),
      syncWriteOk(),
      readWantedRow(fixtureWantedRow({ id: 'w-1', status: 'open' })),
      readWantedRow(fixtureWantedRow({ id: 'w-1', status: 'claimed', claimed_by: 'alice' })),
    ];

    const { fetch: classFetch, calls: classCalls } = makeFetch(responses());
    const c = new WlClient(makeConfig({ fetch: classFetch }));
    const classResult = await c.claim('w-1');

    const { fetch: opFetch, calls: opCalls } = makeFetch(responses());
    const opResult = await claim({
      ctx: {
        auth: { token: 'tok' },
        upstream: { owner: 'hop', db: 'wl' },
        fork: { forkOwner: 'alice', forkDb: 'wl' },
        rigHandle: 'alice',
        fetch: opFetch,
      },
      wantedId: 'w-1',
    });

    expect(opResult.ok).toBe(true);
    if (!opResult.ok) return;
    expect(classResult).toEqual(opResult.data);

    expect(classCalls.length).toBe(opCalls.length);
    for (let i = 0; i < classCalls.length; i++) {
      expect(classCalls[i].method).toBe(opCalls[i].method);
      expect(classCalls[i].url).toBe(opCalls[i].url);
      expect(classCalls[i].body).toBe(opCalls[i].body);
    }
  });
});

describe('WlClient hooks', () => {
  it('onRequest fires for every DoltHub fetch', async () => {
    const seen: { method: string; url: string }[] = [];
    const { fetch: f } = makeFetch([
      readWantedRow(null),
      ...forkCurrentResponses(),
      syncWriteOk(),
      readWantedRow(fixtureWantedRow({ id: 'w-1', status: 'open' })),
      readWantedRow(fixtureWantedRow({ id: 'w-1', status: 'claimed', claimed_by: 'alice' })),
    ]);
    const c = new WlClient(
      makeConfig({
        fetch: f,
        onRequest: req => seen.push(req),
      })
    );
    await c.claim('w-1');
    // 1 idempotency read + 2 stale-fork reads + 1 write + 2 cleanup reads = 6.
    expect(seen.length).toBe(6);
    // First call is the idempotency read against the fork branch.
    expect(seen[0].method).toBe('GET');
    expect(seen[0].url).toContain('/alice/wl/');
    // Calls 1-2 are the stale-fork guard's HASHOF reads.
    expect(seen[1].url).toContain('HASHOF');
    expect(seen[2].url).toContain('HASHOF');
    // Third call is the write.
    expect(seen[3].method).toBe('POST');
    expect(seen[3].url).toContain('/alice/wl/write/main/');
  });

  it('onError fires when DoltHub returns a non-2xx response', async () => {
    const errors: unknown[] = [];
    const { fetch: f } = makeFetch([
      // Idempotency-check read: empty rows so the write proceeds.
      readWantedRow(null),
      // Write fails 500.
      { status: 500, body: { error: 'kaboom' } },
    ]);
    const c = new WlClient(
      makeConfig({
        fetch: f,
        onError: err => errors.push(err),
      })
    );
    await expect(c.claim('w-1')).rejects.toBeInstanceOf(WlError);

    // Two onError invocations expected: one from the doltFetch
    // hook (HTTP 500), one from unwrap (the WlError surfaced from
    // ops/claim's catch).
    expect(errors.length).toBeGreaterThanOrEqual(1);
    const httpErr = errors.find(
      (e): e is { status: number } => typeof e === 'object' && e !== null && 'status' in e
    );
    expect(httpErr?.status).toBe(500);
  });
});

describe('WlClient.publish error path', () => {
  it('a missing branch surfaces as a WlError when createPull fails', async () => {
    // listPulls → empty (no existing PR).
    // readWantedRowAt → branch missing (404 → handled inside as null
    //                  via the branch read swallowing zero rows).
    // createPull → 404 (branch doesn't exist on the fork).
    const { fetch: f } = makeFetch([
      { status: 200, body: { pulls: [] } },
      // Branch read for the title — empty rows.
      readWantedRow(null),
      // createPull fails.
      { status: 404, body: { error: 'branch not found' } },
    ]);
    const c = new WlClient(makeConfig({ fetch: f }));
    let caught: unknown;
    try {
      await c.publish('w-missing');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WlError);
    if (!(caught instanceof WlError)) return;
    expect(caught.code).toBe('upstream');
  });
});

describe('WlClient.publish happy path', () => {
  it('returns { prUrl, prId } using the plan-named result shape', async () => {
    const { fetch: f } = makeFetch([
      // listPulls(open) → empty
      { status: 200, body: { pulls: [] } },
      // branch HEAD + main HEAD — distinct so we fall through to
      // createPull (the matching-heads case is the no-op idempotency
      // path, not the create-new-PR path).
      { status: 200, body: { query_execution_status: 'Success', rows: [{ h: 'branch-head' }] } },
      { status: 200, body: { query_execution_status: 'Success', rows: [{ h: 'main-head' }] } },
      // read wanted row on branch for the title
      readWantedRow(fixtureWantedRow({ id: 'w-1', title: 'Fix flaky tests' })),
      // createPull
      { status: 200, body: { pull_id: '42' } },
    ]);
    const c = new WlClient(makeConfig({ fetch: f }));
    const result = await c.publish('w-1');
    expect(result.prId).toBe('42');
    expect(result.prUrl).toContain('/pulls/42');
    expect(result.prUrl).toContain('/hop/wl/');
  });
});

describe('WlClient.unpublish', () => {
  it('returns void when no open PR exists (no-op)', async () => {
    const { fetch: f } = makeFetch([
      // listPulls → empty
      { status: 200, body: { pulls: [] } },
    ]);
    const c = new WlClient(makeConfig({ fetch: f }));
    const result = await c.unpublish('w-1');
    expect(result).toBeUndefined();
  });
});

describe('WlClient.done', () => {
  it('accepts (wantedId, evidence) positional form and generates a completionId', async () => {
    const { fetch: f, calls } = makeFetch([
      // branch idempotency read: claimed
      readWantedRow(fixtureWantedRow({ status: 'claimed', claimed_by: 'alice' })),
      // fork-currency preamble: not stale
      ...forkCurrentResponses(),
      // statement 1: UPDATE wanted
      syncWriteOk(),
      // statement 2: INSERT IGNORE INTO completions
      syncWriteOk(),
      // upstream main row
      readWantedRow(fixtureWantedRow({ status: 'claimed', claimed_by: 'alice' })),
      // fork branch row after writes
      readWantedRow(fixtureWantedRow({ status: 'in_review', claimed_by: 'alice' })),
    ]);
    const c = new WlClient(makeConfig({ fetch: f }));
    const result = await c.done('w-1', 'https://example.com/pr/1');
    expect(result.completionId).toMatch(/^c-w-1-alice-[0-9a-f]{6}$/);
    // The second write inserts the completion row; URL query string
    // should include the generated completionId.
    const completionWrite = calls.filter(c => c.method === 'POST')[1];
    expect(decodeURIComponent(completionWrite.url)).toContain(result.completionId);
  });

  it('accepts (wantedId, input) form with explicit completionId', async () => {
    const { fetch: f } = makeFetch([
      readWantedRow(fixtureWantedRow({ status: 'claimed', claimed_by: 'alice' })),
      ...forkCurrentResponses(),
      syncWriteOk(),
      syncWriteOk(),
      readWantedRow(fixtureWantedRow({ status: 'claimed', claimed_by: 'alice' })),
      readWantedRow(fixtureWantedRow({ status: 'in_review', claimed_by: 'alice' })),
    ]);
    const c = new WlClient(makeConfig({ fetch: f }));
    const result = await c.done('w-1', {
      evidence: 'https://example.com/pr/1',
      completionId: 'c-explicit',
    });
    expect(result.completionId).toBe('c-explicit');
  });
});

describe('WlClient.accept', () => {
  it('accepts (wantedId, input) positional form', async () => {
    const { fetch: f, calls } = makeFetch([
      // branch status read: in_review
      readWantedRow(fixtureWantedRow({ status: 'in_review', claimed_by: 'bob' })),
      // fork-currency preamble: not stale
      ...forkCurrentResponses(),
      // 3 writes: INSERT stamp, UPDATE completion, UPDATE wanted
      syncWriteOk(),
      syncWriteOk(),
      syncWriteOk(),
      // cleanup reads
      readWantedRow(fixtureWantedRow({ status: 'in_review', claimed_by: 'bob' })),
      readWantedRow(fixtureWantedRow({ status: 'completed', claimed_by: 'bob' })),
    ]);
    const c = new WlClient(makeConfig({ fetch: f }));
    const result = await c.accept('w-1', {
      completionId: 'c-1',
      stamp: {
        id: 's-1',
        subject: 'bob',
        quality: 5,
        reliability: 5,
        severity: 'leaf',
      },
    });
    expect(result.stampId).toBe('s-1');
    // The first write inserts the stamp; its URL query should include the stamp id.
    const writes = calls.filter(c => c.method === 'POST' && c.url.includes('/write/'));
    expect(decodeURIComponent(writes[0].url)).toContain('s-1');
  });
});
