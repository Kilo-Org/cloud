/* eslint-disable drizzle/enforce-delete-with-where */
import { db } from '@/lib/drizzle';
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
import { count, eq } from 'drizzle-orm';
import {
  createAggregationRun,
  countActionableProposals,
  listAggregationStates,
  listProposalEvidence,
  listReviewMemoryProposals,
  listReviewMemoryRepositories,
  markProposalOpeningChangeRequest,
  pruneExpiredReviewMemoryData,
  recordFeedbackEvent,
  refreshAggregationStateForScope,
  updateReviewMemoryProposal,
  upsertFeedbackSubject,
  upsertReviewMemoryProposal,
} from './db';

describe('review memory db helpers', () => {
  afterEach(async () => {
    await db.delete(code_review_memory_proposal_evidence);
    await db.delete(code_review_memory_proposals);
    await db.delete(code_review_memory_aggregation_runs);
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
      bodyExcerpt: 'Initial finding body',
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
      bodyExcerpt: 'Updated finding body',
      state: 'resolved',
    });

    expect(second.id).toBe(first.id);
    expect(second.state).toBe('resolved');
    expect(second.body_excerpt).toBe('Updated finding body');

    const rows = await db
      .select({ count: count() })
      .from(code_review_feedback_subjects)
      .where(eq(code_review_feedback_subjects.external_id, 'comment-123'));
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
      bodyExcerpt: 'First owner finding body',
      state: 'active',
    });
    const second = await upsertFeedbackSubject({
      owner: otherOwner,
      platform: 'github',
      repoFullName: 'owner/repo',
      subjectType: 'inline_comment',
      externalId: 'shared-comment-id',
      bodyExcerpt: 'Second owner finding body',
      state: 'resolved',
    });

    expect(second.id).not.toBe(first.id);

    const rows = await db
      .select()
      .from(code_review_feedback_subjects)
      .where(eq(code_review_feedback_subjects.external_id, 'shared-comment-id'));
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: first.id,
          owned_by_user_id: user.id,
          body_excerpt: 'First owner finding body',
          state: 'active',
        }),
        expect.objectContaining({
          id: second.id,
          owned_by_user_id: otherUser.id,
          body_excerpt: 'Second owner finding body',
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
      eventSource: 'github_webhook',
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
      eventSource: 'github_webhook',
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

  it('updates active proposals by dedupe key and links evidence once', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    const event = await recordFeedbackEvent({
      owner,
      platform: 'github',
      repoFullName: 'owner/repo',
      prNumber: 14,
      eventSource: 'github_webhook',
      signalKind: 'corrective_reply',
      sentiment: 'negative',
      strength: 4,
      dedupeHash: 'proposal-evidence-event',
    });

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
      distinctPrCount: 1,
      distinctSubjectCount: 1,
      evidence: [{ feedbackEventId: event.event.id, role: 'primary' }],
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
      distinctPrCount: 1,
      distinctSubjectCount: 1,
      evidence: [{ feedbackEventId: event.event.id, role: 'primary' }],
    });

    expect(second.id).toBe(first.id);
    expect(second.title).toBe('Clarify review guidance');
    expect(second.negative_count).toBe(2);

    const proposals = await db.select().from(code_review_memory_proposals);
    expect(proposals).toHaveLength(1);

    const evidence = await listProposalEvidence({ proposalId: second.id });
    expect(evidence).toHaveLength(1);
    expect(evidence[0].feedbackEvent.id).toBe(event.event.id);
    expect(evidence[0].role).toBe('primary');
  });

  it('does not mark a proposal opening twice', async () => {
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
      dedupeKey: 'clarify-noisy-guidance-opening',
    });

    const opening = await markProposalOpeningChangeRequest({
      owner,
      proposalId: proposal.id,
      approvedByUserId: user.id,
      changeRequestType: 'github_pr',
      branchName: 'kilo/review-memory/test',
    });
    const duplicateOpening = await markProposalOpeningChangeRequest({
      owner,
      proposalId: proposal.id,
      approvedByUserId: user.id,
      changeRequestType: 'github_pr',
      branchName: 'kilo/review-memory/test-again',
    });

    expect(opening?.status).toBe('opening_change_request');
    expect(duplicateOpening).toBeNull();
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
      approvedByUserId: user.id,
      changeRequestType: 'github_pr',
      branchName: 'kilo/review-memory/test',
    });

    const edited = await updateReviewMemoryProposal({
      owner,
      proposalId: proposal.id,
      editedByUserId: user.id,
      title: 'Edited title',
      rationale: 'Edited rationale',
      proposedMarkdown: '### Edited guidance',
      scopeKind: 'repository',
    });
    const [stored] = await db
      .select()
      .from(code_review_memory_proposals)
      .where(eq(code_review_memory_proposals.id, proposal.id));

    expect(opening?.status).toBe('opening_change_request');
    expect(edited).toBeNull();
    expect(stored.title).toBe('Clarify noisy guidance');
    expect(stored.status).toBe('opening_change_request');
  });

  it('refreshes aggregation state from retained fresh events only', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    const expiredCreatedAt = '2026-05-01T00:00:00.000Z';
    const now = new Date('2026-06-01T00:00:00.000Z');

    const expiredEvent = await recordFeedbackEvent({
      owner,
      platform: 'github',
      repoFullName: 'owner/repo',
      prNumber: 1,
      eventSource: 'github_webhook',
      signalKind: 'corrective_reply',
      sentiment: 'negative',
      strength: 3,
      externalEventId: 'retention-expired-refresh',
    });
    await recordFeedbackEvent({
      owner,
      platform: 'github',
      repoFullName: 'owner/repo',
      prNumber: 2,
      eventSource: 'github_webhook',
      signalKind: 'corrective_reply',
      sentiment: 'negative',
      strength: 4,
      externalEventId: 'retention-retained-refresh',
    });
    await db
      .update(code_review_feedback_events)
      .set({ created_at: expiredCreatedAt, occurred_at: expiredCreatedAt })
      .where(eq(code_review_feedback_events.id, expiredEvent.event.id));

    const state = await refreshAggregationStateForScope({
      owner,
      platform: 'github',
      repoFullName: 'owner/repo',
      now,
    });

    expect(state.fresh_event_count).toBe(1);
    expect(state.fresh_weight).toBe(4);
    expect(state.fresh_distinct_pr_count).toBe(1);
  });

  it('filters expired proposals and stale states from reads before cleanup runs', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    const expiredCreatedAt = '2026-05-01T00:00:00.000Z';

    const event = await recordFeedbackEvent({
      owner,
      platform: 'github',
      repoFullName: 'owner/repo',
      prNumber: 1,
      eventSource: 'github_webhook',
      signalKind: 'corrective_reply',
      sentiment: 'negative',
      strength: 3,
      externalEventId: 'retention-expired-read-event',
    });
    const proposal = await upsertReviewMemoryProposal({
      owner,
      platform: 'github',
      repoFullName: 'owner/repo',
      proposalType: 'clarify',
      scopeKind: 'repository',
      title: 'Clarify stale guidance',
      rationale: 'This proposal is outside the retention window.',
      proposedMarkdown: '### Clarify stale guidance',
      dedupeKey: 'retention-expired-read-proposal',
      evidence: [{ feedbackEventId: event.event.id, role: 'primary' }],
    });
    await db
      .update(code_review_feedback_events)
      .set({ created_at: expiredCreatedAt, occurred_at: expiredCreatedAt })
      .where(eq(code_review_feedback_events.id, event.event.id));
    await db
      .update(code_review_memory_proposals)
      .set({ created_at: expiredCreatedAt, updated_at: expiredCreatedAt })
      .where(eq(code_review_memory_proposals.id, proposal.id));

    await expect(listReviewMemoryProposals({ owner, platform: 'github' })).resolves.toHaveLength(0);
    await expect(countActionableProposals({ owner, platform: 'github' })).resolves.toBe(0);
    await expect(listReviewMemoryRepositories({ owner, platform: 'github' })).resolves.toHaveLength(
      0
    );
    await expect(listAggregationStates({ owner, platform: 'github' })).resolves.toHaveLength(0);
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
      eventSource: 'github_webhook',
      signalKind: 'corrective_reply',
      sentiment: 'negative',
      strength: 3,
      externalEventId: 'retention-expired-prune-event',
    });
    const retainedEvent = await recordFeedbackEvent({
      owner,
      platform: 'github',
      subjectId: retainedSubject.id,
      repoFullName: 'owner/retained',
      prNumber: 2,
      eventSource: 'github_webhook',
      signalKind: 'corrective_reply',
      sentiment: 'negative',
      strength: 4,
      externalEventId: 'retention-retained-prune-event',
    });
    const expiredRun = await createAggregationRun({
      owner,
      platform: 'github',
      repoFullName: 'owner/expired',
      modelSlug: 'test-model',
      trigger: 'manual',
      inputEventCount: 1,
    });
    const retainedRun = await createAggregationRun({
      owner,
      platform: 'github',
      repoFullName: 'owner/retained',
      modelSlug: 'test-model',
      trigger: 'manual',
      inputEventCount: 1,
    });
    const expiredProposal = await upsertReviewMemoryProposal({
      owner,
      platform: 'github',
      repoFullName: 'owner/expired',
      aggregationRunId: expiredRun.id,
      proposalType: 'clarify',
      scopeKind: 'repository',
      title: 'Clarify expired guidance',
      rationale: 'This proposal should be pruned.',
      proposedMarkdown: '### Clarify expired guidance',
      dedupeKey: 'retention-expired-prune-proposal',
      evidence: [{ feedbackEventId: expiredEvent.event.id, role: 'primary' }],
    });
    const retainedProposal = await upsertReviewMemoryProposal({
      owner,
      platform: 'github',
      repoFullName: 'owner/retained',
      aggregationRunId: retainedRun.id,
      proposalType: 'clarify',
      scopeKind: 'repository',
      title: 'Clarify retained guidance',
      rationale: 'This proposal should remain.',
      proposedMarkdown: '### Clarify retained guidance',
      dedupeKey: 'retention-retained-prune-proposal',
      evidence: [{ feedbackEventId: retainedEvent.event.id, role: 'primary' }],
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
      .update(code_review_memory_aggregation_runs)
      .set({ started_at: expiredCreatedAt, created_at: expiredCreatedAt })
      .where(eq(code_review_memory_aggregation_runs.id, expiredRun.id));
    await db
      .update(code_review_memory_proposals)
      .set({ created_at: expiredCreatedAt, updated_at: expiredCreatedAt })
      .where(eq(code_review_memory_proposals.id, expiredProposal.id));

    const summary = await pruneExpiredReviewMemoryData({ now });

    expect(summary).toEqual({
      cutoff: '2026-05-18T00:00:00.000Z',
      proposalsDeleted: 1,
      aggregationRunsDeleted: 1,
      feedbackEventsDeleted: 1,
      subjectsDeleted: 1,
      aggregationStatesDeleted: 1,
    });

    await expect(db.select().from(code_review_feedback_events)).resolves.toEqual([
      expect.objectContaining({ id: retainedEvent.event.id }),
    ]);
    await expect(db.select().from(code_review_feedback_subjects)).resolves.toEqual([
      expect.objectContaining({ id: retainedSubject.id }),
    ]);
    await expect(db.select().from(code_review_memory_aggregation_runs)).resolves.toEqual([
      expect.objectContaining({ id: retainedRun.id }),
    ]);
    await expect(db.select().from(code_review_memory_proposals)).resolves.toEqual([
      expect.objectContaining({ id: retainedProposal.id }),
    ]);
    await expect(db.select().from(code_review_memory_proposal_evidence)).resolves.toHaveLength(1);

    const [state] = await listAggregationStates({ owner, platform: 'github' });
    expect(state).toEqual(
      expect.objectContaining({
        repo_full_name: 'owner/retained',
        fresh_event_count: 1,
        fresh_weight: 4,
      })
    );
  });
});
