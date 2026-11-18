/* eslint-disable drizzle/enforce-delete-with-where */
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import type { User } from '@kilocode/db/schema';
import {
  code_review_feedback_events,
  code_review_memory_proposals,
  kilocode_users,
} from '@kilocode/db/schema';

import { recordReplyFeedbackEvent, type ReviewMemoryOwner } from './db';
import {
  REVIEW_MEMORY_PROPOSAL_LIMITS,
  ReviewMemoryProposalOutputSchema,
  runReviewMemoryAnalysis,
  validateReviewMemoryProposalDraft,
} from './aggregation';
import { createReviewMemoryGatewayProvider, generateReviewMemoryStructuredOutput } from './llm';

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

describe('Review Memory proposal structured output', () => {
  // The wire schema strips maxLength, so the schema accepts an over-length title and the
  // validate callback must refuse it.
  it('refuses an over-length title in validate, not in the schema', async () => {
    const gatewayFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          id: 'gateway-response-id',
          object: 'chat.completion',
          created: 1_750_204_800,
          model: 'test/model',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  proposal: {
                    status: 'propose',
                    title: 't'.repeat(REVIEW_MEMORY_PROPOSAL_LIMITS.titleChars + 1),
                    rationale: 'repeated feedback about lint fixes',
                    proposedMarkdown: '- run the linter before review',
                    positiveCount: 1,
                    negativeCount: 0,
                    neutralCount: 0,
                    evidenceEventIds: [],
                  },
                }),
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );

    const actor = { id: 'test-user-id', api_token_pepper: null } as User;
    const provider = createReviewMemoryGatewayProvider({
      owner: { type: 'user', id: actor.id },
      actor,
      userAgent: 'Review Memory proposal test',
      fetch: gatewayFetch,
    });

    await expect(
      generateReviewMemoryStructuredOutput({
        model: provider.chatModel('test/model'),
        prompt: 'Analyze the feedback.',
        maxOutputTokens: 4_000,
        schemaName: 'review_memory_proposal',
        schema: ReviewMemoryProposalOutputSchema,
        validate: output => ({
          proposal: validateReviewMemoryProposalDraft(output.proposal),
        }),
      })
    ).rejects.toThrow(/title exceeds 140 characters/);
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
