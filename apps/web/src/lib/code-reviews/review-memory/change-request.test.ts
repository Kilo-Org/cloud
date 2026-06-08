/* eslint-disable drizzle/enforce-delete-with-where */
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  code_review_memory_proposals,
  kilocode_users,
  type CodeReviewMemoryProposal,
} from '@kilocode/db/schema';

import {
  markProposalChangeRequestFailed,
  markProposalChangeRequestOpened,
  markProposalOpeningChangeRequest,
  markProposalSuperseded,
  upsertScopeProposal,
  type ReviewMemoryOwner,
} from './db';
import { buildChangeRequestBody, isStaleOpeningChangeRequest } from './change-request';

describe('review memory change requests', () => {
  afterEach(async () => {
    await db.delete(code_review_memory_proposals);
    await db.delete(kilocode_users);
  });

  it('builds a change-request body with the marker and proposal sections', async () => {
    const proposal = buildProposal({
      id: 'proposal-id',
      title: 'Generated fixtures',
      rationale: 'Maintainers corrected repeated generated fixture comments.',
    });

    expect(buildChangeRequestBody(proposal)).toContain(
      '<!-- kilo-review-memory-change-request -->'
    );
    expect(buildChangeRequestBody(proposal)).toContain('## Proposal');
    expect(buildChangeRequestBody(proposal)).toContain('Generated fixtures');
    expect(buildChangeRequestBody(proposal)).toContain('## Rationale');
  });

  it('applies guarded proposal status transitions', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };

    const openedProposal = await seedProposal(owner, 'acme/opened');
    const opening = await markProposalOpeningChangeRequest({ proposalId: openedProposal.id });
    expect(opening?.status).toBe('opening_change_request');
    const opened = await markProposalChangeRequestOpened({
      proposalId: openedProposal.id,
      changeRequestUrl: 'https://github.com/acme/opened/pull/1',
    });
    expect(opened).toEqual(
      expect.objectContaining({
        status: 'change_request_opened',
        change_request_url: 'https://github.com/acme/opened/pull/1',
      })
    );

    const failedProposal = await seedProposal(owner, 'acme/failed');
    await markProposalOpeningChangeRequest({ proposalId: failedProposal.id });
    const failed = await markProposalChangeRequestFailed({ proposalId: failedProposal.id });
    expect(failed?.status).toBe('change_request_failed');

    const supersededProposal = await seedProposal(owner, 'acme/superseded');
    const superseded = await markProposalSuperseded({ proposalId: supersededProposal.id });
    expect(superseded?.status).toBe('superseded');
  });

  it('detects stale opening change-request states', () => {
    const now = new Date('2026-06-01T12:00:00.000Z');

    expect(isStaleOpeningChangeRequest('2026-06-01T11:31:00.000Z', now)).toBe(false);
    expect(isStaleOpeningChangeRequest('2026-06-01T11:30:00.000Z', now)).toBe(true);
    expect(isStaleOpeningChangeRequest('not-a-date', now)).toBe(false);
  });
});

function buildProposal(input: {
  id: string;
  title: string;
  rationale: string;
}): CodeReviewMemoryProposal {
  return {
    id: input.id,
    owned_by_organization_id: null,
    owned_by_user_id: 'user-id',
    platform: 'github',
    repo_full_name: 'acme/widgets',
    status: 'open',
    title: input.title,
    rationale: input.rationale,
    proposed_markdown: '## Generated fixtures\n\nDo not flag generated fixtures.',
    evidence: [],
    positive_count: 0,
    negative_count: 0,
    neutral_count: 0,
    change_request_url: null,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
  };
}

async function seedProposal(owner: ReviewMemoryOwner, repoFullName: string) {
  return await upsertScopeProposal({
    owner,
    platform: 'github',
    repoFullName,
    title: 'Generated fixtures',
    rationale: 'Maintainers corrected repeated generated fixture comments.',
    proposedMarkdown: '## Generated fixtures\n\nDo not flag generated fixtures.',
    evidence: [{ excerpt: 'Generated fixture feedback.', prNumber: 10 }],
    positiveCount: 0,
    negativeCount: 1,
    neutralCount: 0,
  });
}
