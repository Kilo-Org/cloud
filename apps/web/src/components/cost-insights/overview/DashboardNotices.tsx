import { AlertTriangle, ArrowRight, Bell, Lightbulb, TrendingUp, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { CostSuggestion, DashboardAlert, DashboardAlertAction } from '../types';

const reviewActionLabels = {
  acknowledge: 'Mark as reviewed',
  view_spend: 'View spend drivers',
  disable_alerts: 'Turn off alerts',
  adjust_threshold: 'Change threshold',
  disable_threshold: 'Turn off threshold',
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
              ? 'Spend data stays visible. Turn on Spend Alerts for unusual hourly increases and an optional 24-hour threshold.'
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
  primaryAction,
  actionsDisabled = false,
  canManage = true,
  onAction,
}: {
  alert: DashboardAlert;
  primaryAction: boolean;
  actionsDisabled?: boolean;
  canManage?: boolean;
  onAction?: (action: DashboardAlertAction) => void;
}) {
  const Icon = alert.type === 'threshold' ? AlertTriangle : TrendingUp;
  return (
    <section
      className="border-status-warning-border bg-status-warning-surface rounded-xl border p-6"
      aria-labelledby={`alert-${alert.type}`}
    >
      <div className={cn('grid gap-5', canManage && 'lg:grid-cols-[minmax(0,1fr)_auto]')}>
        <div>
          <div className="flex gap-3">
            <Icon className="text-status-warning-icon mt-0.5 size-5 shrink-0" aria-hidden="true" />
            <div>
              <h2 id={`alert-${alert.type}`} className="type-heading">
                {alert.title}
              </h2>
              <p className="type-body text-muted-foreground mt-1 max-w-2xl">{alert.description}</p>
            </div>
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
        </div>
        {canManage && (
          <ReviewActions
            alert={alert}
            primaryAction={primaryAction}
            actionsDisabled={actionsDisabled}
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
  onAction,
}: {
  alert: DashboardAlert;
  primaryAction: boolean;
  actionsDisabled: boolean;
  onAction?: (action: DashboardAlertAction) => void;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap lg:w-52 lg:flex-col">
      {alert.actions.map((action, index) => (
        <Button
          key={action}
          type="button"
          variant={index === 0 && primaryAction ? 'default' : 'outline'}
          className="min-h-control-touch w-full sm:min-h-0"
          disabled={actionsDisabled}
          aria-busy={actionsDisabled && action === 'acknowledge'}
          onClick={() => onAction?.(action)}
        >
          {action.includes('disable') ? (
            <XCircle className="size-4" aria-hidden="true" />
          ) : (
            <ArrowRight className="size-4" aria-hidden="true" />
          )}
          {reviewActionLabels[action]}
        </Button>
      ))}
    </div>
  );
}

export function SuggestionCard({
  suggestion,
  canManage = true,
  onDismiss,
}: {
  suggestion: CostSuggestion;
  canManage?: boolean;
  onDismiss?: () => void;
}) {
  return (
    <section
      className="border-status-success-border bg-status-success-surface rounded-xl border p-6"
      aria-labelledby={`suggestion-${suggestion.id}`}
    >
      <div className={cn('grid gap-5', canManage && 'lg:grid-cols-[minmax(0,1fr)_auto]')}>
        <div>
          <div className="flex gap-3">
            <Lightbulb
              className="text-status-success-icon mt-0.5 size-5 shrink-0"
              aria-hidden="true"
            />
            <div>
              <div className="type-eyebrow text-status-success mb-2">{suggestion.eyebrow}</div>
              <h2 id={`suggestion-${suggestion.id}`} className="type-heading">
                {suggestion.title}
              </h2>
              <p className="type-body text-muted-foreground mt-1 max-w-2xl">
                {suggestion.description}
              </p>
            </div>
          </div>
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
            Benefits shown use current plan terms. Actual value depends on usage and eligibility.
          </p>
        </div>
        {canManage && (
          <div className="flex flex-col gap-2 sm:flex-row lg:w-52 lg:flex-col">
            <Button asChild className="min-h-control-touch w-full sm:min-h-0">
              <a href={suggestion.ctaHref}>
                {suggestion.ctaLabel}
                <ArrowRight className="size-4" aria-hidden="true" />
              </a>
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-control-touch w-full sm:min-h-0"
              onClick={onDismiss}
            >
              <XCircle className="size-4" aria-hidden="true" />
              Dismiss suggestion
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
