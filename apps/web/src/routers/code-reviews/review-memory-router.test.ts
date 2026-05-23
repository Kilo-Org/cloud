/* eslint-disable drizzle/enforce-delete-with-where */
const mockDispatchReviewMemoryAggregationCron = jest.fn();
const mockApproveAndOpenReviewMemoryChangeRequest = jest.fn();

jest.mock('@/lib/code-reviews/review-memory/aggregation', () => ({
  dispatchReviewMemoryAggregationCron: () => mockDispatchReviewMemoryAggregationCron(),
}));

jest.mock('@/lib/code-reviews/review-memory/change-request', () => {
  class ReviewMemoryChangeRequestError extends Error {
    constructor(
      public readonly code: 'NOT_FOUND' | 'BAD_REQUEST' | 'CONFLICT',
      message: string
    ) {
      super(message);
    }
  }

  return {
    ReviewMemoryChangeRequestError,
    approveAndOpenReviewMemoryChangeRequest: (...args: unknown[]) =>
      mockApproveAndOpenReviewMemoryChangeRequest(...args),
  };
});

import { db } from '@/lib/drizzle';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  code_review_feedback_events,
  code_review_feedback_subjects,
  code_review_memory_aggregation_runs,
  code_review_memory_aggregation_state,
  code_review_memory_proposal_evidence,
  code_review_memory_proposals,
  kilocode_users,
} from '@kilocode/db/schema';
import {
  recordFeedbackEvent,
  upsertReviewMemoryProposal,
  type ReviewMemoryOwner,
} from '@/lib/code-reviews/review-memory/db';

describe('reviewMemoryRouter', () => {
  afterEach(async () => {
    await db.delete(code_review_memory_proposal_evidence);
    await db.delete(code_review_memory_proposals);
    await db.delete(code_review_memory_aggregation_runs);
    await db.delete(code_review_feedback_events);
    await db.delete(code_review_feedback_subjects);
    await db.delete(code_review_memory_aggregation_state);
    await db.delete(kilocode_users);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockDispatchReviewMemoryAggregationCron.mockResolvedValue({
      claimed: 1,
      completed: 1,
      skipped: 0,
      failed: 0,
      proposals: 1,
    });
    mockApproveAndOpenReviewMemoryChangeRequest.mockImplementation(
      async (input: { proposalId: string }) => ({
        id: input.proposalId,
        status: 'change_request_opened',
        change_request_url: 'https://github.com/acme/widgets/pull/7',
      })
    );
  });

  async function seedProposal(owner: ReviewMemoryOwner) {
    return await upsertReviewMemoryProposal({
      owner,
      platform: 'github',
      repoFullName: 'acme/widgets',
      scopeKind: 'repository',
      proposalType: 'clarify',
      title: 'Clarify widget guidance',
      rationale: 'Maintainers corrected repeated widget comments.',
      proposedMarkdown: '### Clarify widget guidance\n\nAvoid flagging intentional widgets.',
      dedupeKey: `clarify-widget-${owner.id}`,
      positiveCount: 0,
      negativeCount: 3,
      neutralCount: 0,
    });
  }

  it('lists and returns personal proposals for the authenticated owner', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    const proposal = await seedProposal(owner);
    await recordFeedbackEvent({
      owner,
      platform: 'github',
      repoFullName: 'acme/widgets',
      prNumber: 1,
      eventSource: 'github_webhook',
      signalKind: 'corrective_reply',
      sentiment: 'negative',
      strength: 3,
      externalEventId: 'router-dashboard-event',
    });
    const caller = await createCallerForUser(user.id);

    await expect(caller.reviewMemory.getDashboardSummary({ platform: 'github' })).resolves.toEqual(
      expect.objectContaining({
        actionableProposalCount: 1,
        repositories: [expect.objectContaining({ repoFullName: 'acme/widgets' })],
      })
    );
    await expect(caller.reviewMemory.listProposals({ platform: 'github' })).resolves.toEqual([
      expect.objectContaining({ id: proposal.id, title: 'Clarify widget guidance' }),
    ]);
    await expect(caller.reviewMemory.getProposal({ proposalId: proposal.id })).resolves.toEqual({
      proposal: expect.objectContaining({ id: proposal.id }),
      evidence: [],
    });
  });

  it('prevents other users from reading proposals', async () => {
    const ownerUser = await insertTestUser();
    const otherUser = await insertTestUser();
    const proposal = await seedProposal({ type: 'user', id: ownerUser.id });
    const caller = await createCallerForUser(otherUser.id);

    await expect(
      caller.reviewMemory.getProposal({ proposalId: proposal.id })
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('edits and rejects proposals for the authenticated owner', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    const proposal = await seedProposal(owner);
    const caller = await createCallerForUser(user.id);

    const edited = await caller.reviewMemory.updateProposal({
      proposalId: proposal.id,
      title: 'Edited widget guidance',
      rationale: 'The rationale was reviewed by a maintainer.',
      proposedMarkdown: '### Edited widget guidance\n\nNarrow this check to generated widgets.',
      scopeKind: 'file',
      scopeValue: 'src/widget.ts',
    });
    expect(edited).toEqual(
      expect.objectContaining({
        status: 'edited',
        title: 'Edited widget guidance',
        edited_by_user_id: user.id,
      })
    );

    const rejected = await caller.reviewMemory.rejectProposal({ proposalId: proposal.id });
    expect(rejected).toEqual(
      expect.objectContaining({
        status: 'rejected',
        rejected_by_user_id: user.id,
      })
    );
  });

  it('refreshes a scope and dispatches aggregation when manually triggered', async () => {
    const user = await insertTestUser();
    const caller = await createCallerForUser(user.id);

    await expect(
      caller.reviewMemory.triggerAnalysis({ platform: 'github', repoFullName: 'acme/widgets' })
    ).resolves.toEqual(
      expect.objectContaining({
        state: expect.objectContaining({ repo_full_name: 'acme/widgets', platform: 'github' }),
        summary: expect.objectContaining({ claimed: 1 }),
      })
    );
    expect(mockDispatchReviewMemoryAggregationCron).toHaveBeenCalledTimes(1);
  });

  it('approves proposals through the change-request workflow', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    const proposal = await seedProposal(owner);
    const caller = await createCallerForUser(user.id);

    await expect(
      caller.reviewMemory.approveAndOpenChangeRequest({ proposalId: proposal.id })
    ).resolves.toEqual(
      expect.objectContaining({
        id: proposal.id,
        status: 'change_request_opened',
        change_request_url: 'https://github.com/acme/widgets/pull/7',
      })
    );
    expect(mockApproveAndOpenReviewMemoryChangeRequest).toHaveBeenCalledWith({
      owner,
      proposalId: proposal.id,
      approvedByUser: {
        id: user.id,
        email: user.google_user_email,
        name: user.google_user_name,
      },
    });
  });
});
