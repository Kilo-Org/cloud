import { describe, expect, it } from 'vitest';
import { join } from './join';
import { makeFetch, syncWriteOk, type MockResponse } from './test-helpers';

describe('join', () => {
  it('forks, writes registration, opens PR', async () => {
    const responses: MockResponse[] = [
      // POST /fork → sync success (no operation_name → no polling)
      { status: 200, body: { status: 'Success' } },
      // read upstream rigs → not registered
      { status: 200, body: { query_execution_status: 'Success', rows: [] } },
      // GET listPulls (for existing-PR check) → empty
      { status: 200, body: { pulls: [] } },
      // POST /write registration
      syncWriteOk(),
      // POST /pulls → returns pull_id
      { status: 200, body: { pull_id: '42' } },
    ];
    const { fetch: f, calls } = makeFetch(responses);
    const result = await join({
      auth: { token: 't' },
      upstream: { owner: 'hop', db: 'wl' },
      dolthubOrg: 'alice',
      rigHandle: 'alice',
      displayName: 'Alice the rig',
      ownerEmail: 'alice@example.com',
      version: '0.1.0',
      fetch: f,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.forkCreated).toBe(true);
    expect(result.data.branchName).toBe('wl/register/alice');
    expect(result.data.registrationPullId).toBe('42');
    expect(result.data.registrationPrUrl).toContain('/hop/wl/pulls/42');
    // Validate the call sequence.
    expect(calls[0].url).toContain('/fork');
    expect(calls[3].url).toContain('/alice/wl/write/main/wl%2Fregister%2Falice');
    expect(calls[4].method).toBe('POST');
    expect(calls[4].url).toContain('/hop/wl/pulls');
  });

  it('returns success with empty PR fields when PR creation fails', async () => {
    const responses: MockResponse[] = [
      { status: 200, body: { status: 'Success' } },
      { status: 200, body: { query_execution_status: 'Success', rows: [] } },
      { status: 200, body: { pulls: [] } },
      syncWriteOk(),
      // PR creation fails
      { status: 500, body: { error: 'whoops' } },
    ];
    const { fetch: f } = makeFetch(responses);
    const result = await join({
      auth: { token: 't' },
      upstream: { owner: 'hop', db: 'wl' },
      dolthubOrg: 'alice',
      rigHandle: 'alice',
      displayName: 'Alice',
      ownerEmail: 'alice@example.com',
      version: '0.1.0',
      fetch: f,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.registrationPullId).toBe('');
    expect(result.data.registrationPrUrl).toBe('');
  });

  it('does not rewrite registration when a registration PR is already open', async () => {
    const responses: MockResponse[] = [
      // POST /fork → sync success (the registration PR still makes the
      // write superfluous for this join call).
      { status: 200, body: { status: 'Success' } },
      // read upstream rigs → not registered
      { status: 200, body: { query_execution_status: 'Success', rows: [] } },
      // GET listPulls (for existing-PR check) → existing registration PR.
      {
        status: 200,
        body: { pulls: [{ pull_id: '42', title: 'Register rig: alice', state: 'open' }] },
      },
    ];
    const { fetch: f, calls } = makeFetch(responses);
    const result = await join({
      auth: { token: 't' },
      upstream: { owner: 'hop', db: 'wl' },
      dolthubOrg: 'alice',
      rigHandle: 'alice',
      displayName: 'Alice',
      ownerEmail: 'alice@example.com',
      version: '0.1.0',
      fetch: f,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.forkCreated).toBe(true);
    expect(result.data.registrationPullId).toBe('42');
    expect(calls).toHaveLength(3);
    expect(calls.some(c => c.url.includes('/write/'))).toBe(false);
  });

  it('does not rewrite registration when the rig is already on upstream main', async () => {
    const responses: MockResponse[] = [
      // POST /fork → already existed.
      { status: 400, body: { error: 'fork already exists under alice' } },
      // read upstream rigs → already registered by the caller's org.
      {
        status: 200,
        body: {
          query_execution_status: 'Success',
          rows: [{ handle: 'alice', dolthub_org: 'alice' }],
        },
      },
      // read the token's own account → the org above.
      { status: 200, body: { status: 'Success', username: 'alice' } },
    ];
    const { fetch: f, calls } = makeFetch(responses);
    const result = await join({
      auth: { token: 't' },
      upstream: { owner: 'hop', db: 'wl' },
      dolthubOrg: 'alice',
      rigHandle: 'alice',
      displayName: 'Alice',
      ownerEmail: 'alice@example.com',
      version: '0.1.0',
      fetch: f,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.forkCreated).toBe(false);
    expect(result.data.registrationPullId).toBe('');
    expect(calls.map(c => new URL(c.url).pathname.replace(/^.*\/api\/v1alpha1/, ''))).toEqual([
      '/fork',
      '/hop/wl',
      '/user',
    ]);
    expect(calls.some(c => c.url.includes('/write/'))).toBe(false);
    expect(calls.some(c => c.url.includes('/pulls'))).toBe(false);
  });

  it('retries transient registration write failures while a fresh fork settles', async () => {
    const responses: MockResponse[] = [
      { status: 200, body: { status: 'Success' } },
      { status: 200, body: { query_execution_status: 'Success', rows: [] } },
      { status: 200, body: { pulls: [] } },
      { status: 404, body: { error: 'branch main not found yet' } },
      syncWriteOk(),
      { status: 200, body: { pull_id: '42' } },
    ];
    const { fetch: f, calls } = makeFetch(responses);
    const result = await join({
      auth: { token: 't' },
      upstream: { owner: 'hop', db: 'wl' },
      dolthubOrg: 'alice',
      rigHandle: 'alice',
      displayName: 'Alice',
      ownerEmail: 'alice@example.com',
      version: '0.1.0',
      registrationWriteInitialBackoffMs: 1,
      sleep: () => Promise.resolve(),
      fetch: f,
    });
    expect(result.ok).toBe(true);
    const writes = calls.filter(c => c.url.includes('/write/'));
    expect(writes).toHaveLength(2);
  });

  it('does not retry permanent registration write failures', async () => {
    const responses: MockResponse[] = [
      { status: 200, body: { status: 'Success' } },
      { status: 200, body: { query_execution_status: 'Success', rows: [] } },
      { status: 200, body: { pulls: [] } },
      {
        status: 400,
        body: { query_execution_status: 'Error', query_execution_message: 'syntax error' },
      },
    ];
    const { fetch: f, calls } = makeFetch(responses);
    const result = await join({
      auth: { token: 't' },
      upstream: { owner: 'hop', db: 'wl' },
      dolthubOrg: 'alice',
      rigHandle: 'alice',
      displayName: 'Alice',
      ownerEmail: 'alice@example.com',
      version: '0.1.0',
      registrationWriteInitialBackoffMs: 1,
      sleep: () => Promise.resolve(),
      fetch: f,
    });
    expect(result.ok).toBe(false);
    const writes = calls.filter(c => c.url.includes('/write/'));
    expect(writes).toHaveLength(1);
  });

  it('registers a new handle with the caller as its DoltHub org', async () => {
    const responses: MockResponse[] = [
      { status: 200, body: { status: 'Success' } },
      { status: 200, body: { query_execution_status: 'Success', rows: [] } },
      { status: 200, body: { pulls: [] } },
      syncWriteOk(),
      { status: 200, body: { pull_id: '7' } },
    ];
    const { fetch: f, calls } = makeFetch(responses);
    const result = await join({
      auth: { token: 't' },
      upstream: { owner: 'hop', db: 'wl' },
      dolthubOrg: 'alice',
      rigHandle: 'alice-tools',
      displayName: 'Alice tools',
      ownerEmail: 'alice@example.com',
      version: '0.1.0',
      fetch: f,
    });
    expect(result.ok).toBe(true);
    const write = calls.find(c => c.url.includes('/write/'));
    expect(write?.url).toContain('/alice/wl/write/main/wl%2Fregister%2Falice-tools');
    expect(decodeURIComponent(write?.url ?? '')).toContain(
      "VALUES ('alice-tools', 'Alice tools', 'alice'"
    );
  });

  it('accepts a re-join with a handle the caller already registered', async () => {
    const responses: MockResponse[] = [
      { status: 400, body: { error: 'fork already exists under alice' } },
      {
        status: 200,
        body: {
          query_execution_status: 'Success',
          rows: [{ handle: 'alice-tools', dolthub_org: 'Alice' }],
        },
      },
      { status: 200, body: { status: 'Success', username: 'alice' } },
    ];
    const { fetch: f, calls } = makeFetch(responses);
    const result = await join({
      auth: { token: 't' },
      upstream: { owner: 'hop', db: 'wl' },
      dolthubOrg: 'alice',
      rigHandle: 'alice-tools',
      displayName: 'Alice tools',
      ownerEmail: 'alice@example.com',
      version: '0.1.0',
      fetch: f,
    });
    expect(result.ok).toBe(true);
    expect(calls.some(c => c.url.includes('/write/'))).toBe(false);
    expect(calls.some(c => c.url.includes('/pulls'))).toBe(false);
  });

  it('refuses a handle registered to another DoltHub org', async () => {
    const responses: MockResponse[] = [
      { status: 400, body: { error: 'fork already exists under alice' } },
      {
        status: 200,
        body: {
          query_execution_status: 'Success',
          rows: [{ handle: 'bob', dolthub_org: 'bob' }],
        },
      },
    ];
    const { fetch: f, calls } = makeFetch(responses);
    const result = await join({
      auth: { token: 't' },
      upstream: { owner: 'hop', db: 'wl' },
      dolthubOrg: 'alice',
      rigHandle: 'bob',
      displayName: 'Alice',
      ownerEmail: 'alice@example.com',
      version: '0.1.0',
      fetch: f,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('precondition');
    expect(result.error.message).toContain('registered to another DoltHub org');
    expect(calls.some(c => c.url.includes('/write/'))).toBe(false);
    expect(calls.some(c => c.url.includes('/pulls'))).toBe(false);
  });

  it('refuses a registered handle whose org is missing', async () => {
    const responses: MockResponse[] = [
      { status: 400, body: { error: 'fork already exists under alice' } },
      {
        status: 200,
        body: { query_execution_status: 'Success', rows: [{ handle: 'bob', dolthub_org: null }] },
      },
    ];
    const { fetch: f } = makeFetch(responses);
    const result = await join({
      auth: { token: 't' },
      upstream: { owner: 'hop', db: 'wl' },
      dolthubOrg: 'alice',
      rigHandle: 'bob',
      displayName: 'Alice',
      ownerEmail: 'alice@example.com',
      version: '0.1.0',
      fetch: f,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('precondition');
  });

  it('accepts an open registration PR when the token owns the claimed org', async () => {
    const responses: MockResponse[] = [
      { status: 400, body: { error: 'fork already exists under alice' } },
      { status: 200, body: { query_execution_status: 'Success', rows: [] } },
      {
        status: 200,
        body: {
          pulls: [
            {
              pull_id: '42',
              title: 'Register rig: alice-tools',
              state: 'open',
              created_at: '2026-05-16T00:00:00Z',
              updated_at: '2026-05-16T00:00:00Z',
              creator_name: 'alice',
            },
          ],
        },
      },
      { status: 200, body: { status: 'Success', username: 'alice' } },
    ];
    const { fetch: f, calls } = makeFetch(responses);
    const result = await join({
      auth: { token: 't' },
      upstream: { owner: 'hop', db: 'wl' },
      dolthubOrg: 'alice',
      rigHandle: 'alice-tools',
      displayName: 'Alice tools',
      ownerEmail: 'alice@example.com',
      version: '0.1.0',
      fetch: f,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.registrationPullId).toBe('42');
    expect(calls.some(c => c.url.includes('/write/'))).toBe(false);
  });

  it('refuses an open registration PR when the token does not own the claimed org', async () => {
    const responses: MockResponse[] = [
      { status: 400, body: { error: 'fork already exists under alice' } },
      { status: 200, body: { query_execution_status: 'Success', rows: [] } },
      {
        status: 200,
        body: {
          pulls: [
            {
              pull_id: '42',
              title: 'Register rig: alice-tools',
              state: 'open',
              created_at: '2026-05-16T00:00:00Z',
              updated_at: '2026-05-16T00:00:00Z',
              creator_name: 'alice',
            },
          ],
        },
      },
      { status: 200, body: { status: 'Success', username: 'mallory' } },
    ];
    const { fetch: f, calls } = makeFetch(responses);
    const result = await join({
      auth: { token: 't' },
      upstream: { owner: 'hop', db: 'wl' },
      dolthubOrg: 'alice',
      rigHandle: 'alice-tools',
      displayName: 'Alice tools',
      ownerEmail: 'alice@example.com',
      version: '0.1.0',
      fetch: f,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('precondition');
    expect(result.error.message).toContain('Could not confirm that DoltHub org');
    expect(calls.some(c => c.url.includes('/write/'))).toBe(false);
  });

  it('refuses a matching org the token does not belong to', async () => {
    const responses: MockResponse[] = [
      { status: 400, body: { error: 'fork already exists under alice' } },
      {
        status: 200,
        body: {
          query_execution_status: 'Success',
          rows: [{ handle: 'alice-tools', dolthub_org: 'alice' }],
        },
      },
      { status: 200, body: { status: 'Success', username: 'mallory' } },
    ];
    const { fetch: f, calls } = makeFetch(responses);
    const result = await join({
      auth: { token: 't' },
      upstream: { owner: 'hop', db: 'wl' },
      dolthubOrg: 'alice',
      rigHandle: 'alice-tools',
      displayName: 'Alice tools',
      ownerEmail: 'alice@example.com',
      version: '0.1.0',
      fetch: f,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('precondition');
    expect(result.error.message).toContain('Could not confirm that DoltHub org');
    expect(calls.some(c => c.url.includes('/write/'))).toBe(false);
  });

  it('fails closed when the DoltHub account behind the token cannot be resolved', async () => {
    const responses: MockResponse[] = [
      { status: 400, body: { error: 'fork already exists under alice' } },
      {
        status: 200,
        body: {
          query_execution_status: 'Success',
          rows: [{ handle: 'alice-tools', dolthub_org: 'alice' }],
        },
      },
      { status: 401, body: { status: 'Error', message: 'Not authenticated' } },
    ];
    const { fetch: f } = makeFetch(responses);
    const result = await join({
      auth: { token: 't' },
      upstream: { owner: 'hop', db: 'wl' },
      dolthubOrg: 'alice',
      rigHandle: 'alice-tools',
      displayName: 'Alice tools',
      ownerEmail: 'alice@example.com',
      version: '0.1.0',
      fetch: f,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('upstream');
  });

  it('fails closed when the upstream rigs read fails', async () => {
    const responses: MockResponse[] = [
      { status: 400, body: { error: 'fork already exists under alice' } },
      { status: 500, body: { error: 'upstream unavailable' } },
    ];
    const { fetch: f, calls } = makeFetch(responses);
    const result = await join({
      auth: { token: 't' },
      upstream: { owner: 'hop', db: 'wl' },
      dolthubOrg: 'alice',
      rigHandle: 'alice',
      displayName: 'Alice',
      ownerEmail: 'alice@example.com',
      version: '0.1.0',
      fetch: f,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('upstream');
    expect(calls.some(c => c.url.includes('/write/'))).toBe(false);
  });

  it('rejects a malformed handle before touching DoltHub', async () => {
    const { fetch: f, calls } = makeFetch([]);
    const result = await join({
      auth: { token: 't' },
      upstream: { owner: 'hop', db: 'wl' },
      dolthubOrg: 'alice',
      rigHandle: 'Bob Tools',
      displayName: 'Bob',
      ownerEmail: 'bob@example.com',
      version: '0.1.0',
      fetch: f,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('precondition');
    expect(calls).toHaveLength(0);
  });

  it('fails closed when the fork response is an error body', async () => {
    // A 2xx body that reports an error must not count as a fork this
    // call created, because that is the ownership proof for a handle
    // the join hands back without a write.
    const responses: MockResponse[] = [
      { status: 200, body: { status: 'Error', message: 'user has no access to this owner' } },
    ];
    const { fetch: f, calls } = makeFetch(responses);
    const result = await join({
      auth: { token: 't' },
      upstream: { owner: 'hop', db: 'wl' },
      dolthubOrg: 'alice',
      rigHandle: 'alice-tools',
      displayName: 'Alice tools',
      ownerEmail: 'alice@example.com',
      version: '0.1.0',
      fetch: f,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('upstream');
    expect(calls.map(c => new URL(c.url).pathname.replace(/^.*\/api\/v1alpha1/, ''))).toEqual([
      '/fork',
    ]);
  });

  it('fails closed when the fork response confirms nothing', async () => {
    // A 2xx body that neither names the fork nor reports a terminal
    // success status is not proof that this token can act for the
    // claimed org, so the join must refuse before it hands back and
    // records a handle.
    for (const body of [
      { status: 'Unexpected' },
      { status: 'Error', error: { message: 'denied' } },
      {},
    ]) {
      const { fetch: f, calls } = makeFetch([{ status: 200, body }]);
      const result = await join({
        auth: { token: 't' },
        upstream: { owner: 'hop', db: 'wl' },
        dolthubOrg: 'alice',
        rigHandle: 'alice-tools',
        displayName: 'Alice tools',
        ownerEmail: 'alice@example.com',
        version: '0.1.0',
        fetch: f,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('upstream');
      expect(calls.map(c => new URL(c.url).pathname.replace(/^.*\/api\/v1alpha1/, ''))).toEqual([
        '/fork',
      ]);
    }
  });

  it('accepts an org the caller already proved for its own record', async () => {
    // An org-based connection: the token belongs to member `bob`, the
    // fork and the registered row belong to org `acme`. The caller's
    // record carries a handle for `acme`, so the earlier proof stands
    // and no `/user` lookup is needed.
    const responses: MockResponse[] = [
      { status: 400, body: { error: 'fork already exists under acme' } },
      {
        status: 200,
        body: {
          query_execution_status: 'Success',
          rows: [{ handle: 'acme-tools', dolthub_org: 'acme' }],
        },
      },
    ];
    const { fetch: f, calls } = makeFetch(responses);
    const result = await join({
      auth: { token: 't' },
      upstream: { owner: 'hop', db: 'wl' },
      dolthubOrg: 'acme',
      rigHandle: 'acme-tools',
      displayName: 'Acme tools',
      ownerEmail: 'bob@example.com',
      version: '0.1.0',
      orgProven: true,
      fetch: f,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.forkCreated).toBe(false);
    expect(result.data.registrationPullId).toBe('');
    expect(calls.some(c => c.url.includes('/write/'))).toBe(false);
    expect(calls.some(c => c.url.includes('/pulls'))).toBe(false);
    expect(calls.some(c => c.url.includes('/user'))).toBe(false);
  });

  it('still refuses a handle from another org when the caller proved its own', async () => {
    const responses: MockResponse[] = [
      { status: 400, body: { error: 'fork already exists under acme' } },
      {
        status: 200,
        body: {
          query_execution_status: 'Success',
          rows: [{ handle: 'bob-tools', dolthub_org: 'bob' }],
        },
      },
    ];
    const { fetch: f, calls } = makeFetch(responses);
    const result = await join({
      auth: { token: 't' },
      upstream: { owner: 'hop', db: 'wl' },
      dolthubOrg: 'acme',
      rigHandle: 'bob-tools',
      displayName: 'Bob tools',
      ownerEmail: 'bob@example.com',
      version: '0.1.0',
      orgProven: true,
      fetch: f,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('precondition');
    expect(result.error.message).toContain('registered to another DoltHub org');
    expect(calls.some(c => c.url.includes('/write/'))).toBe(false);
  });
});
