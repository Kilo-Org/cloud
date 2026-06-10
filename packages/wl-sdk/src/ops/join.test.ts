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
      // read upstream rigs → already registered.
      { status: 200, body: { query_execution_status: 'Success', rows: [{ handle: 'alice' }] } },
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
    expect(calls).toHaveLength(2);
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
});
