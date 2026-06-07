/* eslint-disable drizzle/enforce-delete-with-where */
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  code_review_feedback_events,
  code_review_feedback_subjects,
  code_review_memory_aggregation_state,
  code_review_memory_proposals,
  kilocode_users,
} from '@kilocode/db/schema';
import { count, eq } from 'drizzle-orm';
import {
  createFeedbackSubjectExternalIdHash,
  markProposalOpeningChangeRequest,
  pruneExpiredReviewMemoryData,
  recordFeedbackEvent,
  rejectReviewMemoryProposal,
  updateReviewMemoryProposal,
  upsertFeedbackSubject,
  upsertReviewMemoryProposal,
} from './db';

describe('review memory db helpers', () => {
  afterEach(async () => {
    await db.delete(code_review_memory_proposals);
    await db.delete(code_review_feedback_events);
    await db.delete(code_review_feedback_subjects);
    await db.delete(code_review_memory_aggregation_state);
    await db.delete(kilocode_users);
  });

  it('upserts feedback subjects by platform, repo, type, and external ID', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };

    const first = await upsertFeedbackSubject({
      owner,
      platform: 'github',
      repoFullName: 'owner/repo',
      subjectType: 'inline_comment',
      externalId: 'comment-123',
      externalThreadId: 'thread-123',
      prNumber: 10,
      state: 'active',
    });

    const second = await upsertFeedbackSubject({
      owner,
      platform: 'github',
      repoFullName: 'owner/repo',
      subjectType: 'inline_comment',
      externalId: 'comment-123',
      externalThreadId: 'thread-123',
      prNumber: 10,
      state: 'resolved',
    });

    expect(second.id).toBe(first.id);
    expect(second.state).toBe('resolved');
    expect(second.external_id_hash).toBe(
      createFeedbackSubjectExternalIdHash({
        owner,
        platform: 'github',
        repoFullName: 'owner/repo',
        subjectType: 'inline_comment',
        idKind: 'subject',
        externalId: 'comment-123',
      })
    );

    const rows = await db
      .select({ count: count() })
      .from(code_review_feedback_subjects)
      .where(eq(code_review_feedback_subjects.external_id_hash, second.external_id_hash));
    expect(rows[0].count).toBe(1);
  });

  it('keeps feedback subjects scoped to their owner', async () => {
    const user = await insertTestUser();
    const otherUser = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    const otherOwner = { type: 'user' as const, id: otherUser.id };

    const first = await upsertFeedbackSubject({
      owner,
      platform: 'github',
      repoFullName: 'owner/repo',
      subjectType: 'inline_comment',
      externalId: 'shared-comment-id',
      state: 'active',
    });
    const second = await upsertFeedbackSubject({
      owner: otherOwner,
      platform: 'github',
      repoFullName: 'owner/repo',
      subjectType: 'inline_comment',
      externalId: 'shared-comment-id',
      state: 'resolved',
    });

    expect(second.id).not.toBe(first.id);

    const rows = await db
      .select()
      .from(code_review_feedback_subjects)
      .where(eq(code_review_feedback_subjects.repo_full_name, 'owner/repo'));
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: first.id,
          owned_by_user_id: user.id,
          state: 'active',
        }),
        expect.objectContaining({
          id: second.id,
          owned_by_user_id: otherUser.id,
          state: 'resolved',
        }),
      ])
    );
  });

  it('dedupes feedback events and refreshes aggregation state', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    const subject = await upsertFeedbackSubject({
      owner,
      platform: 'github',
      repoFullName: 'owner/repo',
      subjectType: 'summary_comment',
      externalId: 'summary-123',
      prNumber: 12,
      state: 'active',
    });

    const first = await recordFeedbackEvent({
      owner,
      platform: 'github',
      subjectId: subject.id,
      repoFullName: 'owner/repo',
      prNumber: 12,
      signalKind: 'negative_reaction',
      sentiment: 'negative',
      strength: 3,
      dedupeHash: 'dedupe-review-memory-event',
    });
    const second = await recordFeedbackEvent({
      owner,
      platform: 'github',
      subjectId: subject.id,
      repoFullName: 'owner/repo',
      prNumber: 12,
      signalKind: 'negative_reaction',
      sentiment: 'negative',
      strength: 3,
      dedupeHash: 'dedupe-review-memory-event',
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.event.id).toBe(first.event.id);

    const [state] = await db.select().from(code_review_memory_aggregation_state);
    expect(state.fresh_event_count).toBe(1);
    expect(state.fresh_weight).toBe(3);
    expect(state.fresh_distinct_subject_count).toBe(1);
    expect(state.fresh_distinct_pr_count).toBe(1);
    expect(state.status).toBe('eligible');
  });

  it('updates active proposals by dedupe key', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };

    const first = await upsertReviewMemoryProposal({
      owner,
      platform: 'github',
      repoFullName: 'owner/repo',
      proposalType: 'clarify',
      scopeKind: 'repository',
      title: 'Clarify noisy guidance',
      rationale: 'Maintainers corrected the same guidance.',
      proposedMarkdown: '### Review guidance: Clarify noisy guidance',
      dedupeKey: 'clarify-noisy-guidance',
      negativeCount: 1,
    });

    const second = await upsertReviewMemoryProposal({
      owner,
      platform: 'github',
      repoFullName: 'owner/repo',
      proposalType: 'clarify',
      scopeKind: 'repository',
      title: 'Clarify review guidance',
      rationale: 'Maintainers corrected the same guidance again.',
      proposedMarkdown: '### Review guidance: Clarify review guidance',
      dedupeKey: 'clarify-noisy-guidance',
      negativeCount: 2,
    });

    expect(second.id).toBe(first.id);
    expect(second.title).toBe('Clarify review guidance');
    expect(second.negative_count).toBe(2);

    const proposals = await db.select().from(code_review_memory_proposals);
    expect(proposals).toHaveLength(1);
  });

  it('does not edit proposals in non-actionable states', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    const proposal = await upsertReviewMemoryProposal({
      owner,
      platform: 'github',
      repoFullName: 'owner/repo',
      proposalType: 'clarify',
      scopeKind: 'repository',
      title: 'Clarify noisy guidance',
      rationale: 'Maintainers corrected the same guidance.',
      proposedMarkdown: '### Review guidance: Clarify noisy guidance',
      dedupeKey: 'clarify-noisy-guidance-edit-blocked',
    });
    const opening = await markProposalOpeningChangeRequest({
      owner,
      proposalId: proposal.id,
    });

    const edited = await updateReviewMemoryProposal({
      owner,
      proposalId: proposal.id,
      title: 'Edited title',
      rationale: 'Edited rationale',
      proposedMarkdown: '### Edited guidance',
      scopeKind: 'repository',
    });
    const rejected = await rejectReviewMemoryProposal({
      owner,
      proposalId: proposal.id,
    });
    const [stored] = await db
      .select()
      .from(code_review_memory_proposals)
      .where(eq(code_review_memory_proposals.id, proposal.id));

    expect(opening?.status).toBe('opening_change_request');
    expect(edited).toBeNull();
    expect(rejected).toBeNull();
    expect(stored.title).toBe('Clarify noisy guidance');
    expect(stored.status).toBe('opening_change_request');
  });

  it('prunes expired review memory rows and keeps retained data', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    const expiredCreatedAt = '2026-05-01T00:00:00.000Z';
    const now = new Date('2026-06-01T00:00:00.000Z');
    const expiredSubject = await upsertFeedbackSubject({
      owner,
      platform: 'github',
      repoFullName: 'owner/expired',
      subjectType: 'inline_comment',
      externalId: 'expired-subject',
      prNumber: 1,
      state: 'active',
    });
    const retainedSubject = await upsertFeedbackSubject({
      owner,
      platform: 'github',
      repoFullName: 'owner/retained',
      subjectType: 'inline_comment',
      externalId: 'retained-subject',
      prNumber: 2,
      state: 'active',
    });
    const expiredEvent = await recordFeedbackEvent({
      owner,
      platform: 'github',
      subjectId: expiredSubject.id,
      repoFullName: 'owner/expired',
      prNumber: 1,
      signalKind: 'corrective_reply',
      sentiment: 'negative',
      strength: 3,
      dedupeHash: 'retention-expired-prune-event',
    });
    const retainedEvent = await recordFeedbackEvent({
      owner,
      platform: 'github',
      subjectId: retainedSubject.id,
      repoFullName: 'owner/retained',
      prNumber: 2,
      signalKind: 'corrective_reply',
      sentiment: 'negative',
      strength: 4,
      dedupeHash: 'retention-retained-prune-event',
    });
    const expiredProposal = await upsertReviewMemoryProposal({
      owner,
      platform: 'github',
      repoFullName: 'owner/expired',
      proposalType: 'clarify',
      scopeKind: 'repository',
      title: 'Clarify expired guidance',
      rationale: 'This proposal should be pruned.',
      proposedMarkdown: '### Clarify expired guidance',
      dedupeKey: 'retention-expired-prune-proposal',
    });
    const retainedProposal = await upsertReviewMemoryProposal({
      owner,
      platform: 'github',
      repoFullName: 'owner/retained',
      proposalType: 'clarify',
      scopeKind: 'repository',
      title: 'Clarify retained guidance',
      rationale: 'This proposal should remain.',
      proposedMarkdown: '### Clarify retained guidance',
      dedupeKey: 'retention-retained-prune-proposal',
    });
    const openedProposal = await upsertReviewMemoryProposal({
      owner,
      platform: 'github',
      repoFullName: 'owner/expired',
      scopeKind: 'repository',
      proposalType: 'clarify',
      title: 'Expired opened proposal',
      rationale: 'It backs an opened change request.',
      proposedMarkdown: '### Expired opened proposal',
      dedupeKey: 'retention-opened-prune-proposal',
    });
    const approvedProposal = await upsertReviewMemoryProposal({
      owner,
      platform: 'github',
      repoFullName: 'owner/expired',
      scopeKind: 'repository',
      proposalType: 'clarify',
      title: 'Expired approved proposal',
      rationale: 'It has been approved by a maintainer.',
      proposedMarkdown: '### Expired approved proposal',
      dedupeKey: 'retention-approved-prune-proposal',
    });
    await db
      .update(code_review_feedback_subjects)
      .set({
        first_seen_at: expiredCreatedAt,
        last_seen_at: expiredCreatedAt,
        created_at: expiredCreatedAt,
        updated_at: expiredCreatedAt,
      })
      .where(eq(code_review_feedback_subjects.id, expiredSubject.id));
    await db
      .update(code_review_feedback_events)
      .set({ created_at: expiredCreatedAt, occurred_at: expiredCreatedAt })
      .where(eq(code_review_feedback_events.id, expiredEvent.event.id));
    await db
      .update(code_review_memory_proposals)
      .set({ created_at: expiredCreatedAt, updated_at: expiredCreatedAt })
      .where(eq(code_review_memory_proposals.id, expiredProposal.id));
    await db
      .update(code_review_memory_proposals)
      .set({
        created_at: expiredCreatedAt,
        updated_at: expiredCreatedAt,
        status: 'change_request_opened',
        change_request_url: 'https://github.com/owner/expired/pull/12',
      })
      .where(eq(code_review_memory_proposals.id, openedProposal.id));
    await db
      .update(code_review_memory_proposals)
      .set({
        created_at: expiredCreatedAt,
        updated_at: expiredCreatedAt,
        status: 'approved',
      })
      .where(eq(code_review_memory_proposals.id, approvedProposal.id));

    const summary = await pruneExpiredReviewMemoryData({ now });

    expect(summary).toEqual({
      cutoff: '2026-05-18T00:00:00.000Z',
      proposalsDeleted: 1,
      feedbackEventsDeleted: 1,
      subjectsDeleted: 1,
      aggregationStatesDeleted: 0,
    });

    await expect(db.select().from(code_review_feedback_events)).resolves.toEqual([
      expect.objectContaining({ id: retainedEvent.event.id }),
    ]);
    await expect(db.select().from(code_review_feedback_subjects)).resolves.toEqual([
      expect.objectContaining({ id: retainedSubject.id }),
    ]);
    const proposals = await db.select().from(code_review_memory_proposals);
    expect(proposals).toHaveLength(3);
    expect(proposals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: retainedProposal.id }),
        expect.objectContaining({ id: openedProposal.id }),
        expect.objectContaining({ id: approvedProposal.id }),
      ])
    );

    const states = await db.select().from(code_review_memory_aggregation_state);
    expect(states).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          repo_full_name: 'owner/retained',
          fresh_event_count: 1,
          fresh_weight: 4,
        }),
        expect.objectContaining({ repo_full_name: 'owner/expired' }),
      ])
    );
  });
});
