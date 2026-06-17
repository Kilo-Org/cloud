'use client';

import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/nextjs';
import { SecurityDashboardView } from '@/components/security-agent/SecurityDashboard';
import type { DashboardStats } from '@/lib/security-agent/db/dashboard-stats';

const meta: Meta = {
  title: 'Security Agent/Guided Dashboard',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Production Security Agent dashboard with task-first priority guidance, deadline posture, analysis understanding, and repository actions.',
      },
    },
  },
  tags: ['!autodocs'],
};

export default meta;

type Story = StoryObj<typeof meta>;

type Repository = {
  id: number;
  fullName: string;
  name: string;
  private: boolean;
};

const repositories: Repository[] = [
  { id: 1, fullName: 'Kilo-Org/cloud', name: 'cloud', private: true },
  { id: 2, fullName: 'Kilo-Org/kilocode-landing', name: 'kilocode-landing', private: false },
  { id: 3, fullName: 'Kilo-Org/kilocode', name: 'kilocode', private: true },
  { id: 4, fullName: 'Kilo-Org/handbook', name: 'handbook', private: true },
];

const dashboardData = {
  sla: {
    overall: { total: 83, withinSla: 55, overdue: 28 },
    bySeverity: {
      critical: { total: 1, withinSla: 0, overdue: 1 },
      high: { total: 33, withinSla: 19, overdue: 14 },
      medium: { total: 35, withinSla: 32, overdue: 3 },
      low: { total: 14, withinSla: 4, overdue: 10 },
    },
    dueSoon: { total: 7, exploitable: 2 },
    untrackedCount: 4,
  },
  severity: { critical: 1, high: 33, medium: 35, low: 14 },
  status: { open: 83, fixed: 51, ignored: 17 },
  analysis: {
    total: 83,
    analyzed: 76,
    exploitable: 9,
    notExploitable: 22,
    triageComplete: 2,
    safeToDismiss: 36,
    needsReview: 9,
    analyzing: 2,
    notAnalyzed: 3,
    failed: 0,
  },
  mttr: {
    bySeverity: {
      critical: { avgDays: 6, medianDays: 5, count: 4, slaDays: 15 },
      high: { avgDays: 12, medianDays: 10, count: 18, slaDays: 30 },
      medium: { avgDays: 18, medianDays: 15, count: 25, slaDays: 45 },
      low: { avgDays: 30, medianDays: 25, count: 21, slaDays: 90 },
    },
  },
  overdue: [
    {
      id: 'finding-critical-overdue',
      severity: 'critical',
      title: 'Remote code execution through vulnerable workflow dependency',
      repoFullName: 'Kilo-Org/cloud',
      packageName: 'workflow-core',
      slaDueAt: '2026-06-15T10:00:00.000Z',
      daysOverdue: 2,
    },
  ],
  priorityFinding: {
    id: 'finding-critical-overdue',
    severity: 'critical',
    title: 'Remote code execution through vulnerable workflow dependency',
    repoFullName: 'Kilo-Org/cloud',
    analysisStatus: null,
    isExploitable: null,
    suggestedAction: null,
    slaDueAt: '2026-06-15T10:00:00.000Z',
    daysOverdue: 2,
  },
  repoHealth: [
    {
      repoFullName: 'Kilo-Org/cloud',
      open: 25,
      critical: 1,
      high: 12,
      medium: 8,
      low: 4,
      overdue: 3,
      exploitable: 3,
      needsAction: 4,
      slaCompliancePercent: 52,
    },
    {
      repoFullName: 'Kilo-Org/kilocode-landing',
      open: 33,
      critical: 0,
      high: 17,
      medium: 12,
      low: 4,
      overdue: 16,
      exploitable: 3,
      needsAction: 3,
      slaCompliancePercent: 51,
    },
    {
      repoFullName: 'Kilo-Org/kilocode',
      open: 19,
      critical: 0,
      high: 3,
      medium: 10,
      low: 6,
      overdue: 6,
      exploitable: 3,
      needsAction: 3,
      slaCompliancePercent: 68,
    },
    {
      repoFullName: 'Kilo-Org/handbook',
      open: 6,
      critical: 0,
      high: 1,
      medium: 5,
      low: 0,
      overdue: 0,
      exploitable: 0,
      needsAction: 0,
      slaCompliancePercent: 100,
    },
  ],
  repositoryCount: 4,
} satisfies DashboardStats;

