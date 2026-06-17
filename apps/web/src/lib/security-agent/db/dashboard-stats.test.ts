import { describe, expect, it } from '@jest/globals';
import { db } from '@/lib/drizzle';
import { security_findings } from '@kilocode/db/schema';
import type { NewSecurityFinding } from '@kilocode/db/schema';
import type { SecurityFindingAnalysis } from '@kilocode/db/schema-types';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { getDashboardStats } from './dashboard-stats';

const slaConfig = {
  slaCriticalDays: 15,
  slaHighDays: 30,
  slaMediumDays: 45,
  slaLowDays: 90,
};

function finding(
  userId: string,
  sourceId: string,
  overrides: Partial<NewSecurityFinding>
): NewSecurityFinding {
  return {
    owned_by_user_id: userId,
    repo_full_name: 'Kilo-Org/cloud',
    source: 'dependabot',
    source_id: sourceId,
    severity: 'high',
    package_name: `package-${sourceId}`,
    package_ecosystem: 'npm',
    title: `Security Finding ${sourceId}`,
    ...overrides,
  };
}

function analysis({
  isExploitable,
  suggestedAction,
}: {
  isExploitable: boolean | 'unknown';
  suggestedAction: 'dismiss' | 'open_pr' | 'manual_review' | 'monitor';
}): SecurityFindingAnalysis {
  return {
    analyzedAt: '2026-06-17T00:00:00.000Z',
    sandboxAnalysis: {
      isExploitable,
      exploitabilityReasoning: 'Test reasoning',
      usageLocations: [],
      suggestedFix: 'Update dependency',
      suggestedAction,
      summary: 'Test analysis',
      rawMarkdown: 'Test analysis',
      analysisAt: '2026-06-17T00:00:00.000Z',
    },
  };
}

describe('getDashboardStats', () => {
  it('returns guided urgency, priority, and repository action data within owner scope', async () => {
    const user = await insertTestUser();
    const otherUser = await insertTestUser();
    const now = Date.now();
    const overdueAt = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
    const dueSoonAt = new Date(now + 3 * 24 * 60 * 60 * 1000).toISOString();

    await db.insert(security_findings).values([
      finding(user.id, 'dashboard-overdue', {
        severity: 'critical',
        title: 'Critical overdue finding',
        sla_due_at: overdueAt,
      }),
      finding(user.id, 'dashboard-due-soon', {
        sla_due_at: dueSoonAt,
        analysis_status: 'completed',
        analysis: analysis({ isExploitable: true, suggestedAction: 'open_pr' }),
      }),
      finding(user.id, 'dashboard-review', {
        repo_full_name: 'Kilo-Org/kilocode',
        sla_due_at: null,
        analysis_status: 'completed',
        analysis: analysis({ isExploitable: 'unknown', suggestedAction: 'manual_review' }),
      }),
      finding(otherUser.id, 'dashboard-other-owner', {
        severity: 'critical',
        sla_due_at: overdueAt,
      }),
    ]);

    const result = await getDashboardStats({
      owner: { userId: user.id },
      slaEnabled: true,
      slaConfig,
    });

    expect(result.sla.overall).toEqual({ total: 2, withinSla: 1, overdue: 1 });
    expect(result.sla.dueSoon).toEqual({ total: 1, exploitable: 1 });
    expect(result.sla.untrackedCount).toBe(1);
    expect(result.severity).toEqual({ critical: 1, high: 2, medium: 0, low: 0 });
    expect(result.analysis).toMatchObject({
      total: 3,
      analyzed: 2,
      exploitable: 1,
      needsReview: 1,
      notAnalyzed: 1,
    });
    expect(result.priorityFinding).toMatchObject({
      severity: 'critical',
      title: 'Critical overdue finding',
      repoFullName: 'Kilo-Org/cloud',
      analysisStatus: null,
      isExploitable: null,
      slaDueAt: overdueAt,
      daysOverdue: 2,
    });
    expect(result.priorityFinding?.slaDueAt).toMatch(/T/);
    expect(result.repositoryCount).toBe(2);
    expect(result.repoHealth).toEqual([
      {
        repoFullName: 'Kilo-Org/cloud',
        open: 2,
        critical: 1,
        high: 1,
        medium: 0,
        low: 0,
        overdue: 1,
        exploitable: 1,
        needsAction: 2,
        slaCompliancePercent: 50,
      },
      {
        repoFullName: 'Kilo-Org/kilocode',
        open: 1,
        critical: 0,
        high: 1,
        medium: 0,
        low: 0,
        overdue: 0,
        exploitable: 0,
        needsAction: 1,
        slaCompliancePercent: 100,
      },
    ]);
  });

  it('applies the exact repository filter and risk-first ordering when SLA is disabled', async () => {
    const user = await insertTestUser();
    const overdueAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

    await db.insert(security_findings).values([
      finding(user.id, 'dashboard-filter-cloud', { repo_full_name: 'Kilo-Org/cloud' }),
      finding(user.id, 'dashboard-filter-web-complete', {
        repo_full_name: 'Kilo-Org/web',
        title: 'Completed analysis with expired deadline',
        sla_due_at: overdueAt,
        analysis_status: 'completed',
        analysis: analysis({ isExploitable: false, suggestedAction: 'monitor' }),
      }),
      finding(user.id, 'dashboard-filter-web-needs-analysis', {
        repo_full_name: 'Kilo-Org/web',
        title: 'Finding needing analysis',
      }),
    ]);

    const result = await getDashboardStats({
      owner: { userId: user.id },
      repoFullName: 'Kilo-Org/web',
      slaEnabled: false,
      slaConfig,
    });

    expect(result.analysis.total).toBe(2);
    expect(result.repositoryCount).toBe(1);
    expect(result.repoHealth).toHaveLength(1);
    expect(result.repoHealth[0]?.repoFullName).toBe('Kilo-Org/web');
    expect(result.priorityFinding).toMatchObject({
      repoFullName: 'Kilo-Org/web',
      title: 'Finding needing analysis',
      analysisStatus: null,
    });
  });
});
