import { describe, expect, it, jest } from '@jest/globals';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { agent_configs, security_findings } from '@kilocode/db/schema';
import type { NewSecurityFinding } from '@kilocode/db/schema';
import type { SecurityFindingAnalysis } from '@kilocode/db/schema-types';
import { SecurityAuditLogActorType } from '@kilocode/db/schema-types';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { eq } from 'drizzle-orm';
import { autoDismissEligibleFindings, countEligibleForAutoDismiss } from './auto-dismiss-service';

const mockDismissDependabotAlert = jest.fn();

jest.mock('@/lib/security-agent/github/dependabot-api', () => ({
  dismissDependabotAlert: mockDismissDependabotAlert,
}));

function finding(
  userId: string,
  sourceId: string,
  overrides: Partial<NewSecurityFinding> = {}
): NewSecurityFinding {
  return {
    owned_by_user_id: userId,
    repo_full_name: 'acme/repo',
    source: 'dependabot',
    source_id: sourceId,
    severity: 'high',
    package_name: `package-${sourceId}`,
    package_ecosystem: 'npm',
    title: `Security Finding ${sourceId}`,
    analysis_status: 'completed',
    ...overrides,
  };
}

function triageAnalysis(
  triage: Partial<NonNullable<SecurityFindingAnalysis['triage']>> = {}
): SecurityFindingAnalysis {
  return {
    analyzedAt: '2026-06-16T10:00:00.000Z',
    triage: {
      suggestedAction: 'dismiss',
      confidence: 'high',
      needsSandboxAnalysis: false,
      needsSandboxReasoning: 'No runtime path',
      triageAt: '2026-06-16T10:00:00.000Z',
      ...triage,
    },
  };
}

const sandboxAnalysis = {
  analyzedAt: '2026-06-16T10:00:00.000Z',
  sandboxAnalysis: {
    isExploitable: false,
    exploitabilityReasoning: 'The vulnerable path is unreachable.',
    usageLocations: [],
    suggestedFix: 'Upgrade the dependency',
    suggestedAction: 'dismiss',
    summary: 'Not reachable',
    rawMarkdown: 'Not reachable',
    analysisAt: '2026-06-16T10:00:00.000Z',
  },
} satisfies SecurityFindingAnalysis;

async function enableAutoDismissFor(userId: string): Promise<void> {
  await db.insert(agent_configs).values({
    owned_by_user_id: userId,
    agent_type: 'security_scan',
    platform: 'github',
    config: { auto_dismiss_enabled: true, auto_dismiss_confidence_threshold: 'low' },
    is_enabled: true,
    created_by: userId,
  });
}

async function statusesBySourceId(userId: string): Promise<Record<string, string>> {
  const rows = await db
    .select({ sourceId: security_findings.source_id, status: security_findings.status })
    .from(security_findings)
    .where(eq(security_findings.owned_by_user_id, userId));

  return Object.fromEntries(rows.map(row => [row.sourceId, row.status]));
}

describe('auto-dismiss eligibility', () => {
  it('counts exactly the findings a bulk run dismisses for the same owner', async () => {
    const user = await insertTestUser();
    const otherUser = await insertTestUser();
    await enableAutoDismissFor(user.id);

    await db.insert(security_findings).values([
      finding(user.id, 'triage-high', { analysis: triageAnalysis({ confidence: 'high' }) }),
      finding(user.id, 'triage-medium', { analysis: triageAnalysis({ confidence: 'medium' }) }),
      finding(user.id, 'triage-low', { analysis: triageAnalysis({ confidence: 'low' }) }),
      finding(user.id, 'sandbox-present', {
        analysis: { ...sandboxAnalysis, triage: triageAnalysis().triage },
      }),
      finding(user.id, 'sandbox-null', {
        analysis: {
          analyzedAt: '2026-06-16T10:00:00.000Z',
          triage: triageAnalysis().triage,
          sandboxAnalysis: null,
        } as unknown as SecurityFindingAnalysis,
      }),
      finding(user.id, 'needs-sandbox', {
        analysis: triageAnalysis({ needsSandboxAnalysis: true }),
      }),
      finding(user.id, 'needs-sandbox-string', {
        analysis: triageAnalysis({ needsSandboxAnalysis: 'false' as unknown as boolean }),
      }),
      finding(user.id, 'already-ignored', {
        status: 'ignored',
        analysis: triageAnalysis(),
      }),
      finding(user.id, 'analysis-pending', {
        analysis_status: 'pending',
        analysis: triageAnalysis(),
      }),
      finding(user.id, 'manual-review', {
        analysis: triageAnalysis({ suggestedAction: 'manual_review' }),
      }),
      finding(user.id, 'no-triage', { analysis: { analyzedAt: '2026-06-16T10:00:00.000Z' } }),
      finding(otherUser.id, 'other-owner', { analysis: triageAnalysis() }),
    ]);

    await expect(countEligibleForAutoDismiss({ userId: user.id }, user.id)).resolves.toEqual({
      eligible: 3,
      byConfidence: { high: 1, medium: 1, low: 1 },
    });

    await expect(
      autoDismissEligibleFindings(
        { userId: user.id },
        {
          type: SecurityAuditLogActorType.CustomerUser,
          id: user.id,
          email: 'owner@example.com',
          name: 'Owner Example',
        }
      )
    ).resolves.toEqual({ dismissed: 3, skipped: 4, errors: 0 });

    await expect(statusesBySourceId(user.id)).resolves.toEqual({
      'triage-high': 'ignored',
      'triage-medium': 'ignored',
      'triage-low': 'ignored',
      'sandbox-present': 'open',
      'sandbox-null': 'open',
      'needs-sandbox': 'open',
      'needs-sandbox-string': 'open',
      'already-ignored': 'ignored',
      'analysis-pending': 'open',
      'manual-review': 'open',
      'no-triage': 'open',
    });

    await expect(countEligibleForAutoDismiss({ userId: user.id }, user.id)).resolves.toEqual({
      eligible: 0,
      byConfidence: { high: 0, medium: 0, low: 0 },
    });
    expect(mockDismissDependabotAlert).not.toHaveBeenCalled();
  });

  it('excludes triage rows whose confidence is not a known level', async () => {
    const user = await insertTestUser();

    await db.insert(security_findings).values([
      finding(user.id, 'confidence-high', { analysis: triageAnalysis({ confidence: 'high' }) }),
      finding(user.id, 'confidence-unknown', {
        analysis: triageAnalysis({ confidence: 'certain' as unknown as 'high' }),
      }),
    ]);

    await expect(countEligibleForAutoDismiss({ userId: user.id }, user.id)).resolves.toEqual({
      eligible: 1,
      byConfidence: { high: 1, medium: 0, low: 0 },
    });
  });
});
