'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import {
  AlertCircle,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  CircleHelp,
  Clock,
  FileSearch,
  Loader2,
  RefreshCw,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { DashboardStats } from '@/lib/security-agent/db/dashboard-stats';
import { useTRPC } from '@/lib/trpc/utils';
import {
  buildSecurityDashboardMetrics,
  type DashboardMetricKey,
  getAnalysisIncompleteCount as getSharedAnalysisIncompleteCount,
} from '@kilocode/app-shared/security-agent';
import { RepositoryFilter } from './RepositoryFilter';
import { SecurityAgentActionBar, SecurityAgentActionBarField } from './SecurityAgentActionBar';
import { SecurityAgentGitHubInstallCta } from './SecurityAgentGitHubInstallCta';
import { useSecurityAgent } from './SecurityAgentContext';

const emptyDashboardStats: DashboardStats = {
  sla: {
    overall: { total: 0, withinSla: 0, overdue: 0 },
    bySeverity: {
      critical: { total: 0, withinSla: 0, overdue: 0 },
      high: { total: 0, withinSla: 0, overdue: 0 },
      medium: { total: 0, withinSla: 0, overdue: 0 },
      low: { total: 0, withinSla: 0, overdue: 0 },
    },
    dueSoon: { total: 0, exploitable: 0 },
    untrackedCount: 0,
  },
  severity: { critical: 0, high: 0, medium: 0, low: 0 },
  status: { open: 0, fixed: 0, ignored: 0 },
  analysis: {
    total: 0,
    analyzed: 0,
    exploitable: 0,
    notExploitable: 0,
    triageComplete: 0,
    safeToDismiss: 0,
    needsReview: 0,
    analyzing: 0,
    notAnalyzed: 0,
    failed: 0,
  },
  mttr: {
    bySeverity: {
      critical: { avgDays: null, medianDays: null, count: 0, slaDays: 15 },
      high: { avgDays: null, medianDays: null, count: 0, slaDays: 30 },
      medium: { avgDays: null, medianDays: null, count: 0, slaDays: 45 },
      low: { avgDays: null, medianDays: null, count: 0, slaDays: 90 },
    },
  },
  overdue: [],
  priorityFinding: null,
  repoHealth: [],
  repositoryCount: 0,
};

type Repository = {
  id: number;
  fullName: string;
  name: string;
  private: boolean;
};

type MetricTone = 'danger' | 'warning' | 'neutral';

type DashboardMetric = {
  id: DashboardMetricKey;
  label: string;
  value: string;
  detail: string;
  icon: LucideIcon;
  tone: MetricTone;
};

type SecurityDashboardViewProps = {
  basePath: string;
  data: DashboardStats;
  isLoading: boolean;
  isError: boolean;
  slaEnabled: boolean;
  repositories: Repository[];
  repoFullName: string | undefined;
  lastUpdated: string | null;
  isSyncing: boolean;
  onRepositoryChange: (repoFullName: string | undefined) => void;
  onSync: () => void;
  onRetry: () => void;
};

type SummaryTone = 'danger' | 'warning' | 'success' | 'neutral';

function getAnalysisIncompleteCount(analysis: DashboardStats['analysis']): number {
  return getSharedAnalysisIncompleteCount(analysis);
}

function getNeedsActionCount(analysis: DashboardStats['analysis']): number {
  return (
    analysis.exploitable +
    analysis.needsReview +
    analysis.triageComplete +
    analysis.notAnalyzed +
    analysis.failed
  );
}

function findingsHref(
  basePath: string,
  params: Record<string, string | number | boolean | undefined>
): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) searchParams.set(key, String(value));
  }
  const query = searchParams.toString();
  return `${basePath}/findings${query ? `?${query}` : ''}`;
}

function titleCaseSeverity(severity: string): string {
  return severity.length > 0 ? `${severity[0].toUpperCase()}${severity.slice(1)}` : 'Security';
}

