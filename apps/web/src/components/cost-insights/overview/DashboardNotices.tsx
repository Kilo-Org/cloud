'use client';

import { useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Bell,
  ChevronDown,
  ChevronUp,
  Lightbulb,
  Loader2,
  TrendingUp,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  formatCostInsightElapsedWindow,
  formatCostInsightHourWindow,
  money,
  percentOf,
  sourceLabels,
} from '../formatting';
import { useViewerTimeZone } from '../shared/LocalDateTime';
import type {
  AlertDriverEvidence,
  CostSuggestion,
  DashboardAlert,
  DashboardAlertAction,
} from '../types';

const reviewActionLabels = {
  acknowledge: 'Mark as reviewed',
  view_spend: 'Show alert drivers',
  disable_alerts: 'Turn off alerts',
  manage_threshold: 'Manage threshold',
} satisfies Record<DashboardAlertAction, string>;

export function DisabledAlertsBanner({
  canManage = true,
  onSetupAlerts,
}: {
  canManage?: boolean;
  onSetupAlerts?: () => void;
}) {
  return (
    <section
      className="border-border bg-card rounded-xl border p-6"
      aria-labelledby="alerts-off-title"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 id="alerts-off-title" className="type-heading">
            {canManage ? 'Get notified about unexpected spend' : 'Spend Alerts are off'}
          </h2>
          <p className="type-body text-muted-foreground mt-1 max-w-2xl">
            {canManage
              ? 'Spend data stays visible. Turn on Spend Alerts for unusual hourly increases and configurable rolling spend thresholds.'
              : 'Spend evidence remains available in this read-only view.'}
          </p>
        </div>
        {canManage && (
          <Button
            type="button"
            className="min-h-control-touch w-full sm:min-h-0 sm:w-auto"
            onClick={onSetupAlerts}
          >
            <Bell className="size-4" aria-hidden="true" /> Set up alerts
          </Button>
        )}
      </div>
    </section>
  );
}

