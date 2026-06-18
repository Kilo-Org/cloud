import { db } from '@/lib/drizzle';
import {
  cloud_agent_code_reviews,
  code_review_analytics_findings,
  code_review_analytics_results,
  kilocode_users,
  organizations,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  createCodeReview,
  createCodeReviewAttempt,
  updateCodeReviewStatus,
} from '../db/code-reviews';
import { finalizeCompletedCodeReviewWithAnalytics } from './db';
import type { CodeReviewAnalyticsManifest } from './contracts';

const capturedManifest: CodeReviewAnalyticsManifest = {
  schemaVersion: 1,
  taxonomyVersion: 1,
  change: {
    type: 'bug_fix',
    impact: 'high',
    complexity: 'medium',
    confidence: 'high',
  },
  findings: [
    { severity: 'critical', category: 'security', securityClass: 'auth_access' },
    { severity: 'warning', category: 'correctness', securityClass: null },
  ],
};

describe('Code Reviewer analytics completion persistence', () => {
  let userId: string;
  let organizationId: string;
  const reviewIds: string[] = [];

  beforeAll(async () => {
    userId = (await insertTestUser()).id;
    organizationId = (
      await createTestOrganization(
        `Review Analytics Persistence ${crypto.randomUUID()}`,
        userId,
        0,
        {},
        false
      )
    ).id;
  });

  afterAll(async () => {
    for (const reviewId of reviewIds) {
      await db.delete(cloud_agent_code_reviews).where(eq(cloud_agent_code_reviews.id, reviewId));
    }
    await db.delete(organizations).where(eq(organizations.id, organizationId));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, userId));
  });

  async function createRunningReview(analyticsEnabledAtDispatch: boolean) {
    const suffix = crypto.randomUUID();
    const reviewId = await createCodeReview({
      owner: { type: 'org', id: organizationId, userId },
      repoFullName: `analytics/repo-${suffix}`,
      prNumber: 1,
      prUrl: `https://github.com/analytics/repo-${suffix}/pull/1`,
      prTitle: 'Analytics test',
      prAuthor: 'octocat',
      prAuthorGithubId: '1234',
      baseRef: 'main',
      headRef: 'feature',
      headSha: suffix,
      platform: 'github',
    });
    reviewIds.push(reviewId);
    const attempt = await createCodeReviewAttempt({
      codeReviewId: reviewId,
      status: 'running',
      sessionId: `session-${suffix}`,
      analyticsEnabledAtDispatch,
    });
    await updateCodeReviewStatus(reviewId, 'running', {
      sessionId: attempt.session_id ?? undefined,
    });
    return { reviewId, attempt };
  }

  it('atomically completes an enrolled review and stores taxonomy-only findings', async () => {
    const { reviewId, attempt } = await createRunningReview(true);

    await expect(
      finalizeCompletedCodeReviewWithAnalytics({
        codeReviewId: reviewId,
        sourceAttemptId: attempt.id,
        sessionId: attempt.session_id ?? undefined,
        completedAt: new Date(),
        capture: { status: 'captured', manifest: capturedManifest },
      })
    ).resolves.toEqual({ outcome: 'applied' });

    const [review] = await db
      .select()
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.id, reviewId));
    const [result] = await db
      .select()
      .from(code_review_analytics_results)
      .where(eq(code_review_analytics_results.code_review_id, reviewId));
    const findings = await db
      .select()
      .from(code_review_analytics_findings)
      .where(eq(code_review_analytics_findings.analytics_result_id, result.id));

    expect(review.status).toBe('completed');
    expect(result).toEqual(
      expect.objectContaining({
        source_attempt_id: attempt.id,
        capture_status: 'captured',
        change_type: 'bug_fix',
        impact_level: 'high',
        complexity_level: 'medium',
        classification_confidence: 'high',
      })
    );
    expect(findings).toEqual([
      expect.objectContaining({
        ordinal: 0,
        severity: 'critical',
        category: 'security',
        security_class: 'auth_access',
      }),
      expect.objectContaining({
        ordinal: 1,
        severity: 'warning',
        category: 'correctness',
        security_class: null,
      }),
    ]);
  });

  it('repairs non-captured coverage once and never downgrades captured data', async () => {
    const { reviewId, attempt } = await createRunningReview(true);
    const baseInput = {
      codeReviewId: reviewId,
      sourceAttemptId: attempt.id,
      sessionId: attempt.session_id ?? undefined,
      completedAt: new Date(),
    };

    await expect(
      finalizeCompletedCodeReviewWithAnalytics({ ...baseInput, capture: { status: 'missing' } })
    ).resolves.toEqual({ outcome: 'applied' });
    await expect(
      finalizeCompletedCodeReviewWithAnalytics({
        ...baseInput,
        capture: { status: 'captured', manifest: capturedManifest },
      })
    ).resolves.toEqual({ outcome: 'repaired' });
    await expect(
      finalizeCompletedCodeReviewWithAnalytics({ ...baseInput, capture: { status: 'invalid' } })
    ).resolves.toEqual({ outcome: 'duplicate' });

    const [result] = await db
      .select()
      .from(code_review_analytics_results)
      .where(eq(code_review_analytics_results.code_review_id, reviewId));
    expect(result.capture_status).toBe('captured');
  });

  it.each(['missing', 'invalid', 'omitted'] as const)(
    'stores %s as coverage rather than a zero-finding capture',
    async captureStatus => {
      const { reviewId, attempt } = await createRunningReview(true);
      await finalizeCompletedCodeReviewWithAnalytics({
        codeReviewId: reviewId,
        sourceAttemptId: attempt.id,
        completedAt: new Date(),
        capture: { status: captureStatus },
      });

      const [result] = await db
        .select()
        .from(code_review_analytics_results)
        .where(eq(code_review_analytics_results.code_review_id, reviewId));
      const findings = await db
        .select()
        .from(code_review_analytics_findings)
        .where(eq(code_review_analytics_findings.analytics_result_id, result.id));

      expect(result).toEqual(
        expect.objectContaining({
          capture_status: captureStatus,
          change_type: null,
          impact_level: null,
        })
      );
      expect(findings).toEqual([]);
    }
  );

  it('does not write analytics for disabled or stale attempts', async () => {
    const disabled = await createRunningReview(false);
    const stale = await createRunningReview(true);
    const newerAttempt = await createCodeReviewAttempt({
      codeReviewId: stale.reviewId,
      status: 'running',
      analyticsEnabledAtDispatch: true,
    });

    await expect(
      finalizeCompletedCodeReviewWithAnalytics({
        codeReviewId: disabled.reviewId,
        sourceAttemptId: disabled.attempt.id,
        completedAt: new Date(),
        capture: { status: 'captured', manifest: capturedManifest },
      })
    ).resolves.toEqual({ outcome: 'stale' });
    await expect(
      finalizeCompletedCodeReviewWithAnalytics({
        codeReviewId: stale.reviewId,
        sourceAttemptId: stale.attempt.id,
        completedAt: new Date(),
        capture: { status: 'captured', manifest: capturedManifest },
      })
    ).resolves.toEqual({ outcome: 'stale' });

    const disabledResults = await db
      .select()
      .from(code_review_analytics_results)
      .where(eq(code_review_analytics_results.code_review_id, disabled.reviewId));
    const staleResults = await db
      .select()
      .from(code_review_analytics_results)
      .where(eq(code_review_analytics_results.code_review_id, stale.reviewId));
    expect(disabledResults).toEqual([]);
    expect(staleResults).toEqual([]);
    expect(newerAttempt.attempt_number).toBe(2);
  });

  it('rejects analytics persistence for personal reviews', async () => {
    const suffix = crypto.randomUUID();
    const reviewId = await createCodeReview({
      owner: { type: 'user', id: userId, userId },
      repoFullName: `analytics/personal-${suffix}`,
      prNumber: 1,
      prUrl: `https://github.com/analytics/personal-${suffix}/pull/1`,
      prTitle: 'Personal analytics test',
      prAuthor: 'octocat',
      prAuthorGithubId: '1234',
      baseRef: 'main',
      headRef: 'feature',
      headSha: suffix,
      platform: 'github',
    });
    reviewIds.push(reviewId);
    const attempt = await createCodeReviewAttempt({
      codeReviewId: reviewId,
      status: 'running',
      analyticsEnabledAtDispatch: true,
    });
    await updateCodeReviewStatus(reviewId, 'running');

    await expect(
      finalizeCompletedCodeReviewWithAnalytics({
        codeReviewId: reviewId,
        sourceAttemptId: attempt.id,
        completedAt: new Date(),
        capture: { status: 'captured', manifest: capturedManifest },
      })
    ).resolves.toEqual({ outcome: 'stale' });

    const results = await db
      .select()
      .from(code_review_analytics_results)
      .where(eq(code_review_analytics_results.code_review_id, reviewId));
    expect(results).toEqual([]);
  });
});
