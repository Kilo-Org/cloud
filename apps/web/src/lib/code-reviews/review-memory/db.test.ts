/* eslint-disable drizzle/enforce-delete-with-where */
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  code_review_feedback_events,
  code_review_feedback_subjects,
  code_review_memory_aggregation_state,
  code_review_memory_proposal_evidence,
  code_review_memory_proposals,
  kilocode_users,
} from '@kilocode/db/schema';
import { count, eq } from 'drizzle-orm';
import {
  listProposalEvidence,
  markProposalOpeningChangeRequest,
  recordFeedbackEvent,
  updateReviewMemoryProposal,
  upsertFeedbackSubject,
  upsertReviewMemoryProposal,
} from './db';

describe('review memory db helpers', () => {
  afterEach(async () => {
    await db.delete(code_review_memory_proposal_evidence);
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
});