export function ReviewBanner({
  alert,
  primaryAction = false,
  actionsDisabled = false,
  canManage = true,
  onAction,
  onDriversExpanded,
  onExploreThisHour,
}: {
  alert: DashboardAlert;
  primaryAction?: boolean;
  actionsDisabled?: boolean;
  canManage?: boolean;
  onAction?: (action: DashboardAlertAction) => void;
  onDriversExpanded?: () => void;
  onExploreThisHour?: () => void;
}) {
  const [driversExpanded, setDriversExpanded] = useState(false);
  const Icon = alert.type === 'anomaly' ? TrendingUp : AlertTriangle;
  return (
    <section
      className="border-status-warning-border bg-status-warning-surface rounded-xl border p-6"
      aria-labelledby={`alert-${alert.type}`}
    >
      <div
        className={cn(
          'grid gap-5',
          (canManage || alert.driverEvidence) && 'lg:grid-cols-[minmax(0,1fr)_auto]'
        )}
      >
        <div>
          <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-1">
            <Icon className="text-status-warning-icon mt-0.5 size-5 shrink-0" aria-hidden="true" />
            <h2 id={`alert-${alert.type}`} className="type-heading">
              {alert.title}
            </h2>
            <p className="type-body text-muted-foreground col-span-2 max-w-2xl">
              {alert.description}
            </p>
          </div>
          {alert.facts && (
            <dl className="border-status-warning-border mt-4 grid gap-px overflow-hidden rounded-lg border sm:grid-cols-3">
              {alert.facts.map(fact => (
                <div key={fact.label} className="bg-background p-3">
                  <dt className="type-label text-muted-foreground">{fact.label}</dt>
                  <dd className="type-body mt-1 font-mono font-semibold tabular-nums">
                    {fact.value}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {alert.driverEvidence && driversExpanded && (
            <AlertDriverEvidencePanel
              id={`alert-${alert.type}-drivers`}
              evidence={alert.driverEvidence}
              onExploreThisHour={onExploreThisHour}
            />
          )}
        </div>
        {(canManage || alert.driverEvidence) && (
          <ReviewActions
            alert={alert}
            primaryAction={primaryAction}
            actionsDisabled={actionsDisabled}
            canManage={canManage}
            driversExpanded={driversExpanded}
            onToggleDrivers={() => {
              if (!driversExpanded) onDriversExpanded?.();
              setDriversExpanded(expanded => !expanded);
            }}
            onAction={onAction}
          />
        )}
      </div>
    </section>
  );
}

function ReviewActions({
  alert,
  primaryAction,
  actionsDisabled,
  canManage,
  driversExpanded,
  onToggleDrivers,
  onAction,
}: {
  alert: DashboardAlert;
  primaryAction: boolean;
  actionsDisabled: boolean;
  canManage: boolean;
  driversExpanded: boolean;
  onToggleDrivers: () => void;
  onAction?: (action: DashboardAlertAction) => void;
}) {
  const actions = alert.actions.filter(action => canManage || action === 'view_spend');
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap lg:w-52 lg:flex-col">
      {actions.map(action => {
        const isDriverToggle = action === 'view_spend';
        const label =
          isDriverToggle && driversExpanded ? 'Hide alert drivers' : reviewActionLabels[action];
        return (
          <Button
            key={action}
            type="button"
            variant={action === 'acknowledge' && primaryAction ? 'default' : 'outline'}
            className="min-h-control-touch w-full sm:min-h-0"
            disabled={actionsDisabled && !isDriverToggle}
            aria-busy={actionsDisabled && action === 'acknowledge'}
            aria-expanded={isDriverToggle ? driversExpanded : undefined}
            aria-controls={isDriverToggle ? `alert-${alert.type}-drivers` : undefined}
            onClick={() => (isDriverToggle ? onToggleDrivers() : onAction?.(action))}
          >
            {action.includes('disable') ? (
              <XCircle className="size-4" aria-hidden="true" />
            ) : isDriverToggle && driversExpanded ? (
              <ChevronUp className="size-4" aria-hidden="true" />
            ) : isDriverToggle ? (
              <ChevronDown className="size-4" aria-hidden="true" />
            ) : (
              <ArrowRight className="size-4" aria-hidden="true" />
            )}
            {label}
          </Button>
        );
      })}
    </div>
  );
}

function AlertDriverEvidencePanel({
  id,
  evidence,
  onExploreThisHour,
}: {
  id: string;
  evidence: AlertDriverEvidence;
  onExploreThisHour?: () => void;
}) {
  const viewerTimeZone = useViewerTimeZone();
  const windowLabel =
    evidence.periodStart && evidence.periodEndExclusive
      ? evidence.scope === 'rolling_24h' ||
        evidence.scope === 'rolling_7d' ||
        evidence.scope === 'rolling_30d'
        ? formatCostInsightElapsedWindow(
            evidence.periodStart,
            evidence.periodEndExclusive,
            viewerTimeZone
          )
        : formatCostInsightHourWindow(
            evidence.periodStart,
            evidence.periodEndExclusive,
            viewerTimeZone
          )
      : null;
  const description = windowLabel
    ? `${windowLabel} - ${evidence.description}`
    : evidence.description;

  return (
    <div id={id} className="border-border bg-surface-inset mt-5 overflow-hidden rounded-lg border">
      <div className="border-border flex flex-col gap-3 border-b px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="type-body font-semibold">{evidence.title}</h3>
          <p className="type-label text-muted-foreground mt-1">{description}</p>
        </div>
        {evidence.scope === 'current_hour' && onExploreThisHour && (
          <Button type="button" variant="outline" size="sm" onClick={onExploreThisHour}>
            Explore this hour
            <ArrowRight className="size-4" aria-hidden="true" />
          </Button>
        )}
      </div>
      <ol className="divide-border divide-y">
        {evidence.drivers.map((driver, index) => {
          const share = percentOf(driver.spendUsd, evidence.totalSpendUsd);
          const showShare = evidence.scope !== 'legacy';
          return (
            <li
              key={driver.id}
              className="grid gap-3 px-4 py-4 lg:grid-cols-[1.5rem_minmax(0,1fr)_10rem] lg:items-center"
            >
              <span className="type-label text-muted-foreground hidden font-mono lg:block">
                {index + 1}
              </span>
              <div className="min-w-0">
                <div className="type-body font-medium break-words">{driver.label}</div>
                <dl className="mt-3 grid gap-x-4 gap-y-3 sm:grid-cols-3">
                  {driver.actorLabel && (
                    <div className="min-w-0">
                      <dt className="type-eyebrow text-foreground-subtle">Member</dt>
                      <dd className="type-label text-muted-foreground mt-1 break-words">
                        {driver.actorLabel}
                      </dd>
                    </div>
                  )}
                  <div className="min-w-0">
                    <dt className="type-eyebrow text-foreground-subtle">Source</dt>
                    <dd className="type-label text-muted-foreground mt-1 break-words">
                      {sourceLabels[driver.source]}
                    </dd>
                  </div>
                  {driver.modelOrProvider && (
                    <div className="min-w-0">
                      <dt className="type-eyebrow text-foreground-subtle">
                        {driver.modelOrProviderLabel ?? 'Model'}
                      </dt>
                      <dd className="type-label text-muted-foreground mt-1 break-words">
                        {driver.modelOrProvider}
                      </dd>
                    </div>
                  )}
                  {evidence.scope !== 'current_hour' && (
                    <div className="min-w-0">
                      <dt className="type-eyebrow text-foreground-subtle">Category</dt>
                      <dd className="type-label text-muted-foreground mt-1 break-words">
                        {driver.category}
                      </dd>
                    </div>
                  )}
                </dl>
              </div>
              <div className="lg:text-right">
                <div className="type-body font-mono font-semibold tabular-nums">
                  {money(driver.spendUsd)}
                </div>
                <div className="type-label text-muted-foreground mt-0.5 tabular-nums lg:whitespace-nowrap">
                  {showShare && (
                    <span className="text-chart-1 font-mono font-semibold">{share}%</span>
                  )}
                  {showShare && <span> · </span>}
                  <span>
                    {driver.requestCount} {driver.requestCount === 1 ? 'record' : 'records'}
                  </span>
                </div>
                {showShare && (
                  <div
                    className="bg-surface-overlay mt-2 h-1 overflow-hidden rounded-full"
                    aria-hidden="true"
                  >
                    <div
                      className="bg-chart-1 h-full rounded-full"
                      style={{ width: `${share}%` }}
                    />
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function SuggestionCard({
  suggestion,
  canManage = true,
  dismissPending = false,
  onCta,
  onDismiss,
}: {
  suggestion: CostSuggestion;
  canManage?: boolean;
  dismissPending?: boolean;
  onCta?: () => void;
  onDismiss?: () => void;
}) {
  return (
    <section
      className="border-status-success-border bg-status-success-surface rounded-xl border p-6"
      aria-labelledby={`suggestion-${suggestion.id}`}
    >
      <div className={cn('grid gap-5', canManage && 'lg:grid-cols-[minmax(0,1fr)_auto]')}>
        <div>
          <div className="flex items-center gap-3">
            <Lightbulb className="text-status-success-icon size-5 shrink-0" aria-hidden="true" />
            <div className="type-eyebrow text-status-success">{suggestion.eyebrow}</div>
          </div>
          <h2 id={`suggestion-${suggestion.id}`} className="type-heading mt-2">
            {suggestion.title}
          </h2>
          <p className="type-body text-muted-foreground mt-1 max-w-2xl">{suggestion.description}</p>
          <dl className="border-status-success-border mt-4 grid gap-px overflow-hidden rounded-lg border sm:grid-cols-3">
            {suggestion.facts.map(fact => (
              <div key={fact.label} className="bg-background p-3">
                <dt className="type-label text-muted-foreground">{fact.label}</dt>
                <dd className="type-body mt-1 font-mono font-semibold tabular-nums">
                  {fact.value}
                </dd>
              </div>
            ))}
          </dl>
          <p className="type-label text-muted-foreground mt-3">
            Value depends on current terms, usage, and eligibility.
          </p>
        </div>
        {canManage && (
          <div className="flex flex-col gap-2 sm:flex-row lg:w-52 lg:flex-col">
            <Button asChild className="min-h-control-touch w-full sm:min-h-0">
              <a
                href={suggestion.ctaHref}
                onClick={event => {
                  if (!onCta) return;
                  if (
                    event.defaultPrevented ||
                    event.button !== 0 ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  ) {
                    return;
                  }
                  event.preventDefault();
                  void onCta();
                }}
              >
                {suggestion.ctaLabel}
                <ArrowRight className="size-4" aria-hidden="true" />
              </a>
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-control-touch w-full sm:min-h-0"
              disabled={dismissPending}
              aria-busy={dismissPending}
              onClick={onDismiss}
            >
              {dismissPending ? (
                <Loader2
                  className="size-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <XCircle className="size-4" aria-hidden="true" />
              )}
              {dismissPending ? 'Dismissing suggestion...' : 'Dismiss suggestion'}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