export function SecurityDashboard() {
  const {
    hasIntegration,
    isLoadingPermission,
    isOrg,
    organizationId,
    configData,
    filteredRepositories,
    handleSync,
    isSyncing,
  } = useSecurityAgent();
  const trpc = useTRPC();
  const [repoFullName, setRepoFullName] = useState<string | undefined>(undefined);
  const basePath = isOrg ? `/organizations/${organizationId}/security-agent` : '/security-agent';
  const slaEnabled = configData?.slaEnabled ?? true;

  const {
    data: dashboardData,
    isLoading: isDashboardLoading,
    isError: dashboardHasError,
    refetch: refetchDashboard,
  } = useQuery({
    ...(isOrg
      ? trpc.organizations.securityAgent.getDashboardStats.queryOptions({
          organizationId: organizationId ?? '',
          repoFullName,
        })
      : trpc.securityAgent.getDashboardStats.queryOptions({ repoFullName })),
    staleTime: 30_000,
    enabled: hasIntegration,
  });

  const { data: lastSyncData } = useQuery({
    ...(isOrg
      ? trpc.organizations.securityAgent.getLastSyncTime.queryOptions({
          organizationId: organizationId ?? '',
          repoFullName,
        })
      : trpc.securityAgent.getLastSyncTime.queryOptions({ repoFullName })),
    enabled: hasIntegration,
  });

  if (isLoadingPermission) {
    return (
      <div className="text-muted-foreground flex items-center justify-center gap-2 py-16 text-sm">
        <Loader2 className="size-6 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        Loading security dashboard...
      </div>
    );
  }

  if (!hasIntegration) {
    const installUrl = isOrg
      ? `/organizations/${organizationId}/integrations`
      : '/integrations/github';
    return <SecurityAgentGitHubInstallCta installUrl={installUrl} />;
  }

  const lastSyncTime = lastSyncData?.lastSyncTime;
  const lastUpdated = lastSyncTime
    ? `Last synced ${formatDistanceToNow(new Date(lastSyncTime), { addSuffix: true })}`
    : null;

  return (
    <SecurityDashboardView
      basePath={basePath}
      data={dashboardData ?? emptyDashboardStats}
      isLoading={isDashboardLoading}
      isError={dashboardHasError}
      slaEnabled={slaEnabled}
      repositories={filteredRepositories}
      repoFullName={repoFullName}
      lastUpdated={lastUpdated}
      isSyncing={isSyncing}
      onRepositoryChange={setRepoFullName}
      onSync={() => handleSync(repoFullName)}
      onRetry={() => void refetchDashboard()}
    />
  );
}

export function SecurityDashboardView({
  basePath,
  data,
  isLoading,
  isError,
  slaEnabled,
  repositories,
  repoFullName,
  lastUpdated,
  isSyncing,
  onRepositoryChange,
  onSync,
  onRetry,
}: SecurityDashboardViewProps) {
  const metrics = buildDashboardMetrics(data, slaEnabled);

  return (
    <div className="space-y-6">
      <DashboardToolbar
        repositories={repositories}
        repoFullName={repoFullName}
        isLoading={isLoading}
        lastUpdated={lastUpdated}
        isSyncing={isSyncing}
        onRepositoryChange={onRepositoryChange}
        onSync={onSync}
      />

      {isError ? (
        <DashboardError onRetry={onRetry} />
      ) : isLoading ? (
        <DashboardSkeleton />
      ) : (
        <>
          <section
            className="border-border bg-border grid gap-px overflow-hidden rounded-xl border sm:grid-cols-2 xl:grid-cols-4"
            aria-label="Security overview"
          >
            {metrics.map(metric => (
              <DashboardMetricCard key={metric.id} {...metric} />
            ))}
          </section>

          <AttentionCard
            data={data}
            basePath={basePath}
            repoFullName={repoFullName}
            slaEnabled={slaEnabled}
          />

          <div className="grid gap-6 lg:grid-cols-2">
            {slaEnabled ? (
              <DeadlinePostureCard data={data} basePath={basePath} />
            ) : (
              <ActionPostureCard data={data} basePath={basePath} repoFullName={repoFullName} />
            )}
            <UnderstandingSummary
              data={data}
              basePath={basePath}
              repoFullName={repoFullName}
              slaEnabled={slaEnabled}
            />
          </div>

          <RepositoryActionPlan
            repositories={data.repoHealth}
            basePath={basePath}
            slaEnabled={slaEnabled}
          />
        </>
      )}
    </div>
  );
}

