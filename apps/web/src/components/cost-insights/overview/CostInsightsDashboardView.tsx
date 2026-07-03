'use client';

import { useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, DollarSign } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { COST_INSIGHTS_ASK_KILO_UI_ENABLED } from '../feature-visibility';
import { spendRangePeriodLabel } from '../formatting';
import { CostInsightsLoadError } from '../shared/CostInsightsLoadError';
import { StatusBadge } from '../shared/StatusBadge';
import type { CostInsightsDashboardData, SpendMetric, SpendRange } from '../types';
import { AskKiloInput } from './AskKiloInput';
import { DisabledAlertsBanner, ReviewBanner, SuggestionCard } from './DashboardNotices';
import { EventPreviewCard } from './EventPreviewCard';
import { SpendEvidenceCard } from './SpendEvidenceCard';
import { TopDriversCard } from './TopDriversCard';

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

const rangeOptions = [
  { value: '1h', label: 'This hour' },
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: '90d', label: '90d' },
] satisfies Array<{ value: SpendRange; label: string }>;

export function CostInsightsDashboardView({
  data,
  isLoading = false,
  isError = false,
  activityHref,
  alertActionsDisabled = false,
  pendingSuggestionId,
  onRetry,
  onSetupAlerts,
  onAlertAction,
  onAlertDriversExpanded,
  onSpendRangeChange,
  onSuggestionCta,
  onSuggestionDismiss,
}: {
  data?: CostInsightsDashboardData;
  isLoading?: boolean;
  isError?: boolean;
  activityHref?: string;
  alertActionsDisabled?: boolean;
  pendingSuggestionId?: string;
  onRetry?: () => void;
  onSetupAlerts?: () => void;
  onAlertAction?: (
    alert: CostInsightsDashboardData['alerts'][number],
    action: CostInsightsDashboardData['alerts'][number]['actions'][number]
  ) => void;
  onAlertDriversExpanded?: (alertKind: CostInsightsDashboardData['alerts'][number]['type']) => void;
  onSpendRangeChange?: (range: SpendRange) => void;
  onSuggestionCta?: (
    suggestion: CostInsightsDashboardData['suggestions'][number]
  ) => void | Promise<void>;
  onSuggestionDismiss?: (suggestionId: string) => void;
}) {
  const [selectedRange, setSelectedRange] = useState<SpendRange>();

  if (isLoading) return <DashboardSkeleton />;
  if (isError) return <CostInsightsLoadError onRetry={onRetry} />;
  if (!data) return <CostInsightsLoadError onRetry={onRetry} />;

  const activeRange = selectedRange ?? data.range;
  const showThisHour = () => {
    if (activeRange !== '1h') onSpendRangeChange?.('1h');
    setSelectedRange('1h');
    window.requestAnimationFrame(() => {
      document
        .getElementById('spend-evidence')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };
  const canManage =
    data.owner.type === 'personal' ||
    data.owner.authorizedRole === 'owner' ||
    data.owner.authorizedRole === 'billing_manager';

  return (
    <div className="space-y-6">
      {COST_INSIGHTS_ASK_KILO_UI_ENABLED && <AskKiloInput owner={data.owner} />}
      {data.alerts.map(alert => (
        <ReviewBanner
          key={alert.type}
          alert={alert}
          actionsDisabled={alertActionsDisabled}
          canManage={canManage}
          onAction={action => onAlertAction?.(alert, action)}
          onDriversExpanded={() => onAlertDriversExpanded?.(alert.type)}
          onExploreThisHour={showThisHour}
        />
      ))}
      {data.suggestions.map(suggestion => (
        <SuggestionCard
          key={suggestion.id}
          suggestion={suggestion}
          canManage={canManage}
          dismissPending={pendingSuggestionId === suggestion.id}
          onCta={() => onSuggestionCta?.(suggestion)}
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

      <section id="spend-evidence" aria-labelledby="spend-evidence-title" className="scroll-mt-6">
        <Card className="min-w-0">
          <CardHeader className="gap-4 pb-4">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <h2 id="spend-evidence-title" className="type-heading">
                  Spend over time
                </h2>
                <p className="type-body text-muted-foreground mt-1">
                  Usage timeline and largest contributors for {spendRangePeriodLabel(activeRange)}.
                </p>
              </div>
              <fieldset
                aria-label="Spend range"
                className="border-input bg-input-background flex w-full gap-1 overflow-x-auto rounded-md border p-1 lg:w-auto"
              >
                {rangeOptions.map(option => (
                  <Button
                    key={option.value}
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-pressed={activeRange === option.value}
                    className={cn(
                      'min-h-control-touch shrink-0 px-3 type-label lg:min-h-9',
                      activeRange === option.value &&
                        'bg-surface-selected text-foreground hover:bg-surface-selected'
                    )}
                    onClick={() => {
                      if (activeRange === option.value) return;
                      setSelectedRange(option.value);
                      onSpendRangeChange?.(option.value);
                    }}
                  >
                    {option.label}
                  </Button>
                ))}
              </fieldset>
            </div>
          </CardHeader>
          <CardContent className="space-y-8">
            <SpendEvidenceCard data={data} range={activeRange} />
            <div className="border-border border-t pt-6">
              <TopDriversCard
                drivers={data.driversByRange[activeRange]}
                period={activeRange}
                owner={data.owner}
                memberLimitsHref={data.memberLimitsHref}
              />
            </div>
          </CardContent>
        </Card>
      </section>

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
      <Skeleton className="h-[42rem] rounded-xl" />
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
