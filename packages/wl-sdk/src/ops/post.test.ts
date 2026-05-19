import { describe, expect, it } from 'vitest';
import { post } from './post';
import {
  forkCurrentResponses,
  makeFetch,
  readWantedRow,
  syncWriteOk,
  type MockResponse,
} from './test-helpers';
import type { MutationContext } from './types';

const ctx = (f: typeof fetch, now?: () => Date): MutationContext => ({
  auth: { token: 'tok' },
  upstream: { owner: 'hop', db: 'wl' },
  fork: { forkOwner: 'alice', forkDb: 'wl' },
  rigHandle: 'alice',
  fetch: f,
  now,
});

describe('post', () => {
  it('happy path: writes INSERT to wl/<rig>/<id>; cleanup disabled', async () => {
    const responses: MockResponse[] = [
      // branch status read: empty (branch absent)
      readWantedRow(null),
      // fork-currency preamble: not stale
      ...forkCurrentResponses(),
      // write
      syncWriteOk(),
    ];
    const { fetch: f, calls } = makeFetch(responses);
    const fixedNow = () => new Date('2024-05-01T12:00:00Z');
    const result = await post({
      ctx: ctx(f, fixedNow),
      wantedId: 'w-new',
      title: 'Brand new bounty',
      type: 'feature',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.wantedId).toBe('w-new');
    expect(result.data.cleanedUp).toBe(false);
    // Confirm the write target and that we used a deterministic timestamp.
    const writes = calls.filter(c => c.method === 'POST' && c.url.includes('/write/'));
    expect(writes).toHaveLength(1);
    expect(decodeURIComponent(writes[0].url)).toContain("'2024-05-01 12:00:00'");
    // 1 idempotency read + 2 stale-fork reads + 1 write = 4 calls; no
    // post-write reads since cleanup is disabled.
    expect(calls).toHaveLength(4);
  });

  it('idempotency: branch already at status=open → no write', async () => {
    const { fetch: f, calls } = makeFetch([
      readWantedRow({
        id: 'w-new',
        title: 'Brand new bounty',
        description: null,
        project: null,
        type: 'feature',
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
      }),
    ]);
    const result = await post({
      ctx: ctx(f),
      wantedId: 'w-new',
      title: 'Brand new bounty',
      type: 'feature',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.alreadyApplied).toBe(true);
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(0);
  });
});