function DashboardToolbar({
  repositories,
  repoFullName,
  isLoading,
  lastUpdated,
  isSyncing,
  onRepositoryChange,
  onSync,
}: {
  repositories: Repository[];
  repoFullName: string | undefined;
  isLoading: boolean;
  lastUpdated: string | null;
  isSyncing: boolean;
  onRepositoryChange: (repoFullName: string | undefined) => void;
  onSync: () => void;
}) {
  return (
    <SecurityAgentActionBar label="Dashboard controls">
      <div className="grid gap-3 md:grid-cols-[minmax(0,20rem)_1fr] md:items-end">
        <SecurityAgentActionBarField id="dashboard-repository" label="Repository scope">
          <RepositoryFilter
            id="dashboard-repository"
            className="min-h-11 sm:min-h-9 sm:w-full"
            repositories={repositories}
            value={repoFullName}
            onValueChange={onRepositoryChange}
            isLoading={isLoading}
          />
        </SecurityAgentActionBarField>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between md:justify-end">
          {lastUpdated && (
            <span className="text-muted-foreground flex min-h-8 items-center gap-1.5 text-xs whitespace-nowrap">
              <Clock className="size-3.5" aria-hidden="true" />
              {lastUpdated}
            </span>
          )}
          <Button
            variant="outline"
            type="button"
            className="min-h-11 w-full sm:min-h-9 sm:w-auto"
            onClick={onSync}
            disabled={isSyncing}
          >
            <RefreshCw
              className={isSyncing ? 'animate-spin motion-reduce:animate-none' : ''}
              aria-hidden="true"
            />
            {isSyncing ? 'Syncing findings...' : 'Sync findings'}
          </Button>
        </div>
      </div>
    </SecurityAgentActionBar>
  );
}

function DashboardError({ onRetry }: { onRetry: () => void }) {
  return (
    <Alert variant="destructive">
      <AlertCircle aria-hidden="true" />
      <AlertTitle>Dashboard data could not load</AlertTitle>
      <AlertDescription>
        <p>
          Security Agent could not load current finding statistics. Check your connection and try
          again.
        </p>
        <Button variant="outline" size="sm" type="button" onClick={onRetry} className="mt-2">
          <RefreshCw aria-hidden="true" />
          Retry dashboard
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function DashboardSkeleton() {
  return (
    <output
      className="block space-y-6"
      aria-label="Loading dashboard data"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="grid gap-px overflow-hidden rounded-xl sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map(index => (
          <div key={index} className="bg-card space-y-3 p-5">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-8 w-16" />
            <Skeleton className="h-3 w-36" />
          </div>
        ))}
      </div>
      <Skeleton className="h-64 w-full rounded-xl" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-96 w-full rounded-xl" />
        <Skeleton className="h-96 w-full rounded-xl" />
      </div>
      <Skeleton className="h-72 w-full rounded-xl" />
    </output>
  );
}

// Web-only presentation layered onto the shared label/value/detail/tone data.
const metricIcons: Record<DashboardMetricKey, LucideIcon> = {
  openFindings: ShieldAlert,
  exploitable: TriangleAlert,
  needsReview: CircleHelp,
  analysisIncomplete: FileSearch,
  slaCompliance: ShieldCheck,
  deadlinePassed: AlertCircle,
  dueSoon: CalendarClock,
  noDeadline: CircleHelp,
};

function buildDashboardMetrics(data: DashboardStats, slaEnabled: boolean): DashboardMetric[] {
  return buildSecurityDashboardMetrics(data, slaEnabled).map(metric => ({
    ...metric,
    icon: metricIcons[metric.id],
  }));
}

