/* eslint-disable drizzle/enforce-delete-with-where */
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  code_review_feedback_events,
  code_review_memory_proposals,
  kilocode_users,
} from '@kilocode/db/schema';

import { recordReplyFeedbackEvent, type ReviewMemoryOwner } from './db';
import { runReviewMemoryAnalysis } from './aggregation';

describe('review memory aggregation', () => {
  afterEach(async () => {
    await db.delete(code_review_memory_proposals);
    await db.delete(code_review_feedback_events);
    await db.delete(kilocode_users);
  });

  it('creates a proposal with evidence excerpts and sentiment counts', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    const events = await seedFeedback(owner);

    const result = await runReviewMemoryAnalysis({
      owner,
      platform: 'github',
      repoFullName: 'acme/widgets',
      generate: async () => ({
        draft: {
          status: 'propose',
          title: 'Generated fixtures',
          rationale: 'Maintainers repeatedly corrected generated fixture comments.',
          proposedMarkdown:
            '## Generated fixtures\n\nDo not flag generated fixtures unless behavior changes.',
          positiveCount: 0,
          negativeCount: 2,
          neutralCount: 0,
          evidenceEventIds: [events[0].id],
        },
      }),
    });

    expect(result.status).toBe('proposed');
    const proposals = await db.select().from(code_review_memory_proposals);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toEqual(
      expect.objectContaining({
        title: 'Generated fixtures',
        status: 'open',
        negative_count: 2,
        positive_count: 0,
        neutral_count: 0,
        evidence: [{ excerpt: 'This generated fixture should be ignored.', prNumber: 11 }],
      })
    );
  });

  it('does not create a proposal for no_change or empty feedback', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    await seedFeedback(owner);

    await expect(
      runReviewMemoryAnalysis({
        owner,
        platform: 'github',
        repoFullName: 'acme/widgets',
        generate: async () => ({
          draft: {
            status: 'no_change',
          },
        }),
      })
    ).resolves.toEqual({ status: 'no_change' });
    await expect(
      runReviewMemoryAnalysis({ owner, platform: 'github', repoFullName: 'acme/empty' })
    ).resolves.toEqual({ status: 'no_feedback' });
    await expect(db.select().from(code_review_memory_proposals)).resolves.toHaveLength(0);
  });
});

async function seedFeedback(owner: ReviewMemoryOwner) {
  const first = await recordReplyFeedbackEvent({
    owner,
    platform: 'github',
    repoFullName: 'acme/widgets',
    prNumber: 11,
    kiloCommentId: '501',
    replyExcerpt: 'This generated fixture should be ignored.',
    kiloCommentExcerpt: 'Simplify this generated fixture.',
  });
  const second = await recordReplyFeedbackEvent({
    owner,
    platform: 'github',
    repoFullName: 'acme/widgets',
    prNumber: 12,
    kiloCommentId: '502',
    replyExcerpt: 'Generated snapshot, please do not flag.',
    kiloCommentExcerpt: 'This snapshot is too verbose.',
  });
  return [first.event, second.event];
}
