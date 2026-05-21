import { describe, expect, it } from 'vitest';
import { acceptUpstream } from './accept-upstream';
import {
  fixtureWantedRow,
  forkCurrentResponses,
  makeFetch,
  readWantedRow,
  syncWriteOk,
} from './test-helpers';

describe('acceptUpstream', () => {
  it('adopts a submitter completion and stamps it on an admin branch', async () => {
    const { fetch: f, calls } = makeFetch([
      readWantedRow(null),
      ...forkCurrentResponses(),
      syncWriteOk(),
      syncWriteOk(),
      syncWriteOk(),
      syncWriteOk(),
      syncWriteOk(),
      readWantedRow(fixtureWantedRow({ status: 'completed', claimed_by: 'bob' })),
      readWantedRow(fixtureWantedRow({ status: 'completed', claimed_by: 'bob' })),
      { status: 200, body: { status: 'Success' } },
    ]);

    const result = await acceptUpstream({
      ctx: {
        auth: { token: 't' },
        upstream: { owner: 'hop', db: 'wl' },
        fork: { forkOwner: 'admin', forkDb: 'wl' },
        rigHandle: 'alice',
        fetch: f,
      },
      wantedId: 'w-1',
      submitterRigHandle: 'bob',
      completionId: 'c-w-1-bob',
      evidence: 'https://example.com/pr/1',
      stamp: {
        id: 's-w-1-alice',
        subject: 'bob',
        quality: 5,
        reliability: 4,
        severity: 'branch',
        skillTags: ['go'],
        message: 'solid work',
      },
    });

    if (!result.ok) throw result.error;
    const writeBodies = calls
      .filter(call => call.method === 'POST')
      .map(call => decodeURIComponent(new URL(call.url).searchParams.get('q') ?? ''));
    expect(writeBodies).toHaveLength(5);
    expect(writeBodies.join('\n')).toContain('DELETE FROM completions');
    expect(writeBodies.join('\n')).toContain('INSERT INTO stamps');
    expect(writeBodies.join('\n')).toContain("'bob'");
    expect(writeBodies.join('\n')).toContain('solid work');
  });
});
