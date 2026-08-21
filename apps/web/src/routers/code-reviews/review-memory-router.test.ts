/* eslint-disable drizzle/enforce-delete-with-where */
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { code_review_memory_proposals, kilocode_users } from '@kilocode/db/schema';

import { createCallerForUser } from '@/routers/test-utils';

// Keyset pagination contract for `listProposalsPage`: the cursor encodes the last
// row's `(updated_at, id)` and the list orders by `updated_at` desc with `id`
// desc as the deterministic tie-breaker. A mid-list cursor resumes exactly
// after the last row; the final page returns `nextCursor: null`.
describe('review memory listProposalsPage pagination', () => {
  let userId: string;

  beforeEach(async () => {
    const user = await insertTestUser();
    userId = user.id;
  });

  afterEach(async () => {
    await db.delete(code_review_memory_proposals);
    await db.delete(kilocode_users);
  });

  async function seedProposal(updatedAt: string, repoFullName: string) {
    const [row] = await db
      .insert(code_review_memory_proposals)
      .values({
        owned_by_user_id: userId,
        owned_by_organization_id: null,
        platform: 'github',
        repo_full_name: repoFullName,
        status: 'open',
        title: `Proposal ${repoFullName}`,
        rationale: 'Rationale',
        proposed_markdown: '## Guidance',
        evidence: [],
        created_at: updatedAt,
        updated_at: updatedAt,
      })
      .returning();
    if (!row) throw new Error('seed proposal failed');
    return row;
  }

  it('resumes mid-list from the cursor and returns null at the end of the list', async () => {
    await seedProposal('2026-06-05T00:00:00.000Z', 'acme/five');
    await seedProposal('2026-06-04T00:00:00.000Z', 'acme/four');
    await seedProposal('2026-06-03T00:00:00.000Z', 'acme/three');
    await seedProposal('2026-06-02T00:00:00.000Z', 'acme/two');
    await seedProposal('2026-06-01T00:00:00.000Z', 'acme/one');

    const caller = await createCallerForUser(userId);

    const page1 = await caller.reviewMemory.listProposalsPage({ platform: 'github', limit: 2 });
    expect(page1.proposals.map(proposal => proposal.repo_full_name)).toEqual([
      'acme/five',
      'acme/four',
    ]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await caller.reviewMemory.listProposalsPage({
      platform: 'github',
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.proposals.map(proposal => proposal.repo_full_name)).toEqual([
      'acme/three',
      'acme/two',
    ]);
    expect(page2.nextCursor).not.toBeNull();

    const page3 = await caller.reviewMemory.listProposalsPage({
      platform: 'github',
      limit: 2,
      cursor: page2.nextCursor!,
    });
    expect(page3.proposals.map(proposal => proposal.repo_full_name)).toEqual(['acme/one']);
    expect(page3.nextCursor).toBeNull();
  });

  it('pages through same-timestamp rows with the id tie-breaker without skipping', async () => {
    const sameTime = '2026-06-05T00:00:00.000Z';
    const a = await seedProposal(sameTime, 'acme/a');
    const b = await seedProposal(sameTime, 'acme/b');
    const c = await seedProposal(sameTime, 'acme/c');

    const caller = await createCallerForUser(userId);

    const page1 = await caller.reviewMemory.listProposalsPage({ platform: 'github', limit: 2 });
    const page2 = await caller.reviewMemory.listProposalsPage({
      platform: 'github',
      limit: 2,
      cursor: page1.nextCursor!,
    });

    const ids = [
      ...page1.proposals.map(proposal => proposal.id),
      ...page2.proposals.map(proposal => proposal.id),
    ];
    expect(ids).toHaveLength(3);
    expect(new Set(ids)).toEqual(new Set([a.id, b.id, c.id]));
    // PostgreSQL orders uuid columns by their canonical byte form, which for
    // lowercase RFC 4122 UUIDs equals plain string comparison.
    const expected = [a.id, b.id, c.id].sort((x, y) => (x < y ? 1 : x > y ? -1 : 0));
    expect(ids).toEqual(expected);
    expect(page2.nextCursor).toBeNull();
  });

  it('pages through same-millisecond rows with microsecond precision without skipping', async () => {
    // Two rows share a millisecond but differ in microseconds. The cursor must
    // carry the exact sort key, or the second row is silently skipped.
    const a = await seedProposal('2026-06-05T00:00:00.000123Z', 'acme/micro-a');
    const b = await seedProposal('2026-06-05T00:00:00.000100Z', 'acme/micro-b');

    const caller = await createCallerForUser(userId);

    const page1 = await caller.reviewMemory.listProposalsPage({ platform: 'github', limit: 1 });
    expect(page1.proposals.map(proposal => proposal.id)).toEqual([a.id]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await caller.reviewMemory.listProposalsPage({
      platform: 'github',
      limit: 1,
      cursor: page1.nextCursor!,
    });
    expect(page2.proposals.map(proposal => proposal.id)).toEqual([b.id]);
    expect(page2.nextCursor).toBeNull();
  });

  it('rejects a malformed cursor with BAD_REQUEST', async () => {
    const caller = await createCallerForUser(userId);

    await expect(
      caller.reviewMemory.listProposalsPage({ platform: 'github', cursor: 'not-a-cursor' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    await expect(
      caller.reviewMemory.listProposalsPage({
        platform: 'github',
        cursor: '2026-06-05T00:00:00.000Z|not-a-uuid',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('keeps the deployed array shape on listProposals for old clients', async () => {
    await seedProposal('2026-06-05T00:00:00.000Z', 'acme/five');
    await seedProposal('2026-06-04T00:00:00.000Z', 'acme/four');

    const caller = await createCallerForUser(userId);

    const proposals = await caller.reviewMemory.listProposals({ platform: 'github', limit: 2 });
    expect(Array.isArray(proposals)).toBe(true);
    expect(proposals.map(proposal => proposal.repo_full_name)).toEqual(['acme/five', 'acme/four']);
  });
});
