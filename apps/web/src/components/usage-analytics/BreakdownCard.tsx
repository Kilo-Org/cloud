'use client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Filter, Minus } from 'lucide-react';
import { formatDollarsFromMicrodollars, formatMetric } from './format';
import { formatLargeNumber } from '@/lib/utils';
import type { Dimension, UsageBreakdown } from './types';

type BreakdownCardProps = {
  title: string;
  dimension: Dimension;
  data: UsageBreakdown | undefined;
  loading: boolean;
  metric: 'cost' | 'requests' | 'tokens';
  onIncludeFilter?: (dimension: Dimension, value: string) => void;
  onExcludeFilter?: (dimension: Dimension, value: string) => void;
  /** Resolves user IDs to friendly email/name labels. */
  labelFor?: (value: string) => string;
};

function formatBreakdownValue(metric: 'cost' | 'requests' | 'tokens', value: number): string {
  if (metric === 'cost') return formatDollarsFromMicrodollars(value);
  if (metric === 'requests') return formatLargeNumber(value);
  return formatMetric('tokens', value);
}

export function BreakdownCard({
  title,
  dimension,
  data,
  loading,
  metric,
  onIncludeFilter,
  onExcludeFilter,
  labelFor,
}: BreakdownCardProps) {
  const items = data?.breakdown ?? [];
  const showActions = onIncludeFilter || onExcludeFilter;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="pt-3">
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="bg-muted/30 h-6 w-full animate-pulse rounded" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <p className="text-muted-foreground text-sm">No data.</p>
        ) : (
          <ul className="space-y-1">
            {items.map(item => (
              <li key={item.key} className="group relative">
                <div className="relative">
                  <div
                    className="absolute inset-y-0 left-0 rounded bg-blue-500/20"
                    style={{ width: `${Math.min(100, item.percentage)}%` }}
                  />
                  <div className="relative flex items-center justify-between gap-2 px-2 py-1 text-xs">
                    <span className="truncate font-medium">
                      {labelFor ? labelFor(item.key) : item.label || '(unknown)'}
                    </span>
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">{item.percentage.toFixed(1)}%</span>
                      <span className="font-mono">{formatBreakdownValue(metric, item.value)}</span>
                      {showActions && (
                        <div className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                          {onIncludeFilter && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-5 w-5 p-0"
                              onClick={() => onIncludeFilter(dimension, item.key)}
                              title="Filter to this value"
                            >
                              <Filter className="h-3 w-3" />
                            </Button>
                          )}
                          {onExcludeFilter && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-5 w-5 p-0"
                              onClick={() => onExcludeFilter(dimension, item.key)}
                              title="Exclude this value"
                            >
                              <Minus className="h-3 w-3" />
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