function DashboardMetricCard({ label, value, detail, icon: Icon, tone }: DashboardMetric) {
  const toneClass = {
    danger: 'text-status-destructive',
    warning: 'text-status-warning',
    neutral: 'text-muted-foreground',
  }[tone];

  return (
    <div className="bg-card p-5">
      <div className="text-muted-foreground flex items-center gap-2 text-xs">
        <Icon className={cn('size-3.5', toneClass)} aria-hidden="true" />
        {label}
      </div>
      <div className={cn('mt-3 font-mono text-2xl font-semibold tabular-nums', toneClass)}>
        {value}
      </div>
      <p className="text-muted-foreground mt-1 text-xs">{detail}</p>
    </div>
  );
}

function AttentionCard({
  data,
  basePath,
  repoFullName,
  slaEnabled,
}: {
  data: DashboardStats;
  basePath: string;
  repoFullName: string | undefined;
  slaEnabled: boolean;
}) {
  const finding = data.priorityFinding;
  const needsAction = getNeedsActionCount(data.analysis);
  const closed = data.status.fixed + data.status.ignored;
  const openFindingsHref = findingsHref(basePath, { status: 'open', repoFullName });

  if (!finding) {
    return (
      <section
        className="border-status-success-border bg-status-success-surface rounded-xl border p-6"
        aria-labelledby="attention-heading"
      >
        <div className="flex items-start gap-3">
          <CheckCircle2 className="text-status-success-icon mt-0.5 size-5" aria-hidden="true" />
          <div>
            <h2 id="attention-heading" className="font-semibold">
              No open findings need attention
            </h2>
            <p className="text-muted-foreground mt-1 text-sm leading-6">
              Security Agent will rank new work here after the next sync.
            </p>
            <Button asChild variant="outline" size="sm" className="mt-4">
              <Link href={openFindingsHref}>View all findings</Link>
            </Button>
          </div>
        </div>
      </section>
    );
  }

  const severity = titleCaseSeverity(finding.severity);
  const isOverdue = slaEnabled && finding.daysOverdue !== null;
  let heading = `${severity} finding needs attention`;
  let description = 'Review the current evidence and choose the next action.';

  if (isOverdue) {
    heading = `${severity} finding is overdue`;
    description =
      finding.analysisStatus === null || finding.analysisStatus === 'failed'
        ? 'Its deadline passed before Security Agent confirmed project risk. Review it now and start analysis if needed.'
        : 'Its resolution deadline has passed. Review current analysis and remediation options.';
  } else if (finding.analysisStatus === null || finding.analysisStatus === 'failed') {
    heading = `${severity} finding needs analysis`;
    description =
      'Advisory severity is known, but project risk is not. Review code usage before choosing remediation or dismissal.';
  } else if (finding.analysisStatus === 'pending' || finding.analysisStatus === 'running') {
    heading = `${severity} finding analysis is in progress`;
    description = 'Open the finding to review current analysis status and source details.';
  } else if (finding.isExploitable === true) {
    heading = `${severity} exploitable finding needs review`;
    description =
      'Codebase analysis confirmed project risk. Review evidence and available remediation actions.';
  } else if (finding.suggestedAction === 'manual_review') {
    heading = `${severity} finding needs your review`;
    description =
      'Security Agent found evidence that requires a human decision before the finding can proceed.';
  }

  return (
    <section
      className="border-border bg-card overflow-hidden rounded-xl border"
      aria-labelledby="attention-heading"
    >
      <div className="grid lg:grid-cols-[minmax(0,1.35fr)_minmax(20rem,0.65fr)]">
        <div className="p-5 sm:p-6">
          <div className="text-status-destructive flex items-center gap-2 text-sm font-medium">
            <ShieldAlert className="size-4" aria-hidden="true" />
            Act first
          </div>
          <h2 id="attention-heading" className="mt-3 text-xl font-semibold sm:text-2xl">
            {heading}
          </h2>
          <p className="text-muted-foreground mt-2 text-sm leading-6">{description}</p>
          <div className="bg-surface-overlay mt-5 rounded-lg p-4">
            <p className="truncate text-sm font-medium">{finding.title}</p>
            <p className="text-muted-foreground mt-2 truncate font-mono text-xs">
              {finding.repoFullName}
              {isOverdue &&
                ` · ${finding.daysOverdue === 0 ? 'Deadline reached today' : `${finding.daysOverdue} days overdue`}`}
            </p>
          </div>
          <div className="mt-5 flex flex-wrap gap-2">
            <Button asChild>
              <Link href={findingsHref(basePath, { findingId: finding.id })}>
                Review finding
                <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
            <Button asChild variant="ghost">
              <Link href={openFindingsHref}>View all open findings</Link>
            </Button>
          </div>
        </div>
        <div className="border-border grid border-t sm:grid-cols-3 lg:grid-cols-1 lg:border-t-0 lg:border-l">
          <GuidanceFact
            icon={TriangleAlert}
            label="Needs action"
            value={`${needsAction} findings`}
            detail="Analysis, remediation, or review required"
            tone="danger"
          />
          <GuidanceFact
            icon={ShieldCheck}
            label="Confirmed risk"
            value={`${data.analysis.exploitable} exploitable`}
            detail="Code can reach affected behavior"
            tone="warning"
          />
          <GuidanceFact
            icon={Sparkles}
            label="Closed findings"
            value={`${closed} total`}
            detail="Fixed or dismissed"
            tone="success"
          />
        </div>
      </div>
    </section>
  );
}

