import { db } from '@/lib/drizzle';
import { kilocode_users, organizations, platform_integrations } from '@kilocode/db/schema';
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
  let organizationIntegrationId: string;
  let outsiderIntegrationId: string;

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
    const [organizationIntegration, outsiderIntegration] = await db
      .insert(platform_integrations)
      .values([
        {
          owned_by_organization_id: organizationId,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: `analytics-org-${crypto.randomUUID()}`,
          platform_account_id: 'analytics-org',
          platform_account_login: 'analytics-org',
          repository_access: 'all',
          integration_status: 'active',
        },
        {
          owned_by_user_id: outsiderId,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: `analytics-user-${crypto.randomUUID()}`,
          platform_account_id: 'analytics-user',
          platform_account_login: 'analytics-user',
          repository_access: 'all',
          integration_status: 'active',
        },
      ])
      .returning({ id: platform_integrations.id });
    if (!organizationIntegration || !outsiderIntegration) {
      throw new Error('Expected analytics review integrations');
    }
    organizationIntegrationId = organizationIntegration.id;
    outsiderIntegrationId = outsiderIntegration.id;
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
    model?: string;
    analyticsManifest: CodeReviewAnalyticsManifest;
    owner?:
      | { type: 'org'; id: string; userId: string }
      | { type: 'user'; id: string; userId: string };
  }) {
    const owner = input.owner ?? { type: 'org' as const, id: organizationId, userId: ownerId };
    const reviewId = await createCodeReview({
      owner,
      platformIntegrationId:
        owner.type === 'org' ? organizationIntegrationId : outsiderIntegrationId,
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
    await updateCodeReviewStatus(
      reviewId,
      'running',
      input.model === undefined ? {} : { model: input.model }
    );
    await finalizeCompletedCodeReviewWithAnalytics({
      codeReviewId: reviewId,
      sourceAttemptId: attempt.id,
      completedAt: new Date(),
      capture: { status: 'captured', manifest: input.analyticsManifest },
    });
    return reviewId;
  }

  async function completeEnrolledReviewWithoutAnalyticsResult(repository: string) {
    const completedAt = new Date();
    const reviewId = await createCodeReview({
      owner: { type: 'org', id: organizationId, userId: ownerId },
      platformIntegrationId: organizationIntegrationId,
      repoFullName: repository,
      prNumber: 1,
      prUrl: `https://github.com/${repository}/pull/1`,
      prTitle: 'Missing analytics result',
      prAuthor: 'octocat',
      prAuthorGithubId: '1234',
      baseRef: 'main',
      headRef: 'feature-missing-result',
      headSha: crypto.randomUUID(),
      platform: 'github',
    });
    await createCodeReviewAttempt({
      codeReviewId: reviewId,
      status: 'completed',
      completedAt,
      analyticsEnabledAtDispatch: true,
    });
    await updateCodeReviewStatus(reviewId, 'completed', { completedAt });
  }

  it('returns owner-scoped, deduplicated metrics and GitHub contributors to members', async () => {
    const repository = `analytics/router-${crypto.randomUUID()}`;
    const claudeModel = 'anthropic/claude-sonnet-4.6';
    const gptModel = 'openai/gpt-5.1';
    await captureReview({
      repository,
      prNumber: 1,
      headSha: crypto.randomUUID(),
      model: claudeModel,
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
      model: claudeModel,
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
      model: gptModel,
      analyticsManifest: manifest({
        type: 'feature',
        impact: 'high',
        findings: [{ severity: 'suggestion', category: 'performance', securityClass: null }],
      }),
    });
    await captureReview({
      repository,
      prNumber: 3,
      headSha: crypto.randomUUID(),
      model: gptModel,
      analyticsManifest: manifest({ type: 'bug_fix', impact: 'low' }),
    });
    await captureReview({
      repository,
      prNumber: 4,
      headSha: crypto.randomUUID(),
      model: gptModel,
      analyticsManifest: manifest({ type: 'maintenance', impact: 'high', confidence: 'low' }),
    });
    await captureReview({
      repository,
      prNumber: 5,
      headSha: crypto.randomUUID(),
      model: gptModel,
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
    const dashboard = await memberCaller.codeReviews.analytics.getDashboard({
      organizationId,
      platform: 'github',
      periodDays: 7,
    });

    expect(dashboard.settings).toEqual({ enabled: true, canManage: false, platform: 'github' });
    expect(dashboard.coverage).toEqual(
      expect.objectContaining({ enrolledCompletedReviews: 6, captured: 6, capturePercentage: 100 })
    );
    expect(dashboard.summary).toEqual({
      trackedReviews: 6,
      trackedPrsOrMrs: 5,
      totalFindings: 5,
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
    expect(dashboard.modelBreakdown).toEqual([
      {
        model: claudeModel,
        trackedReviews: 2,
        totalFindings: 3,
        criticalFindings: 1,
        warningFindings: 1,
        suggestionFindings: 1,
      },
      {
        model: gptModel,
        trackedReviews: 4,
        totalFindings: 2,
        criticalFindings: 0,
        warningFindings: 1,
        suggestionFindings: 1,
      },
    ]);
    expect(dashboard.repositories).toEqual([
      expect.objectContaining({
        repository,
        trackedPrsOrMrs: 5,
        estimatedImpactPoints: 9,
        criticalFindings: 1,
        warningFindings: 2,
        suggestionFindings: 2,
      }),
    ]);
    expect(dashboard.contributors.capability).toBe('available');
    expect(dashboard.contributors.rows).toEqual([
      expect.objectContaining({
        contributorKey: 'github-id:1234',
        limitedData: false,
        trackedPrs: 5,
        estimatedImpactPoints: 9,
        prsWithoutCriticalFindings: 4,
      }),
    ]);
  });

  it('counts an enrolled completion without a result as missing coverage', async () => {
    const repository = `analytics/missing-${crypto.randomUUID()}`;
    await completeEnrolledReviewWithoutAnalyticsResult(repository);
    const memberCaller = await createCallerForUser(memberId);

    const dashboard = await memberCaller.codeReviews.analytics.getDashboard({
      organizationId,
      platform: 'github',
      periodDays: 7,
      repository,
    });

    expect(dashboard.coverage).toEqual({
      enrolledCompletedReviews: 1,
      captured: 0,
      missing: 1,
      invalid: 0,
      omitted: 0,
      capturePercentage: 0,
    });
    expect(dashboard.summary).toEqual({
      trackedReviews: 0,
      trackedPrsOrMrs: 0,
      totalFindings: 0,
      criticalFindings: 0,
      warningFindings: 0,
      highImpactChanges: 0,
      estimatedImpactPoints: 0,
    });
    expect(dashboard.repositoryOptions).toContain(repository);
    expect(dashboard.modelBreakdown).toEqual([]);
  });

  it('requires organization scope for reads and settings changes', async () => {
    const caller = await createCallerForUser(ownerId);

    await expect(
      caller.codeReviews.analytics.getDashboard({
        platform: 'github',
        periodDays: 7,
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.codeReviews.analytics.setEnabled({
        platform: 'github',
        enabled: true,
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('allows owner toggles while rejecting member mutation and non-member reads', async () => {
    const memberCaller = await createCallerForUser(memberId);
    const ownerCaller = await createCallerForUser(ownerId);
    const outsiderCaller = await createCallerForUser(outsiderId);

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
        periodDays: 7,
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