function filteredDashboardData(repoFullName: string | undefined): DashboardStats {
  if (!repoFullName) return dashboardData;
  const repository = dashboardData.repoHealth.find(item => item.repoFullName === repoFullName);
  if (!repository) return dashboardData;

  const criticalOverdue = Math.min(repository.critical, repository.overdue);
  const highOverdue = Math.min(repository.high, repository.overdue - criticalOverdue);
  const mediumOverdue = Math.min(
    repository.medium,
    repository.overdue - criticalOverdue - highOverdue
  );
  const lowOverdue = Math.max(
    0,
    repository.overdue - criticalOverdue - highOverdue - mediumOverdue
  );
  const priorityNeedsAnalysis = repository.needsAction > repository.exploitable;
  const notAnalyzed = priorityNeedsAnalysis ? 1 : 0;
  const needsReview = Math.max(0, repository.needsAction - repository.exploitable - notAnalyzed);
  const notExploitable = Math.max(
    0,
    repository.open - repository.exploitable - needsReview - notAnalyzed
  );
  const slaDueAt = repository.overdue > 0 ? '2026-06-15T10:00:00.000Z' : null;
  const prioritySeverity = repository.critical > 0 ? 'critical' : 'high';
  const priorityExploitability: true | 'unknown' | null = priorityNeedsAnalysis
    ? null
    : repository.exploitable > 0
      ? true
      : 'unknown';
  const priorityAction: 'open_pr' | 'manual_review' | null = priorityNeedsAnalysis
    ? null
    : repository.exploitable > 0
      ? 'open_pr'
      : 'manual_review';
  const priorityFinding: DashboardStats['priorityFinding'] =
    repository.needsAction > 0
      ? {
          id: `finding-${repository.repoFullName}`,
          severity: prioritySeverity,
          title: `Highest-priority finding in ${repository.repoFullName}`,
          repoFullName: repository.repoFullName,
          analysisStatus: priorityNeedsAnalysis ? null : 'completed',
          isExploitable: priorityExploitability,
          suggestedAction: priorityAction,
          slaDueAt,
          daysOverdue: repository.overdue > 0 ? 2 : null,
        }
      : null;

  return {
    ...dashboardData,
    sla: {
      overall: {
        total: repository.open,
        withinSla: repository.open - repository.overdue,
        overdue: repository.overdue,
      },
      bySeverity: {
        critical: {
          total: repository.critical,
          withinSla: repository.critical - criticalOverdue,
          overdue: criticalOverdue,
        },
        high: {
          total: repository.high,
          withinSla: repository.high - highOverdue,
          overdue: highOverdue,
        },
        medium: {
          total: repository.medium,
          withinSla: repository.medium - mediumOverdue,
          overdue: mediumOverdue,
        },
        low: {
          total: repository.low,
          withinSla: repository.low - lowOverdue,
          overdue: lowOverdue,
        },
      },
      dueSoon: { total: 0, exploitable: 0 },
      untrackedCount: 0,
    },
    severity: {
      critical: repository.critical,
      high: repository.high,
      medium: repository.medium,
      low: repository.low,
    },
    status: { open: repository.open, fixed: 0, ignored: 0 },
    analysis: {
      total: repository.open,
      analyzed: repository.open - notAnalyzed,
      exploitable: repository.exploitable,
      notExploitable,
      triageComplete: 0,
      safeToDismiss: 0,
      needsReview,
      analyzing: 0,
      notAnalyzed,
      failed: 0,
    },
    overdue:
      priorityFinding && repository.overdue > 0
        ? [
            {
              id: priorityFinding.id,
              severity: priorityFinding.severity,
              title: priorityFinding.title,
              repoFullName: priorityFinding.repoFullName,
              packageName: 'example-package',
              slaDueAt: priorityFinding.slaDueAt ?? '2026-06-15T10:00:00.000Z',
              daysOverdue: priorityFinding.daysOverdue ?? 0,
            },
          ]
        : [],
    priorityFinding,
    repoHealth: [repository],
    repositoryCount: 1,
  };
}

function StoryShell({
  slaEnabled,
  state = 'ready',
}: {
  slaEnabled: boolean;
  state?: 'ready' | 'loading' | 'error';
}) {
  const [repoFullName, setRepoFullName] = useState<string | undefined>(undefined);
  const [isSyncing, setIsSyncing] = useState(false);
  const data = filteredDashboardData(repoFullName);

  function syncFindings() {
    setIsSyncing(true);
    window.setTimeout(() => setIsSyncing(false), 900);
  }

  return (
    <main className="bg-background text-foreground min-h-screen px-4 py-8 sm:px-6 lg:px-10 lg:py-12">
      <div className="mx-auto max-w-[1140px]">
        <SecurityDashboardView
          basePath="/security-agent"
          data={data}
          isLoading={state === 'loading'}
          isError={state === 'error'}
          slaEnabled={slaEnabled}
          repositories={repositories}
          repoFullName={repoFullName}
          lastUpdated="Last synced about 1 hour ago"
          isSyncing={isSyncing}
          onRepositoryChange={setRepoFullName}
          onSync={syncFindings}
          onRetry={() => undefined}
        />
      </div>
    </main>
  );
}

export const SlaEnabled: Story = {
  render: () => <StoryShell slaEnabled />,
  parameters: {
    docs: {
      description: {
        story:
          'Default dashboard with deadline health, priority guidance, analysis understanding, and repository actions.',
      },
    },
  },
};

export const SlaDisabled: Story = {
  render: () => <StoryShell slaEnabled={false} />,
  parameters: {
    docs: {
      description: {
        story:
          'SLA-disabled dashboard replaces deadline data with risk, analysis, and team-decision guidance.',
      },
    },
  },
};

export const Loading: Story = {
  render: () => <StoryShell slaEnabled state="loading" />,
};

export const LoadError: Story = {
  render: () => <StoryShell slaEnabled state="error" />,
};