function GuidanceFact({
  icon: Icon,
  label,
  value,
  detail,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  detail: string;
  tone: 'danger' | 'warning' | 'success';
}) {
  const iconClass = {
    danger: 'text-status-destructive-icon',
    warning: 'text-status-warning-icon',
    success: 'text-status-success-icon',
  }[tone];

  return (
    <div className="border-border p-4 not-last:border-b sm:not-last:border-r sm:not-last:border-b-0 lg:not-last:border-r-0 lg:not-last:border-b">
      <div className="text-muted-foreground flex items-center gap-2 text-xs">
        <Icon className={cn('size-3.5', iconClass)} aria-hidden="true" />
        {label}
      </div>
      <div className="mt-2 font-mono text-lg font-semibold tabular-nums">{value}</div>
      <p className="text-muted-foreground mt-1 text-xs leading-5">{detail}</p>
    </div>
  );
}

function DeadlinePostureCard({ data, basePath }: { data: DashboardStats; basePath: string }) {
  const total = data.sla.overall.total;
  const within = data.sla.overall.withinSla;
  const compliance = total > 0 ? Math.round((within / total) * 100) : 100;
  const postureTone = compliance < 70 ? 'danger' : compliance < 90 ? 'warning' : 'success';

  return (
    <DashboardSection
      title="SLA posture"
      description="Tracks open Security Findings with assigned SLA deadlines to show where resolution work is on track or overdue."
    >
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="font-mono text-3xl font-semibold tabular-nums">
            {within} / {total}
          </div>
          <div className="text-muted-foreground mt-1 text-xs">within resolution deadline</div>
        </div>
        <span
          className={cn('font-mono text-sm font-medium tabular-nums', toneTextClass(postureTone))}
        >
          {compliance}% · {postureLabel(compliance)}
        </span>
      </div>
      <Progress
        value={compliance}
        aria-label="Security Findings within resolution deadline"
        className="bg-surface-inset mt-4"
        indicatorClassName={toneIndicatorClass(postureTone)}
      />
      <div className="mt-6 space-y-5">
        {(['critical', 'high', 'medium', 'low'] as const).map(severity => {
          const sla = data.sla.bySeverity[severity];
          const severityCompliance =
            sla.total > 0 ? Math.round((sla.withinSla / sla.total) * 100) : 100;
          const tone =
            sla.overdue === 0 ? 'success' : severityCompliance < 70 ? 'danger' : 'warning';
          return (
            <DeadlineBar
              key={severity}
              label={titleCaseSeverity(severity)}
              within={sla.withinSla}
              total={sla.total}
              overdue={sla.overdue}
              tone={tone}
            />
          );
        })}
      </div>
      <div className="border-border mt-6 border-t pt-4">
        <Button asChild variant="ghost" size="sm">
          <Link href={`${basePath}/config?tab=sla`}>
            <Settings2 aria-hidden="true" />
            Review SLA rules
          </Link>
        </Button>
      </div>
    </DashboardSection>
  );
}

