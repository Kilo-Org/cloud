import { describe, expect, it } from 'vitest';
import { join } from './join';
import { makeFetch, syncWriteOk, type MockResponse } from './test-helpers';

describe('join', () => {
  it('forks, writes registration, opens PR', async () => {
    const responses: MockResponse[] = [
      // POST /fork → sync success (no operation_name → no polling)
      { status: 200, body: { status: 'Success' } },
      // POST /write registration
      syncWriteOk(),
      // GET listPulls (for existing-PR check) → empty
      { status: 200, body: { pulls: [] } },
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
    expect(calls[1].url).toContain('/alice/wl/write/main/wl%2Fregister%2Falice');
    expect(calls[3].method).toBe('POST');
    expect(calls[3].url).toContain('/hop/wl/pulls');
  });

  it('returns success with empty PR fields when PR creation fails', async () => {
    const responses: MockResponse[] = [
      { status: 200, body: { status: 'Success' } },
      syncWriteOk(),
      { status: 200, body: { pulls: [] } },
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
});
