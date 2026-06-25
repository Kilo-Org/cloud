'use client';

import { useState, type CSSProperties } from 'react';
import { ArrowRight, Clock3 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { money, percentOf } from '../formatting';
import { EmptyPanel } from '../shared/EmptyPanel';
import type { CostInsightsDashboardData, SpendRange } from '../types';

function isSpendRange(value: string): value is SpendRange {
  return ['24h', '7d', '30d', '90d'].includes(value);
}

export function SpendEvidenceCard({ data }: { data: CostInsightsDashboardData }) {
  const [selectedRange, setSelectedRange] = useState<SpendRange>();
  const range = selectedRange ?? data.range;
  const evidence = range === data.range ? data.evidence : (data.evidenceByRange?.[range] ?? []);
  const totals = evidence.map(point => point.variableUsd + point.scheduledUsd);
  const maxSpend = Math.max(1, ...totals);
  const rangeLabel = {
    '24h': 'Last 24 hours',
    '7d': 'Last 7 days',
    '30d': 'Last 30 days',
    '90d': 'Last 90 days',
  }[range];
  const highestIndex = totals.indexOf(Math.max(...totals));
  const highest = evidence[highestIndex];
  const total = totals.reduce((sum, value) => sum + value, 0);
  const isDenseRange = range === '30d';
  const barMinimumWidth = range === '30d' ? '0.75rem' : range === '90d' ? '1.5rem' : '2rem';
  const chartMinimumWidth = range === '30d' ? '40rem' : '32rem';

  return (
    <Card className="min-w-0">
      <CardHeader className="gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <CardTitle className="type-heading">Spend over time</CardTitle>
          <CardDescription>
            {rangeLabel}. Usage-based and scheduled spend are shown separately.
          </CardDescription>
        </div>
        <Tabs
          className="w-full lg:w-auto"
          value={range}
          onValueChange={value => {
            if (isSpendRange(value)) setSelectedRange(value);
          }}
        >
          <TabsList
            aria-label="Spend range"
            className="border-input bg-input-background grid h-auto w-full grid-cols-4 gap-1 border lg:inline-flex lg:w-auto"
          >
            {(['24h', '7d', '30d', '90d'] as SpendRange[]).map(range => (
              <TabsTrigger
                key={range}
                value={range}
                className="min-h-control-touch type-label data-[state=active]:bg-surface-selected lg:min-h-9"
              >
                {range}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </CardHeader>
      <CardContent className="space-y-4">
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
                Scheduled
              </span>
            </div>
            <p className="sr-only">
              {rangeLabel}: {money(total)} total.{' '}
              {highest
                ? `Highest period was ${highest.label} at ${money(highest.variableUsd + highest.scheduledUsd)}.`
                : ''}
            </p>
            <div className="border-border bg-surface-inset max-w-full overflow-x-auto rounded-lg border p-4">
              <div
                className="relative grid grid-cols-[repeat(var(--bar-count),minmax(var(--bar-min-width),1fr))] items-end gap-2 pl-12"
                style={
                  {
                    '--bar-count': evidence.length,
                    '--bar-min-width': barMinimumWidth,
                    minWidth: chartMinimumWidth,
                  } as CSSProperties
                }
              >
                <div
                  className="pointer-events-none absolute inset-x-0 top-6 h-44"
                  aria-hidden="true"
                >
                  <ChartGridLine position="top-0" label={money(maxSpend)} />
                  <ChartGridLine position="top-1/2" label={money(maxSpend / 2)} />
                  <ChartGridLine position="bottom-0" label="$0" />
                </div>
                {evidence.map((point, index) => {
                  const pointTotal = point.variableUsd + point.scheduledUsd;
                  const totalHeight = Math.max(2, percentOf(pointTotal, maxSpend));
                  const scheduledShare = percentOf(point.scheduledUsd, pointTotal);
                  return (
                    <Tooltip key={point.label}>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className="focus-visible:ring-ring group relative z-10 flex min-w-0 flex-col items-center gap-2 rounded-sm focus-visible:ring-2 focus-visible:outline-none"
                          aria-label={`${point.label}: ${money(pointTotal)} total, ${money(point.variableUsd)} usage-based, ${money(point.scheduledUsd)} scheduled`}
                        >
                          <span
                            className={cn(
                              'type-label font-mono tabular-nums',
                              isDenseRange ? 'sr-only' : 'hidden xl:block'
                            )}
                          >
                            {money(pointTotal)}
                          </span>
                          <span className="flex h-44 w-full items-end">
                            <span
                              className="group-hover:ring-foreground/50 flex w-full flex-col-reverse overflow-hidden rounded-t-sm transition-[filter,box-shadow] duration-150 group-hover:brightness-110 group-focus-visible:brightness-110"
                              style={{ height: `${totalHeight}%` }}
                            >
                              <span
                                className="bg-chart-1"
                                style={{ height: `${100 - scheduledShare}%` }}
                              />
                              <span
                                className="bg-chart-2"
                                style={{ height: `${scheduledShare}%` }}
                              />
                            </span>
                          </span>
                          <span
                            className={cn(
                              'type-label text-muted-foreground w-full text-center whitespace-nowrap',
                              isDenseRange && index % 3 !== 0 && 'invisible'
                            )}
                          >
                            {point.label}
                          </span>
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" sideOffset={8} className="min-w-44 p-3">
                        <div className="type-label font-medium">{point.label}</div>
                        <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 type-label">
                          <dt className="text-muted-foreground">Total</dt>
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
                            Scheduled
                          </dt>
                          <dd className="text-right font-mono tabular-nums">
                            {money(point.scheduledUsd)}
                          </dd>
                        </dl>
                      </TooltipContent>
                    </Tooltip>
                  );
                })}
              </div>
            </div>
            <div className="flex items-center gap-1.5 type-label text-muted-foreground lg:hidden">
              Scroll chart to see all periods
              <ArrowRight className="size-icon-sm" aria-hidden="true" />
            </div>
            <div className="flex flex-wrap justify-between gap-2 type-label text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Clock3 className="size-icon-sm" aria-hidden="true" />
                {data.lastEvaluatedLabel}
              </span>
              <span>{baselineLabel(data.baselineMode)}</span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
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
