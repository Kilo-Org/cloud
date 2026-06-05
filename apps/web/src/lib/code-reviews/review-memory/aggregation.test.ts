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
import { eq, inArray } from 'drizzle-orm';
import { dispatchManualReviewMemoryAggregation } from './aggregation';
import {
  listProposalEvidence,
  recordFeedbackEvent,
  upsertFeedbackSubject,
  type ReviewMemoryOwner,
} from './db';

describe('review memory aggregation', () => {
  afterEach(async () => {
    await db.delete(code_review_memory_proposal_evidence);
    await db.delete(code_review_memory_proposals);
    await db.delete(code_review_memory_aggregation_runs);
    await db.delete(code_review_feedback_events);
    await db.delete(code_review_feedback_subjects);
    await db.delete(code_review_memory_aggregation_state);
    await db.delete(kilocode_users);
  });

  async function seedSubject(
    owner: ReviewMemoryOwner,
    externalId: string,
    prNumber: number,
    repoFullName = 'acme/widgets'
  ) {
    return await upsertFeedbackSubject({
      owner,
      platform: 'github',
      repoFullName,
      subjectType: 'inline_comment',
      externalId,
      prNumber,
      prUrl: `https://github.com/acme/widgets/pull/${prNumber}`,
      filePath: 'src/widget.ts',
      bodyExcerpt: '**WARNING**: Avoid this pattern',
      findingTitle: 'Avoid this pattern',
      findingFingerprint: `fingerprint-${externalId}`,
      state: 'active',
    });
  }

  async function seedActionableFeedback(owner: ReviewMemoryOwner, repoFullName = 'acme/widgets') {
    const subjects = await Promise.all([
      seedSubject(owner, `${repoFullName}-101`, 1, repoFullName),
      seedSubject(owner, `${repoFullName}-102`, 2, repoFullName),
      seedSubject(owner, `${repoFullName}-103`, 3, repoFullName),
    ]);
    const events = [];
    for (let i = 0; i < 5; i += 1) {
      const subject = subjects[i % subjects.length];
      const result = await recordFeedbackEvent({
        owner,
        platform: 'github',
        subjectId: subject.id,
        repoFullName,
        prNumber: subject.pr_number,
        prUrl: subject.pr_url,
        eventSource: 'github_webhook',
        signalKind: 'corrective_reply',
        sentiment: 'negative',
        strength: 3,
        externalEventId: `aggregation-actionable-${repoFullName}-${i}`,
        evidenceExcerpt: `False positive feedback ${i}`,
      });
      events.push(result.event);
    }
    return events;
  }

  it('does not claim scopes below the aggregation threshold', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    const subject = await seedSubject(owner, 'below-threshold', 1);
    await recordFeedbackEvent({
      owner,
      platform: 'github',
      subjectId: subject.id,
      repoFullName: 'acme/widgets',
      prNumber: 1,
      eventSource: 'github_webhook',
      signalKind: 'corrective_reply',
      sentiment: 'negative',
      strength: 3,
      externalEventId: 'aggregation-below-threshold',
    });

    const generateOpportunities = jest.fn();
    const summary = await dispatchManualReviewMemoryAggregation({ generateOpportunities });

    expect(summary).toEqual({ claimed: 0, completed: 0, skipped: 0, failed: 0, proposals: 0 });
    expect(generateOpportunities).not.toHaveBeenCalled();
  });

  it('aggregates actionable feedback into proposals and included evidence', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    const events = await seedActionableFeedback(owner);
    const generateOpportunities = jest.fn(async () => ({
      opportunities: [
        {
          title: 'Clarify widget warning',
          proposalType: 'clarify' as const,
          scopeKind: 'file' as const,
          scopeValue: 'src/widget.ts',
          rationale: 'Maintainers repeatedly corrected this warning.',
          proposedMarkdown:
            '### Review guidance: Clarify widget warning\n\nScope: `src/widget.ts`\n\nGuidance: Avoid flagging the intentional widget pattern.\n\nWhy: Maintainers marked repeated comments as false positives.',
          confidence: 'high' as const,
          evidenceEventIds: [events[0].id, events[1].id],
          contradictoryEventIds: [],
          dedupeHint: 'clarify widget warning',
        },
      ],
      tokensIn: 100,
      tokensOut: 50,
    }));

    const summary = await dispatchManualReviewMemoryAggregation({ generateOpportunities });

    expect(summary).toEqual({ claimed: 1, completed: 1, skipped: 0, failed: 0, proposals: 1 });
    expect(generateOpportunities).toHaveBeenCalledWith(
      expect.objectContaining({
        repoFullName: 'acme/widgets',
        modelSlug: expect.any(String),
        clusters: expect.any(Array),
      })
    );

    const proposals = await db.select().from(code_review_memory_proposals);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toEqual(
      expect.objectContaining({
        title: 'Clarify widget warning',
        status: 'open',
        negative_count: 2,
      })
    );
    const evidence = await listProposalEvidence({ proposalId: proposals[0].id });
    expect(evidence).toHaveLength(2);

    const includedEvents = await db.select().from(code_review_feedback_events);
    expect(includedEvents.every(event => event.aggregation_state === 'included')).toBe(true);

    const [run] = await db.select().from(code_review_memory_aggregation_runs);
    expect(run).toEqual(
      expect.objectContaining({ status: 'completed', tokens_in: 100, trigger: 'manual' })
    );
  });

  it('claims only the requested aggregation state', async () => {
    const targetUser = await insertTestUser();
    const otherUser = await insertTestUser();
    const targetOwner = { type: 'user' as const, id: targetUser.id };
    const otherOwner = { type: 'user' as const, id: otherUser.id };
    await seedActionableFeedback(targetOwner, 'acme/target');
    await seedActionableFeedback(otherOwner, 'acme/other');

    const [targetState] = await db
      .select()
      .from(code_review_memory_aggregation_state)
      .where(eq(code_review_memory_aggregation_state.repo_full_name, 'acme/target'));
    const generateOpportunities = jest.fn(async () => ({ opportunities: [] }));

    const summary = await dispatchManualReviewMemoryAggregation({
      stateId: targetState.id,
      limit: 1,
      generateOpportunities,
    });

    expect(summary).toEqual({ claimed: 1, completed: 1, skipped: 0, failed: 0, proposals: 0 });
    expect(generateOpportunities).toHaveBeenCalledWith(
      expect.objectContaining({ repoFullName: 'acme/target' })
    );

    const [otherState] = await db
      .select()
      .from(code_review_memory_aggregation_state)
      .where(eq(code_review_memory_aggregation_state.repo_full_name, 'acme/other'));
    expect(otherState.status).toBe('eligible');
  });

  it('does not aggregate feedback outside the retention window', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    const events = await seedActionableFeedback(owner, 'acme/expired');
    const now = new Date('2026-06-01T00:00:00.000Z');
    const expiredCreatedAt = '2026-05-01T00:00:00.000Z';
    await db
      .update(code_review_feedback_events)
      .set({ created_at: expiredCreatedAt, occurred_at: expiredCreatedAt })
      .where(
        inArray(
          code_review_feedback_events.id,
          events.map(event => event.id)
        )
      );
    await db
      .update(code_review_memory_aggregation_state)
      .set({ next_eligible_at: now.toISOString() })
      .where(eq(code_review_memory_aggregation_state.repo_full_name, 'acme/expired'));
    const generateOpportunities = jest.fn();

    const summary = await dispatchManualReviewMemoryAggregation({
      now,
      generateOpportunities,
    });

    expect(summary).toEqual({ claimed: 0, completed: 0, skipped: 0, failed: 0, proposals: 0 });
    expect(generateOpportunities).not.toHaveBeenCalled();
    await expect(db.select().from(code_review_feedback_events)).resolves.toHaveLength(5);
    await expect(db.select().from(code_review_memory_aggregation_state)).resolves.toHaveLength(1);
  });

  it('skips weak MR-level-only feedback without calling the model', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user' as const, id: user.id };
    for (let i = 0; i < 5; i += 1) {
      await recordFeedbackEvent({
        owner,
        platform: 'gitlab',
        repoFullName: 'acme/widgets',
        platformProjectId: 123,
        prNumber: i % 2 === 0 ? 1 : 2,
        eventSource: 'gitlab_webhook',
        signalKind: 'mr_approved',
        sentiment: 'positive',
        strength: 2,
        externalEventId: `aggregation-weak-${i}`,
      });
    }

    const generateOpportunities = jest.fn();
    const summary = await dispatchManualReviewMemoryAggregation({ generateOpportunities });

    expect(summary).toEqual({ claimed: 1, completed: 0, skipped: 1, failed: 0, proposals: 0 });
    expect(generateOpportunities).not.toHaveBeenCalled();

    const ignoredEvents = await db.select().from(code_review_feedback_events);
    expect(ignoredEvents.every(event => event.aggregation_state === 'ignored')).toBe(true);

    const [run] = await db.select().from(code_review_memory_aggregation_runs);
    expect(run.status).toBe('skipped');
    expect(run.trigger).toBe('manual');

    const [state] = await db
      .select()
      .from(code_review_memory_aggregation_state)
      .where(eq(code_review_memory_aggregation_state.repo_full_name, 'acme/widgets'));
    expect(state.status).toBe('idle');
  });
});
