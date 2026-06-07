/* eslint-disable drizzle/enforce-delete-with-where */
const mockDispatchManualReviewMemoryAggregation = jest.fn();
const mockApproveAndOpenReviewMemoryChangeRequest = jest.fn();

jest.mock('@/lib/code-reviews/review-memory/aggregation', () => ({
  dispatchManualReviewMemoryAggregation: (...args: unknown[]) =>
    mockDispatchManualReviewMemoryAggregation(...args),
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
import { addUserToOrganization } from '@/lib/organizations/organizations';
import { createCallerForUser } from '@/routers/test-utils';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  agent_configs,
  code_review_feedback_events,
  code_review_feedback_subjects,
  code_review_memory_aggregation_state,
  code_review_memory_proposals,
  kilocode_users,
  organization_memberships,
  organizations,
} from '@kilocode/db/schema';
import {
  recordFeedbackEvent,
  upsertReviewMemoryProposal,
  type ReviewMemoryOwner,
} from '@/lib/code-reviews/review-memory/db';
import { eq } from 'drizzle-orm';

describe('reviewMemoryRouter', () => {
  afterEach(async () => {
    await db.delete(code_review_memory_proposals);
    await db.delete(code_review_feedback_events);
    await db.delete(code_review_feedback_subjects);
    await db.delete(code_review_memory_aggregation_state);
    await db.delete(agent_configs);
    await db.delete(organization_memberships);
    await db.delete(organizations);
    await db.delete(kilocode_users);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockDispatchManualReviewMemoryAggregation.mockResolvedValue({
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

  async function enableReviewMemory(owner: ReviewMemoryOwner) {
    await db.insert(agent_configs).values({
      ...(owner.type === 'org'
        ? { owned_by_organization_id: owner.id }
        : { owned_by_user_id: owner.id }),
      agent_type: 'code_review',
      platform: 'github',
      config: { review_memory_enabled: true },
      is_enabled: false,
      created_by: owner.id,
    });
  }

  it('lists personal proposals for the authenticated owner', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    const proposal = await seedProposal(owner);
    await recordFeedbackEvent({
      owner,
      platform: 'github',
      repoFullName: 'acme/widgets',
      prNumber: 1,
      signalKind: 'corrective_reply',
      sentiment: 'negative',
      strength: 3,
      dedupeHash: 'router-dashboard-event',
    });
    const caller = await createCallerForUser(user.id);

    await expect(caller.reviewMemory.getDashboardSummary({ platform: 'github' })).resolves.toEqual(
      expect.objectContaining({
        enabled: false,
        actionableProposalCount: 1,
        repositories: [expect.objectContaining({ repoFullName: 'acme/widgets' })],
      })
    );
    await expect(caller.reviewMemory.listProposals({ platform: 'github' })).resolves.toEqual([
      expect.objectContaining({ id: proposal.id, title: 'Clarify widget guidance' }),
    ]);
  });

  it('prevents other users from listing proposals', async () => {
    const ownerUser = await insertTestUser();
    const otherUser = await insertTestUser();
    await seedProposal({ type: 'user', id: ownerUser.id });
    const caller = await createCallerForUser(otherUser.id);

    await expect(caller.reviewMemory.listProposals({ platform: 'github' })).resolves.toEqual([]);
  });

  it('edits and rejects proposals for the authenticated owner', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    await enableReviewMemory(owner);
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
      })
    );

    const rejected = await caller.reviewMemory.rejectProposal({ proposalId: proposal.id });
    expect(rejected).toEqual(
      expect.objectContaining({
        status: 'rejected',
      })
    );
  });

  it('refreshes a scope and dispatches aggregation when manually triggered', async () => {
    const user = await insertTestUser();
    await enableReviewMemory({ type: 'user', id: user.id });
    const caller = await createCallerForUser(user.id);

    await expect(
      caller.reviewMemory.triggerAnalysis({ platform: 'github', repoFullName: 'acme/widgets' })
    ).resolves.toEqual(
      expect.objectContaining({
        state: expect.objectContaining({ repo_full_name: 'acme/widgets', platform: 'github' }),
        summary: expect.objectContaining({ claimed: 1 }),
      })
    );
    expect(mockDispatchManualReviewMemoryAggregation).toHaveBeenCalledWith({
      limit: 1,
      stateId: expect.any(String),
      bypassEligibleCooldown: true,
    });
  });

  it('approves proposals through the change-request workflow', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    await enableReviewMemory(owner);
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

  it('sets personal review memory enablement without enabling Code Reviewer', async () => {
    const user = await insertTestUser();
    const caller = await createCallerForUser(user.id);

    await expect(
      caller.reviewMemory.setEnabled({ platform: 'github', enabled: true })
    ).resolves.toEqual({ success: true, enabled: true });

    const config = await db.query.agent_configs.findFirst({
      where: (fields, { and, eq }) =>
        and(
          eq(fields.agent_type, 'code_review'),
          eq(fields.platform, 'github'),
          eq(fields.owned_by_user_id, user.id)
        ),
    });

    expect(config?.is_enabled).toBe(false);
    expect(config?.config).toEqual(expect.objectContaining({ review_memory_enabled: true }));
    await expect(caller.reviewMemory.getDashboardSummary({ platform: 'github' })).resolves.toEqual(
      expect.objectContaining({ enabled: true })
    );
  });

  it('rejects manual analysis when review memory is disabled', async () => {
    const user = await insertTestUser();
    const caller = await createCallerForUser(user.id);

    await expect(
      caller.reviewMemory.triggerAnalysis({ platform: 'github', repoFullName: 'acme/widgets' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockDispatchManualReviewMemoryAggregation).not.toHaveBeenCalled();
  });

  it('rejects proposal actions when review memory is disabled', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    const proposal = await seedProposal(owner);
    const caller = await createCallerForUser(user.id);

    await expect(
      caller.reviewMemory.updateProposal({
        proposalId: proposal.id,
        title: 'Edited widget guidance',
        rationale: 'The rationale was reviewed by a maintainer.',
        proposedMarkdown: '### Edited widget guidance\n\nNarrow this check to generated widgets.',
        scopeKind: 'file',
        scopeValue: 'src/widget.ts',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller.reviewMemory.rejectProposal({ proposalId: proposal.id })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller.reviewMemory.approveAndOpenChangeRequest({ proposalId: proposal.id })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockApproveAndOpenReviewMemoryChangeRequest).not.toHaveBeenCalled();
  });

  it('allows billing managers to update, reject, and trigger organization review memory', async () => {
    const ownerUser = await insertTestUser();
    const billingManager = await insertTestUser();
    const organization = await createTestOrganization(
      'Review Memory Org',
      ownerUser.id,
      0,
      undefined,
      true
    );
    await addUserToOrganization(organization.id, billingManager.id, 'billing_manager');
    const owner = { type: 'org' as const, id: organization.id };
    const proposal = await seedProposal(owner);
    const ownerCaller = await createCallerForUser(ownerUser.id);
    await ownerCaller.reviewMemory.setEnabled({
      organizationId: organization.id,
      platform: 'github',
      enabled: true,
    });
    const billingManagerCaller = await createCallerForUser(billingManager.id);

    await expect(
      billingManagerCaller.reviewMemory.updateProposal({
        organizationId: organization.id,
        proposalId: proposal.id,
        title: 'Edited organization widget guidance',
        rationale: 'The rationale was reviewed by a maintainer.',
        proposedMarkdown: '### Edited widget guidance\n\nNarrow this check to generated widgets.',
        scopeKind: 'file',
        scopeValue: 'src/widget.ts',
      })
    ).resolves.toEqual(expect.objectContaining({ status: 'edited' }));
    await expect(
      billingManagerCaller.reviewMemory.rejectProposal({
        organizationId: organization.id,
        proposalId: proposal.id,
      })
    ).resolves.toEqual(expect.objectContaining({ status: 'rejected' }));
    await expect(
      billingManagerCaller.reviewMemory.triggerAnalysis({
        organizationId: organization.id,
        platform: 'github',
        repoFullName: 'acme/widgets',
      })
    ).resolves.toEqual(
      expect.objectContaining({ summary: expect.objectContaining({ claimed: 1 }) })
    );
  });

  it('prevents organization members from mutating review memory proposals', async () => {
    const ownerUser = await insertTestUser();
    const member = await insertTestUser();
    const organization = await createTestOrganization(
      'Review Memory Org',
      ownerUser.id,
      0,
      undefined,
      true
    );
    await addUserToOrganization(organization.id, member.id, 'member');
    const proposal = await seedProposal({ type: 'org', id: organization.id });
    const ownerCaller = await createCallerForUser(ownerUser.id);
    await ownerCaller.reviewMemory.setEnabled({
      organizationId: organization.id,
      platform: 'github',
      enabled: true,
    });
    const memberCaller = await createCallerForUser(member.id);

    await expect(
      memberCaller.reviewMemory.updateProposal({
        organizationId: organization.id,
        proposalId: proposal.id,
        title: 'Edited organization widget guidance',
        rationale: 'The rationale was reviewed by a maintainer.',
        proposedMarkdown: '### Edited widget guidance\n\nNarrow this check to generated widgets.',
        scopeKind: 'file',
        scopeValue: 'src/widget.ts',
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      memberCaller.reviewMemory.triggerAnalysis({
        organizationId: organization.id,
        platform: 'github',
        repoFullName: 'acme/widgets',
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('prevents organization review memory mutations after trial expiration', async () => {
    const ownerUser = await insertTestUser();
    const organization = await createTestOrganization(
      'Review Memory Org',
      ownerUser.id,
      0,
      undefined,
      true
    );
    const proposal = await seedProposal({ type: 'org', id: organization.id });
    const caller = await createCallerForUser(ownerUser.id);
    await caller.reviewMemory.setEnabled({
      organizationId: organization.id,
      platform: 'github',
      enabled: true,
    });
    await db
      .update(organizations)
      .set({ free_trial_end_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() })
      .where(eq(organizations.id, organization.id));

    await expect(
      caller.reviewMemory.triggerAnalysis({
        organizationId: organization.id,
        platform: 'github',
        repoFullName: 'acme/widgets',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller.reviewMemory.updateProposal({
        organizationId: organization.id,
        proposalId: proposal.id,
        title: 'Edited organization widget guidance',
        rationale: 'The rationale was reviewed by a maintainer.',
        proposedMarkdown: '### Edited widget guidance\n\nNarrow this check to generated widgets.',
        scopeKind: 'file',
        scopeValue: 'src/widget.ts',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('prevents billing managers from opening organization change requests', async () => {
    const ownerUser = await insertTestUser();
    const billingManager = await insertTestUser();
    const organization = await createTestOrganization(
      'Review Memory Org',
      ownerUser.id,
      0,
      undefined,
      true
    );
    await addUserToOrganization(organization.id, billingManager.id, 'billing_manager');
    const proposal = await seedProposal({ type: 'org', id: organization.id });
    const caller = await createCallerForUser(billingManager.id);

    await expect(
      caller.reviewMemory.approveAndOpenChangeRequest({
        organizationId: organization.id,
        proposalId: proposal.id,
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mockApproveAndOpenReviewMemoryChangeRequest).not.toHaveBeenCalled();
  });
});
