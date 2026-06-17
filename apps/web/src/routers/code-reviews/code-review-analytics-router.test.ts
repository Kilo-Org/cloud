import { db } from '@/lib/drizzle';
import { kilocode_users, organizations } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

import { finalizeCompletedCodeReviewWithAnalytics } from '@/lib/code-reviews/analytics/db';
import { setReviewAnalyticsEnabled } from '@/lib/code-reviews/analytics/settings';
import {
  createCodeReview,
  createCodeReviewAttempt,
  updateCodeReviewStatus,
} from '@/lib/code-reviews/db/code-reviews';
import { addUserToOrganization } from '@/lib/organizations/organizations';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createCallerForUser } from '@/routers/test-utils';
import type { CodeReviewAnalyticsManifest } from '@/lib/code-reviews/analytics/contracts';

function manifest(input: {
  type: CodeReviewAnalyticsManifest['change']['type'];
  impact: CodeReviewAnalyticsManifest['change']['impact'];
  confidence?: CodeReviewAnalyticsManifest['change']['confidence'];
  findings?: CodeReviewAnalyticsManifest['findings'];
}): CodeReviewAnalyticsManifest {
  return {
    schemaVersion: 1,
    taxonomyVersion: 1,
    change: {
      type: input.type,
      impact: input.impact,
      complexity: 'medium',
      confidence: input.confidence ?? 'high',
    },
    findings: input.findings ?? [],
  };
}

