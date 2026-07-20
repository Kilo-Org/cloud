'use client';

import { useId, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { Clock3 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  formatSpendEvidenceTime,
  money,
  niceCeil,
  percentOf,
  spendBarHeightPercent,
} from '../formatting';
import { EmptyPanel } from '../shared/EmptyPanel';
import { LocalDateTime, useViewerTimeZone } from '../shared/LocalDateTime';
import type { CostInsightsDashboardData, SpendRange } from '../types';

export function SpendEvidenceCard({
  data,
  range,
}: {
  data: CostInsightsDashboardData;
  range: SpendRange;
}) {
  const viewerTimeZone = useViewerTimeZone();
  const chartInstructionsId = useId();
  const [activeBarIndex, setActiveBarIndex] = useState(0);
  const barRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const rawEvidence = range === data.range ? data.evidence : data.evidenceByRange[range];
  const evidence = rawEvidence.map(point => ({
    ...point,
    label: formatSpendEvidenceTime(point.periodStart, range, viewerTimeZone),
    variableUsd: point.variableUsd ?? 0,
    scheduledUsd: point.scheduledUsd ?? 0,
  }));
  const totals = evidence.map(point => point.variableUsd + point.scheduledUsd);
  const axisMax = niceCeil(Math.max(0, ...totals));
  const hasSpend = axisMax > 0;
  const hasIncompleteEvidence = evidence.some(point => point.coverage !== 'complete');
  const shouldRenderChart = hasSpend || hasIncompleteEvidence;
  const rangeLabel = {
    '1h': 'This hour',
    '24h': 'Last 24 hours',
    '7d': 'Last 7 days',
    '30d': 'Last 30 days',
    '90d': 'Last 90 days',
  }[range];
  const highest = evidence
    .filter(point => point.coverage !== 'unavailable')
    .reduce<(typeof evidence)[number] | undefined>((currentHighest, point) => {
      if (!currentHighest) return point;
      const currentTotal = currentHighest.variableUsd + currentHighest.scheduledUsd;
      return point.variableUsd + point.scheduledUsd > currentTotal ? point : currentHighest;
    }, undefined);
  const completeTotal = hasIncompleteEvidence
    ? null
    : totals.reduce((sum, value) => sum + value, 0);
  const tickStride = Math.max(1, Math.ceil(evidence.length / 6));
  const zeroStateMessage =
    range === '1h' ? 'No spend in the current hour yet.' : 'No spend in the selected period yet.';
  const focusedBarIndex = Math.min(activeBarIndex, Math.max(0, evidence.length - 1));

  const handleBarKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | undefined;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (index + 1) % evidence.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (index - 1 + evidence.length) % evidence.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = evidence.length - 1;
    }
    if (nextIndex === undefined) return;

    event.preventDefault();
    setActiveBarIndex(nextIndex);
    barRefs.current[nextIndex]?.focus();
  };

  return (
    <section className="min-w-0 space-y-4" aria-label="Spend chart">
      {evidence.length === 0 ? (
        <EmptyPanel
          title="No spend in this period"
          description="New Credit spend will appear here."
        />
      ) : (
        <>
          <div
            className="flex flex-wrap gap-x-5 gap-y-2 type-label text-muted-foreground"
            aria-hidden="true"
          >
            <span className="flex items-center gap-2">
              <span className="bg-chart-1 size-2.5 rounded-sm" />
              Usage-based
            </span>
            <span className="flex items-center gap-2">
              <span className="bg-chart-2 size-2.5 rounded-sm" />
              Subscriptions
            </span>
          </div>
          <p className="sr-only">
            {completeTotal === null
              ? `${rangeLabel}: spend total unavailable because one or more periods have incomplete coverage.`
              : `${rangeLabel}: ${money(completeTotal)} total.`}{' '}
            {highest
              ? `Highest period with spend evidence was ${highest.label} at ${money(highest.variableUsd + highest.scheduledUsd)}.`
              : ''}
          </p>
          <p id={chartInstructionsId} className="sr-only">
            Use Left and Right Arrow keys to inspect each period. Use Home and End to jump to the
            first or last period.
          </p>
          {shouldRenderChart ? (
            <div className="border-border bg-surface-inset rounded-lg border p-4">
              <fieldset
                aria-describedby={chartInstructionsId}
                className="relative grid grid-cols-[repeat(var(--bar-count),minmax(0,1fr))] items-end gap-1 pl-12"
                style={{ '--bar-count': evidence.length } as CSSProperties}
              >
                <legend className="sr-only">{rangeLabel} spend by period</legend>
                <div
                  className="pointer-events-none absolute inset-x-0 top-7 h-44"
                  aria-hidden="true"
                >
                  <ChartGridLine position="top-0" label={money(axisMax)} />
                  <ChartGridLine position="top-1/2" label={money(axisMax / 2)} />
                  <ChartGridLine position="bottom-0" label="$0" />
                </div>
                {evidence.map((point, index) => {
                  const pointTotal = point.variableUsd + point.scheduledUsd;
                  const totalHeight = spendBarHeightPercent(pointTotal, axisMax);
                  const scheduledShare = percentOf(point.scheduledUsd, pointTotal);
                  const isPeak = highest !== undefined && point.periodStart === highest.periodStart;
                  const showTick = index % tickStride === 0 || index === evidence.length - 1;
                  const accessibilityLabel =
                    point.coverage === 'unavailable'
                      ? `${point.label}: spend data unavailable, ${point.coveredHours} of ${point.totalHours} hours covered`
                      : `${point.label}: ${point.coverage === 'partial' ? 'at least ' : ''}${money(pointTotal)} total, ${money(point.variableUsd)} usage-based, ${money(point.scheduledUsd)} scheduled${point.coverage === 'partial' ? `, ${point.coveredHours} of ${point.totalHours} hours covered` : ''}`;
                  return (
                    <Tooltip key={point.periodStart}>
                      <TooltipTrigger asChild>
                        <button
                          ref={element => {
                            barRefs.current[index] = element;
                          }}
                          type="button"
                          tabIndex={index === focusedBarIndex ? 0 : -1}
                          className="focus-visible:ring-ring group relative z-10 flex min-w-0 flex-col items-center gap-2 rounded-sm focus-visible:ring-2 focus-visible:outline-none"
                          aria-label={accessibilityLabel}
                          onFocus={() => setActiveBarIndex(index)}
                          onKeyDown={event => handleBarKeyDown(event, index)}
                        >
                          <span className="flex h-5 w-full items-end justify-center">
                            {isPeak && point.coverage !== 'unavailable' && (
                              <span className="type-label font-mono tabular-nums whitespace-nowrap">
                                {money(pointTotal)}
                              </span>
                            )}
                          </span>
                          <span className="flex h-44 w-full items-end">
                            <span
                              className={cn(
                                'group-hover:ring-foreground/50 mx-auto flex w-full max-w-10 flex-col-reverse overflow-hidden rounded-t-sm transition-[filter,box-shadow] duration-150 group-hover:brightness-110 group-focus-visible:brightness-110',
                                point.coverage === 'partial' &&
                                  'border-border-strong border border-dashed',
                                point.coverage === 'unavailable' &&
                                  'border-border-strong bg-surface-overlay h-2 border border-dashed'
                              )}
                              style={
                                point.coverage !== 'unavailable'
                                  ? { height: `${totalHeight}%` }
                                  : undefined
                              }
                            >
                              {point.coverage !== 'unavailable' && (
                                <>
                                  <span
                                    className="bg-chart-1"
                                    style={{ height: `${100 - scheduledShare}%` }}
                                  />
                                  <span
                                    className="bg-chart-2"
                                    style={{ height: `${scheduledShare}%` }}
                                  />
                                </>
                              )}
                            </span>
                          </span>
                          <span
                            className={cn(
                              'type-label text-muted-foreground w-full text-center whitespace-nowrap',
                              !showTick && 'invisible'
                            )}
                          >
                            {point.label}
                          </span>
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" sideOffset={8} className="min-w-44 p-3">
                        <div className="type-label font-medium">{point.label}</div>
                        {point.coverage !== 'unavailable' ? (
                          <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 type-label">
                            <dt className="text-muted-foreground">
                              {point.coverage === 'partial' ? 'Known spend' : 'Total'}
                            </dt>
                            <dd className="text-right font-mono font-semibold tabular-nums">
                              {money(pointTotal)}
                            </dd>
                            <dt className="flex items-center gap-1.5 text-muted-foreground">
                              <span className="bg-chart-1 size-2 rounded-sm" aria-hidden="true" />
                              Usage-based
                            </dt>
                            <dd className="text-right font-mono tabular-nums">
                              {money(point.variableUsd)}
                            </dd>
                            <dt className="flex items-center gap-1.5 text-muted-foreground">
                              <span className="bg-chart-2 size-2 rounded-sm" aria-hidden="true" />
                              Subscriptions
                            </dt>
                            <dd className="text-right font-mono tabular-nums">
                              {money(point.scheduledUsd)}
                            </dd>
                            {point.coverage === 'partial' && (
                              <dt className="text-muted-foreground col-span-2 mt-1">
                                Partial coverage: {point.coveredHours} of {point.totalHours} hours.
                              </dt>
                            )}
                          </dl>
                        ) : (
                          <p className="type-label text-muted-foreground mt-2">
                            Spend data unavailable. Covered {point.coveredHours} of{' '}
                            {point.totalHours} hours.
                          </p>
                        )}
                      </TooltipContent>
                    </Tooltip>
                  );
                })}
              </fieldset>
            </div>
          ) : (
            <div className="border-border bg-surface-inset rounded-lg border p-4">
              <div className="relative h-44">
                <ChartGridLine position="bottom-0" label="$0" />
              </div>
              <p className="type-label text-muted-foreground mt-2 text-center">
                {zeroStateMessage}
              </p>
            </div>
          )}
          <div className="flex flex-wrap justify-between gap-2 type-label text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Clock3 className="size-icon-sm" aria-hidden="true" />
              {data.lastEvaluatedAt ? (
                <LocalDateTime timestamp={data.lastEvaluatedAt} prefix="Last evaluated " />
              ) : (
                'Not evaluated yet'
              )}
            </span>
            <span>{baselineLabel(data.baselineMode)}</span>
          </div>
        </>
      )}
    </section>
  );
}

function ChartGridLine({ position, label }: { position: string; label: string }) {
  return (
    <div className={cn('border-border absolute inset-x-0 border-t', position)}>
      <span className="bg-surface-inset type-label text-muted-foreground absolute -top-2.5 left-0 pr-2 font-mono tabular-nums">
        {label}
      </span>
    </div>
  );
}

function baselineLabel(mode: CostInsightsDashboardData['baselineMode']) {
  if (mode === 'starter') return 'Anomaly detection uses a starter alert level';
  if (mode === 'available-history') return 'Anomaly detection uses available spend history';
  return 'Anomaly detection uses your recent hourly pattern';
}
