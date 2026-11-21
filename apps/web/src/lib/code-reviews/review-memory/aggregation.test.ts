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
  REVIEW_MEMORY_GATEWAY_TIMEOUT_MS,
  REVIEW_MEMORY_PROPOSAL_LIMITS,
  ReviewMemoryProposalOutputSchema,
  generateReviewMemoryProposalWithGateway,
  runReviewMemoryAnalysis,
  validateReviewMemoryProposalDraft,
} from './aggregation';
import * as llm from './llm';
import { createReviewMemoryGatewayProvider, generateReviewMemoryStructuredOutput } from './llm';

// The llm exports are swc getters, so spyOn cannot redefine them; wrap them in jest.fn
// instead. The call-through default keeps the real gateway path for the other tests.
jest.mock('./llm', () => {
  const actual = jest.requireActual('./llm');
  return {
    ...actual,
    createReviewMemoryGatewayForOwner: jest.fn(actual.createReviewMemoryGatewayForOwner),
    generateReviewMemoryStructuredOutput: jest.fn(actual.generateReviewMemoryStructuredOutput),
  };
});

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

  it('caps the fallback evidence at the proposal evidence limit', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    for (let index = 0; index < 25; index++) {
      await recordReplyFeedbackEvent({
        owner,
        platform: 'github',
        repoFullName: 'acme/widgets',
        prNumber: 100 + index,
        kiloCommentId: `fallback-${index}`,
        replyExcerpt: `Fallback excerpt ${index}.`,
      });
    }

    const result = await runReviewMemoryAnalysis({
      owner,
      platform: 'github',
      repoFullName: 'acme/widgets',
      generate: async () => ({
        draft: {
          status: 'propose',
          title: 'Bounded evidence',
          rationale: 'Maintainers repeatedly asked for the same correction.',
          proposedMarkdown: '- Prefer the shared helper over a local copy.',
          positiveCount: 0,
          negativeCount: 25,
          neutralCount: 0,
          evidenceEventIds: [],
        },
      }),
    });

    expect(result.status).toBe('proposed');
    const proposals = await db.select().from(code_review_memory_proposals);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].evidence).toHaveLength(REVIEW_MEMORY_PROPOSAL_LIMITS.evidenceEventIds);
    expect(proposals[0].evidence[0]).toEqual(
      expect.objectContaining({ excerpt: expect.any(String), prNumber: expect.any(Number) })
    );
  });

  it('arms a default deadline when the caller supplies no signal', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    const events = await seedFeedback(owner);
    let capturedSignal: AbortSignal | undefined;
    // A real deadline is not observable from the signal, so record the duration it is armed with.
    const realTimeout = AbortSignal.timeout;
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout').mockImplementation(realTimeout);

    try {
      const result = await runReviewMemoryAnalysis({
        owner,
        platform: 'github',
        repoFullName: 'acme/widgets',
        generate: async input => {
          capturedSignal = input.signal;
          return {
            draft: {
              status: 'propose',
              title: 'Deadline response',
              rationale: 'Maintainers repeatedly corrected generated fixture comments.',
              proposedMarkdown: '- Do not flag generated fixtures.',
              positiveCount: 0,
              negativeCount: 2,
              neutralCount: 0,
              evidenceEventIds: [events[0].id],
            },
          };
        },
      });

      expect(result.status).toBe('proposed');
      expect(timeoutSpy).toHaveBeenCalledTimes(1);
      expect(timeoutSpy).toHaveBeenCalledWith(REVIEW_MEMORY_GATEWAY_TIMEOUT_MS);
      expect(capturedSignal).toBeInstanceOf(AbortSignal);
      expect(capturedSignal?.aborted).toBe(false);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('forwards a caller supplied signal to the gateway call', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    // One-shot stubs keep the call-through defaults intact for the remaining tests.
    jest.mocked(llm.createReviewMemoryGatewayForOwner).mockResolvedValueOnce({
      modelSlug: 'test/model',
      // Only the signal hand-off matters here, so the provider stub needs one model getter.
      provider: { chatModel: () => 'test/model' },
    } as never);
    const structuredOutput = jest.mocked(llm.generateReviewMemoryStructuredOutput);
    structuredOutput.mockResolvedValueOnce({
      output: { proposal: { status: 'no_change' } },
      tokensIn: null,
      tokensOut: null,
    } as never);
    const controller = new AbortController();
    // A caller signal must reach the gateway unchanged, with no default deadline alongside it.
    const realTimeout = AbortSignal.timeout;
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout').mockImplementation(realTimeout);

    try {
      const result = await generateReviewMemoryProposalWithGateway({
        owner,
        platform: 'github',
        repoFullName: 'acme/widgets',
        events: [],
        signal: controller.signal,
      });

      expect(result.draft).toEqual({ status: 'no_change' });
      expect(structuredOutput).toHaveBeenCalledWith(
        expect.objectContaining({ abortSignal: controller.signal })
      );
      expect(timeoutSpy).not.toHaveBeenCalled();
    } finally {
      timeoutSpy.mockRestore();
    }
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