function ActionPostureCard({
  data,
  basePath,
  repoFullName,
}: {
  data: DashboardStats;
  basePath: string;
  repoFullName: string | undefined;
}) {
  const analysisIncomplete = getAnalysisIncompleteCount(data.analysis);
  const decisionsPending = data.analysis.needsReview;
  const total = data.analysis.total;
  const decisionPercentage = total > 0 ? Math.round((decisionsPending / total) * 100) : 0;
  const noImmediateAction = Math.max(
    0,
    total - data.analysis.exploitable - decisionsPending - analysisIncomplete
  );

  return (
    <DashboardSection
      title="Action posture"
      description="Open Security Findings grouped by their clearest next step."
      action={
        <Button asChild variant="ghost" size="sm" className="shrink-0">
          <Link href={`${basePath}/config?tab=sla`}>
            <Settings2 aria-hidden="true" />
            Configure SLA
          </Link>
        </Button>
      }
    >
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="font-mono text-3xl font-semibold tabular-nums">
            {decisionsPending} / {total}
          </div>
          <div className="text-muted-foreground mt-1 text-xs">need a team decision</div>
        </div>
        <span className="text-status-warning text-sm font-medium">
          {decisionsPending} decisions pending
        </span>
      </div>
      <Progress
        value={decisionPercentage}
        aria-label="Open Security Findings needing a team decision"
        className="bg-surface-inset mt-4"
        indicatorClassName="bg-status-warning-icon"
      />
      <dl className="mt-6 space-y-4 text-sm">
        <PostureLine
          label="Confirmed exploitable"
          value={data.analysis.exploitable}
          detail="Project risk confirmed"
        />
        <PostureLine
          label="Needs evidence review"
          value={decisionsPending}
          detail="Human decision required"
        />
        <PostureLine
          label="Analysis not complete"
          value={analysisIncomplete}
          detail="Project risk still unknown"
        />
        <PostureLine
          label="No immediate action"
          value={noImmediateAction}
          detail="Monitored or not exploitable"
        />
      </dl>
      <Button asChild variant="ghost" size="sm" className="mt-5 px-0">
        <Link href={findingsHref(basePath, { status: 'open', repoFullName })}>
          Review open findings
          <ArrowRight aria-hidden="true" />
        </Link>
      </Button>
    </DashboardSection>
  );
}

function DashboardSection({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const headingId = `dashboard-${title.toLowerCase().replaceAll(' ', '-')}`;
  return (
    <section className="border-border bg-card rounded-xl border" aria-labelledby={headingId}>
      <div className="border-border flex items-start justify-between gap-4 border-b p-5 sm:p-6">
        <div>
          <h2 id={headingId} className="font-semibold">
            {title}
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">{description}</p>
        </div>
        {action}
      </div>
      <div className="p-5 sm:p-6">{children}</div>
    </section>
  );
}

function PostureLine({ label, value, detail }: { label: string; value: number; detail: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt>
        <div>{label}</div>
        <div className="text-muted-foreground mt-0.5 text-xs">{detail}</div>
      </dt>
      <dd className="text-muted-foreground font-mono tabular-nums">{value}</dd>
    </div>
  );
}

function DeadlineBar({
  label,
  within,
  total,
  overdue,
  tone,
}: {
  label: string;
  within: number;
  total: number;
  overdue: number;
  tone: 'danger' | 'warning' | 'success';
}) {
  const percentage = total > 0 ? Math.round((within / total) * 100) : 100;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3 text-xs">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground font-mono text-right tabular-nums">
          {overdue} overdue · {within} of {total} within
        </span>
      </div>
      <Progress
        value={percentage}
        aria-label={`${label} Security Findings within resolution deadline`}
        className="bg-surface-inset"
        indicatorClassName={toneIndicatorClass(tone)}
      />
    </div>
  );
}

