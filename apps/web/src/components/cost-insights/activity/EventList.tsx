import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Lightbulb,
  Settings2,
  TrendingUp,
  XCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { money, percentOf, sourceLabels } from '../formatting';
import { EmptyPanel } from '../shared/EmptyPanel';
import { LocalDateTime } from '../shared/LocalDateTime';
import { StatusBadge } from '../shared/StatusBadge';
import type { CostInsightEvent } from '../types';

const eventPresentation = {
  anomaly_alert: { icon: TrendingUp, label: 'Anomaly alert', tone: 'warning' },
  threshold_crossed: { icon: AlertTriangle, label: 'Threshold alert', tone: 'warning' },
  suggestion_created: { icon: Lightbulb, label: 'Suggestion', tone: 'success' },
  suggestion_dismissed: { icon: XCircle, label: 'Suggestion dismissed', tone: 'neutral' },
  reviewed: { icon: CheckCircle2, label: 'Review', tone: 'neutral' },
  config_changed: { icon: Settings2, label: 'Settings change', tone: 'neutral' },
  disabled: { icon: XCircle, label: 'Settings change', tone: 'neutral' },
} satisfies Record<
  CostInsightEvent['type'],
  { icon: typeof AlertTriangle; label: string; tone: 'warning' | 'success' | 'neutral' }
>;

export function EventList({
  events,
  compact = false,
}: {
  events: CostInsightEvent[];
  compact?: boolean;
}) {
  if (events.length === 0)
    return <EmptyPanel title="No recent activity" description="New activity will appear here." />;
  return (
    <ol className="divide-border divide-y">
      {events.map(event => {
        const { icon: Icon, label: eventLabel, tone } = eventPresentation[event.type];
        const capturedSpend =
          event.topDrivers?.reduce((sum, driver) => sum + driver.spendUsd, 0) ?? 0;
        return (
          <li key={event.id} className={cn(compact ? 'py-5 first:pt-0 last:pb-0' : 'p-4 sm:p-6')}>
            <div className="grid gap-3 lg:grid-cols-[10rem_minmax(0,1fr)_auto] lg:gap-5">
              <div className="flex items-center gap-3 lg:flex-col lg:items-start lg:gap-2">
                <LocalDateTime
                  timestamp={event.occurredAt}
                  className="type-label text-muted-foreground block shrink-0"
                />
                <StatusBadge tone={tone}>{eventLabel}</StatusBadge>
              </div>
              <div className="min-w-0">
                <div className="flex gap-3">
                  <div className="bg-surface-overlay text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-lg">
                    <Icon className="size-4" aria-hidden="true" />
                  </div>
                  <div className="min-w-0">
                    <div className="type-body font-medium break-words">{event.title}</div>
                    <p className="type-label text-muted-foreground mt-1">{event.description}</p>
                    {event.actorLabel && (
                      <p className="type-label text-muted-foreground mt-2">By {event.actorLabel}</p>
                    )}
                  </div>
                </div>
              </div>
              {event.amountLabel && (
                <div className="lg:text-right">
                  <div className="font-mono type-body font-semibold tabular-nums">
                    {event.amountLabel}
                  </div>
                  {event.amountClassifier && (
                    <div className="type-label text-muted-foreground mt-0.5">
                      {event.amountClassifier}
                    </div>
                  )}
                </div>
              )}
              {!compact && event.topDrivers && event.topDrivers.length > 0 && (
                <details className="group lg:col-span-2 lg:col-start-2">
                  <summary className="focus-visible:ring-ring text-muted-foreground hover:text-foreground inline-flex min-h-control-touch cursor-pointer list-none items-center gap-1.5 rounded-md type-label font-medium focus-visible:ring-2 focus-visible:outline-none sm:min-h-8">
                    View contributors
                    <ChevronDown
                      className="size-icon-sm transition-transform group-open:rotate-180 motion-reduce:transition-none"
                      aria-hidden="true"
                    />
                  </summary>
                  <div className="border-border bg-surface-inset mt-2 overflow-hidden rounded-lg border">
                    <div className="border-border flex items-center justify-between gap-4 border-b px-4 py-3">
                      <div className="type-label font-medium">
                        Largest contributors at alert time
                      </div>
                      <div className="type-label text-muted-foreground shrink-0">
                        {money(capturedSpend)} captured
                      </div>
                    </div>
                    <ol className="divide-border divide-y">
                      {event.topDrivers.slice(0, 5).map((driver, index) => {
                        const share = percentOf(driver.spendUsd, capturedSpend);
                        return (
                          <li
                            key={`${event.id}-${driver.id}`}
                            className="grid gap-3 px-4 py-3 lg:grid-cols-[1.5rem_minmax(0,1fr)_10rem] lg:items-center"
                          >
                            <span className="type-label text-muted-foreground hidden font-mono lg:block">
                              {index + 1}
                            </span>
                            <div className="min-w-0">
                              <div className="type-body font-medium break-words">
                                {driver.label}
                              </div>
                              <dl className="mt-3 grid gap-x-4 gap-y-3 sm:grid-cols-3">
                                <div className="min-w-0">
                                  <dt className="type-eyebrow text-foreground-subtle">Member</dt>
                                  <dd className="type-label text-muted-foreground mt-1 break-words">
                                    {driver.actorLabel ?? 'No member attributed'}
                                  </dd>
                                </div>
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
                              </dl>
                            </div>
                            <div className="lg:text-right">
                              <div className="type-body font-mono font-semibold tabular-nums">
                                {money(driver.spendUsd)}
                              </div>
                              <div className="type-label text-muted-foreground mt-0.5 lg:whitespace-nowrap">
                                {share}% of captured spend
                              </div>
                              <div
                                className="bg-surface-overlay mt-2 h-1 overflow-hidden rounded-full"
                                aria-hidden="true"
                              >
                                <div
                                  className="bg-chart-1 h-full rounded-full"
                                  style={{ width: `${share}%` }}
                                />
                              </div>
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                  </div>
                </details>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
