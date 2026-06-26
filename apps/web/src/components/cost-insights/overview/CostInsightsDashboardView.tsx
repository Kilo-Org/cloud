'use client';

import { Activity, AlertTriangle, CheckCircle2, DollarSign } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { CostInsightsLoadError } from '../shared/CostInsightsLoadError';
import { StatusBadge } from '../shared/StatusBadge';
import type { CostInsightsDashboardData, SpendMetric } from '../types';
import { AskKiloInput } from './AskKiloInput';
import { DisabledAlertsBanner, ReviewBanner, SuggestionCard } from './DashboardNotices';
import { EventPreviewCard } from './EventPreviewCard';
import { SpendEvidenceCard } from './SpendEvidenceCard';
import { TopDriversCard } from './TopDriversCard';
import { cn } from '@/lib/utils';

const toneClasses = {
  neutral: 'text-foreground',
  success: 'text-status-success',
  warning: 'text-status-warning',
  danger: 'text-status-destructive',
} satisfies Record<SpendMetric['tone'], string>;

const metricIcons = {
  activity: Activity,
  alert: AlertTriangle,
  check: CheckCircle2,
  dollar: DollarSign,
} satisfies Record<string, typeof Activity>;

export function CostInsightsDashboardView({
  data,
  isLoading = false,
  isError = false,
  activityHref,
  alertActionsDisabled = false,
  onRetry,
  onSetupAlerts,
  onAlertAction,
  onSuggestionDismiss,
  onAskKilo,
}: {
  data?: CostInsightsDashboardData;
  isLoading?: boolean;
  isError?: boolean;
  activityHref?: string;
  alertActionsDisabled?: boolean;
  onRetry?: () => void;
  onSetupAlerts?: () => void;
  onAlertAction?: (
    alert: CostInsightsDashboardData['alerts'][number],
    action: CostInsightsDashboardData['alerts'][number]['actions'][number]
  ) => void;
  onSuggestionDismiss?: (suggestionId: string) => void;
  onAskKilo?: (question: string) => void;
}) {
  if (isLoading) return <DashboardSkeleton />;
  if (isError) return <CostInsightsLoadError onRetry={onRetry} />;
  if (!data) return <CostInsightsLoadError onRetry={onRetry} />;

  const canManage =
    data.owner.type === 'personal' ||
    data.owner.authorizedRole === 'owner' ||
    data.owner.authorizedRole === 'billing_manager';

  return (
    <div className="space-y-6">
      <AskKiloInput owner={data.owner} onSubmit={onAskKilo} />
      {data.alerts.map((alert, index) => (
        <ReviewBanner
          key={alert.type}
          alert={alert}
          primaryAction={index === 0}
          actionsDisabled={alertActionsDisabled}
          canManage={canManage}
          onAction={action => onAlertAction?.(alert, action)}
        />
      ))}
      {data.suggestions.map(suggestion => (
        <SuggestionCard
          key={suggestion.id}
          suggestion={suggestion}
          canManage={canManage}
          onDismiss={() => onSuggestionDismiss?.(suggestion.id)}
        />
      ))}
      {!data.enabled && (
        <DisabledAlertsBanner canManage={canManage} onSetupAlerts={onSetupAlerts} />
      )}

      <section aria-labelledby="spend-summary-title">
        <div className="mb-3 flex items-end justify-between gap-4">
          <div>
            <h2 id="spend-summary-title" className="type-heading">
              Last 24 hours
            </h2>
            <p className="type-body text-muted-foreground mt-1">
              Spend charged to {data.owner.name}.
            </p>
          </div>
          {data.enabled && data.alerts.length === 0 && (
            <StatusBadge tone="success">
              <CheckCircle2 className="size-icon-sm" aria-hidden="true" /> No alerts
            </StatusBadge>
          )}
        </div>
        <div className="border-border bg-border grid gap-px overflow-hidden rounded-xl border sm:grid-cols-2 xl:grid-cols-4">
          {data.metrics.map(metric => (
            <MetricTile key={metric.label} metric={metric} />
          ))}
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(20rem,0.65fr)]">
        <SpendEvidenceCard key={data.range} data={data} />
        <TopDriversCard
          drivers={data.drivers}
          owner={data.owner}
          memberLimitsHref={data.memberLimitsHref}
        />
      </div>

      <EventPreviewCard events={data.eventPreview} activityHref={activityHref} />
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <output className="block space-y-6" aria-label="Loading Cost Insights" aria-busy="true">
      <Skeleton className="h-32 rounded-xl" />
      <div className="grid gap-px overflow-hidden rounded-xl sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map(index => (
          <Skeleton key={index} className="h-32 rounded-none" />
        ))}
      </div>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(20rem,0.65fr)]">
        <Skeleton className="h-96 rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    </output>
  );
}

function MetricTile({ metric }: { metric: SpendMetric }) {
  const Icon = typeof metric.icon === 'string' ? metricIcons[metric.icon] : metric.icon;
  return (
    <div className="bg-card p-6">
      <div className="type-label text-muted-foreground flex items-center gap-2">
        <Icon className="size-icon-sm" aria-hidden="true" /> {metric.label}
      </div>
      <div className={cn('type-title mt-3 font-mono tabular-nums', toneClasses[metric.tone])}>
        {metric.value}
      </div>
      <p className="type-label text-muted-foreground mt-1">{metric.detail}</p>
    </div>
  );
}