function UnderstandingSummary({
  data,
  basePath,
  repoFullName,
  slaEnabled,
}: {
  data: DashboardStats;
  basePath: string;
  repoFullName: string | undefined;
  slaEnabled: boolean;
}) {
  const progress =
    data.analysis.total > 0
      ? Math.round((data.analysis.analyzed / data.analysis.total) * 100)
      : 100;
  const analysisIncomplete = getAnalysisIncompleteCount(data.analysis);

  return (
    <DashboardSection
      title="Codebase risk"
      description="Analysis shows which Security Findings can affect your codebase beyond published severity."
    >
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="font-mono text-3xl font-semibold tabular-nums">{progress}%</div>
          <div className="text-muted-foreground mt-1 text-xs">
            {data.analysis.analyzed} of {data.analysis.total} open findings analyzed
          </div>
        </div>
        <CheckCircle2 className="text-status-success-icon size-6" aria-label="Analysis coverage" />
      </div>
      <Progress
        value={progress}
        aria-label="Open findings analyzed"
        className="bg-surface-inset mt-4"
        indicatorClassName="bg-status-success-icon"
      />
      <dl className="mt-6 space-y-1 text-sm">
        <SummaryLine
          label="Confirmed exploitable"
          value={data.analysis.exploitable}
          tone="danger"
          href={findingsHref(basePath, { outcomeFilter: 'exploitable', repoFullName })}
        />
        <SummaryLine
          label="Not exploitable"
          value={data.analysis.notExploitable}
          tone="success"
          href={findingsHref(basePath, { outcomeFilter: 'not_exploitable', repoFullName })}
        />
        <SummaryLine
          label="Needs your review"
          value={data.analysis.needsReview}
          tone="warning"
          href={findingsHref(basePath, { outcomeFilter: 'needs_review', repoFullName })}
        />
        <SummaryLine
          label="Analysis not complete"
          value={analysisIncomplete}
          tone="neutral"
          href={findingsHref(basePath, { status: 'open', repoFullName })}
        />
        {slaEnabled && (
          <SummaryLine
            label="No SLA deadline assigned"
            value={data.sla.untrackedCount}
            tone="neutral"
            href={findingsHref(basePath, { status: 'open', repoFullName })}
          />
        )}
      </dl>
      <p className="text-muted-foreground border-border mt-5 border-t pt-4 text-xs leading-5">
        Severity comes from the advisory. Exploitability reflects how this repository uses the
        affected package.
      </p>
    </DashboardSection>
  );
}

function SummaryLine({
  label,
  value,
  tone,
  href,
}: {
  label: string;
  value: number;
  tone: SummaryTone;
  href: string;
}) {
  const dotClass = {
    danger: 'bg-status-destructive-icon',
    warning: 'bg-status-warning-icon',
    success: 'bg-status-success-icon',
    neutral: 'bg-status-neutral-icon',
  }[tone];

  return (
    <div className="flex items-center justify-between gap-4">
      <dt>
        <Link
          href={href}
          className="focus-visible:ring-ring hover:bg-accent flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          <span className={cn('size-2 rounded-full', dotClass)} aria-hidden="true" />
          {label}
        </Link>
      </dt>
      <dd className="text-muted-foreground font-mono tabular-nums">{value}</dd>
    </div>
  );
}

function RepositoryActionPlan({
  repositories,
  basePath,
  slaEnabled,
}: {
  repositories: DashboardStats['repoHealth'];
  basePath: string;
  slaEnabled: boolean;
}) {
  return (
    <section
      className="border-border overflow-hidden rounded-xl border"
      aria-labelledby="repository-plan-heading"
    >
      <div className="bg-card border-border border-b p-5 sm:p-6">
        <h2 id="repository-plan-heading" className="font-semibold">
          Repository action plan
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          {slaEnabled
            ? 'Ranked by critical severity, missed deadlines, then findings requiring action.'
            : 'Ranked by critical severity, confirmed project risk, then findings requiring action.'}
        </p>
      </div>
      {repositories.length > 0 ? (
        <div className="divide-border divide-y">
          {repositories.map((repository, index) => (
            <RepositoryActionRow
              key={repository.repoFullName}
              repository={repository}
              rank={index + 1}
              basePath={basePath}
              slaEnabled={slaEnabled}
            />
          ))}
        </div>
      ) : (
        <div className="bg-card p-6 text-center">
          <ShieldCheck className="text-status-success-icon mx-auto size-6" aria-hidden="true" />
          <h3 className="mt-3 font-medium">No repositories have open findings</h3>
          <p className="text-muted-foreground mt-1 text-sm">
            Repository priorities will appear after findings are synced.
          </p>
        </div>
      )}
    </section>
  );
}