describe('Code Reviewer analytics router', () => {
  let ownerId: string;
  let memberId: string;
  let outsiderId: string;
  let organizationId: string;

  beforeAll(async () => {
    const owner = await insertTestUser();
    const member = await insertTestUser();
    const outsider = await insertTestUser();
    const organization = await createTestOrganization(
      `Analytics Router ${crypto.randomUUID()}`,
      owner.id,
      0,
      {},
      false
    );
    ownerId = owner.id;
    memberId = member.id;
    outsiderId = outsider.id;
    organizationId = organization.id;
    await addUserToOrganization(organizationId, memberId, 'member');
    await setReviewAnalyticsEnabled({
      owner: { type: 'org', id: organizationId },
      platform: 'github',
      enabled: true,
      createdBy: ownerId,
    });
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, organizationId));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, ownerId));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, memberId));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, outsiderId));
  });

  async function captureReview(input: {
    repository: string;
    prNumber: number;
    headSha: string;
    analyticsManifest: CodeReviewAnalyticsManifest;
    owner?:
      | { type: 'org'; id: string; userId: string }
      | { type: 'user'; id: string; userId: string };
  }) {
    const reviewId = await createCodeReview({
      owner: input.owner ?? { type: 'org', id: organizationId, userId: ownerId },
      repoFullName: input.repository,
      prNumber: input.prNumber,
      prUrl: `https://github.com/${input.repository}/pull/${input.prNumber}`,
      prTitle: `PR ${input.prNumber}`,
      prAuthor: 'octocat',
      prAuthorGithubId: '1234',
      baseRef: 'main',
      headRef: `feature-${input.prNumber}`,
      headSha: input.headSha,
      platform: 'github',
    });
    const attempt = await createCodeReviewAttempt({
      codeReviewId: reviewId,
      status: 'running',
      analyticsEnabledAtDispatch: true,
    });
    await updateCodeReviewStatus(reviewId, 'running');
    await finalizeCompletedCodeReviewWithAnalytics({
      codeReviewId: reviewId,
      sourceAttemptId: attempt.id,
      completedAt: new Date(),
      capture: { status: 'captured', manifest: input.analyticsManifest },
    });
    return reviewId;
  }

  it('returns owner-scoped, deduplicated metrics and GitHub contributors to members', async () => {
    const repository = `analytics/router-${crypto.randomUUID()}`;
    await captureReview({
      repository,
      prNumber: 1,
      headSha: crypto.randomUUID(),
      analyticsManifest: manifest({
        type: 'feature',
        impact: 'high',
        findings: [
          { severity: 'critical', category: 'security', securityClass: 'auth_access' },
          { severity: 'warning', category: 'correctness', securityClass: null },
        ],
      }),
    });
    await captureReview({
      repository,
      prNumber: 1,
      headSha: crypto.randomUUID(),
      analyticsManifest: manifest({
        type: 'bug_fix',
        impact: 'medium',
        findings: [{ severity: 'suggestion', category: 'test_quality', securityClass: null }],
      }),
    });
    await captureReview({
      repository,
      prNumber: 2,
      headSha: crypto.randomUUID(),
      analyticsManifest: manifest({ type: 'feature', impact: 'high' }),
    });
    await captureReview({
      repository,
      prNumber: 3,
      headSha: crypto.randomUUID(),
      analyticsManifest: manifest({ type: 'bug_fix', impact: 'low' }),
    });
    await captureReview({
      repository,
      prNumber: 4,
      headSha: crypto.randomUUID(),
      analyticsManifest: manifest({ type: 'maintenance', impact: 'high', confidence: 'low' }),
    });
    await captureReview({
      repository,
      prNumber: 5,
      headSha: crypto.randomUUID(),
      analyticsManifest: manifest({
        type: 'bug_fix',
        impact: 'high',
        findings: [{ severity: 'warning', category: 'reliability', securityClass: null }],
      }),
    });

    const personalRepository = `analytics/personal-${crypto.randomUUID()}`;
    await captureReview({
      repository: personalRepository,
      prNumber: 99,
      headSha: crypto.randomUUID(),
      analyticsManifest: manifest({ type: 'feature', impact: 'high' }),
      owner: { type: 'user', id: outsiderId, userId: outsiderId },
    });

    const memberCaller = await createCallerForUser(memberId);
    const now = Date.now();
    const dashboard = await memberCaller.codeReviews.analytics.getDashboard({
      organizationId,
      platform: 'github',
      startDate: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
      endDate: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
    });

    expect(dashboard.settings).toEqual({ enabled: true, canManage: false, platform: 'github' });
    expect(dashboard.coverage).toEqual(
      expect.objectContaining({ enrolledCompletedReviews: 6, captured: 6, capturePercentage: 100 })
    );
    expect(dashboard.summary).toEqual({
      trackedReviews: 6,
      trackedPrsOrMrs: 5,
      totalFindings: 4,
      criticalFindings: 1,
      warningFindings: 2,
      highImpactChanges: 2,
      estimatedImpactPoints: 9,
    });
    expect(dashboard.repositoryOptions).toEqual([repository]);
    expect(dashboard.impactBreakdown.impact).toEqual({
      low: 1,
      medium: 1,
      high: 2,
      unclassified: 1,
    });
    expect(dashboard.repositories).toEqual([
      expect.objectContaining({
        repository,
        trackedPrsOrMrs: 5,
        estimatedImpactPoints: 9,
        criticalFindings: 1,
        warningFindings: 2,
        suggestionFindings: 1,
      }),
    ]);
    expect(dashboard.contributors.capability).toBe('available');
    expect(dashboard.contributors.rows).toEqual([
      expect.objectContaining({
        contributorKey: 'github-id:1234',
        rank: 1,
        limitedData: false,
        trackedPrs: 5,
        estimatedImpactPoints: 9,
        prsWithoutCriticalOrWarningFindings: 3,
      }),
    ]);
  });

  it('allows owner toggles while rejecting member mutation and non-member reads', async () => {
    const memberCaller = await createCallerForUser(memberId);
    const ownerCaller = await createCallerForUser(ownerId);
    const outsiderCaller = await createCallerForUser(outsiderId);
    const now = Date.now();

    await expect(
      memberCaller.codeReviews.analytics.setEnabled({
        organizationId,
        platform: 'github',
        enabled: false,
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      ownerCaller.codeReviews.analytics.setEnabled({
        organizationId,
        platform: 'github',
        enabled: false,
      })
    ).resolves.toEqual({ enabled: false });
    await expect(
      outsiderCaller.codeReviews.analytics.getDashboard({
        organizationId,
        platform: 'github',
        startDate: new Date(now - 60_000).toISOString(),
        endDate: new Date(now + 60_000).toISOString(),
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