function RepositoryActionRow({
  repository,
  rank,
  basePath,
  slaEnabled,
}: {
  repository: DashboardStats['repoHealth'][number];
  rank: number;
  basePath: string;
  slaEnabled: boolean;
}) {
  const needsActionPercentage =
    repository.open > 0 ? Math.round((repository.needsAction / repository.open) * 100) : 0;
  const complianceTone = repository.slaCompliancePercent < 70 ? 'danger' : 'success';
  const actionTone = repository.needsAction > 0 ? 'warning' : 'success';

  return (
    <article className="bg-card grid grid-cols-[2rem_minmax(0,1fr)] gap-4 p-4 sm:p-5 lg:grid-cols-[2rem_minmax(14rem,1fr)_minmax(16rem,0.8fr)_auto] lg:items-center">
      <div className="bg-muted text-muted-foreground flex size-8 items-center justify-center rounded-md font-mono text-xs">
        {String(rank).padStart(2, '0')}
      </div>
      <div className="min-w-0">
        <h3 className="truncate font-mono text-sm font-medium">{repository.repoFullName}</h3>
        <p className="text-muted-foreground mt-1 text-xs">
          {repository.open} open · {repository.critical} critical · {repository.high} high
        </p>
      </div>
      <div className="col-span-2 lg:col-span-1">
        <div className="mb-2 flex items-center justify-between gap-3 text-xs">
          <span className="text-muted-foreground">
            {slaEnabled ? 'SLA compliance' : 'Needs action'}
          </span>
          <span
            className={cn(
              'font-mono tabular-nums',
              toneTextClass(slaEnabled ? complianceTone : actionTone)
            )}
          >
            {slaEnabled
              ? `${repository.slaCompliancePercent}%`
              : `${repository.needsAction} findings`}
          </span>
        </div>
        <Progress
          value={slaEnabled ? repository.slaCompliancePercent : needsActionPercentage}
          aria-label={
            slaEnabled
              ? `${repository.repoFullName} SLA compliance`
              : `${repository.repoFullName} findings needing action`
          }
          className="bg-surface-inset"
          indicatorClassName={toneIndicatorClass(slaEnabled ? complianceTone : actionTone)}
        />
        <p className="text-muted-foreground mt-2 text-xs">
          {slaEnabled
            ? repository.overdue > 0
              ? `${repository.overdue} overdue · ${repository.needsAction} need action`
              : 'No overdue findings'
            : repository.needsAction > 0
              ? `${repository.exploitable} exploitable · ${repository.needsAction} need action`
              : 'No findings need action'}
        </p>
      </div>
      <Button
        asChild
        variant="outline"
        size="sm"
        className="col-span-2 w-full sm:w-auto lg:col-span-1"
      >
        <Link
          href={findingsHref(basePath, { status: 'open', repoFullName: repository.repoFullName })}
        >
          Review
          <ArrowRight aria-hidden="true" />
        </Link>
      </Button>
    </article>
  );
}

function postureLabel(compliance: number): string {
  if (compliance < 70) return 'At risk';
  if (compliance < 90) return 'Needs attention';
  return 'On track';
}

function toneTextClass(tone: 'danger' | 'warning' | 'success'): string {
  return {
    danger: 'text-status-destructive',
    warning: 'text-status-warning',
    success: 'text-status-success',
  }[tone];
}

function toneIndicatorClass(tone: 'danger' | 'warning' | 'success'): string {
  return {
    danger: 'bg-status-destructive-icon',
    warning: 'bg-status-warning-icon',
    success: 'bg-status-success-icon',
  }[tone];
}
