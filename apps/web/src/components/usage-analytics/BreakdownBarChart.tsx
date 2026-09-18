'use client';
import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { colorForIndex } from './colors';
import { formatDollarsFromMicrodollars, formatMetric } from './format';
import { formatLargeNumber } from '@/lib/utils';
import type { Dimension, UsageBreakdown } from './types';

type BreakdownBarChartProps = {
  title: string;
  dimension: Dimension;
  data: UsageBreakdown | undefined;
  loading: boolean;
  metric: 'cost' | 'requests' | 'tokens';
  labelFor?: (value: string) => string;
};

type BarDatum = {
  key: string;
  label: string;
  value: number;
  percentage: number;
  color: string;
};

/**
 * One body height for every state — loading, empty and loaded. The item count
 * is unknown until the breakdown resolves, so a height derived from it (as it
 * was: `min(420, max(180, items * 36 + 24))`) grew this card the moment the
 * data landed and pushed the summary and every card below it down.
 *
 * The body reserves the chart's tallest size (the old ceiling, 420px) rather
 * than its floor: a fixed 180px floor held the layout still but squashed a tall
 * breakdown into the short list's height. Reserving the ceiling keeps the tall
 * case at its full size and still never grows the card, because short lists
 * render inside the same slot.
 */
const CHART_BODY_HEIGHT = 420;

/** Approximate pixels per character for the 11px tick font. */
const CHAR_PIXEL_WIDTH = 6.5;
const LABEL_MIN_WIDTH = 120;
const LABEL_MAX_WIDTH = 280;
const LABEL_RIGHT_PADDING = 16;

function formatBarValue(metric: 'cost' | 'requests' | 'tokens', value: number): string {
  if (metric === 'cost') return formatDollarsFromMicrodollars(value);
  if (metric === 'requests') return formatLargeNumber(value);
  return formatMetric('tokens', value);
}

export function BreakdownBarChart({
  title,
  data,
  loading,
  metric,
  labelFor,
}: BreakdownBarChartProps) {
  const items = useMemo<BarDatum[]>(() => {
    const list = data?.breakdown ?? [];
    if (list.length === 0) return [];
    return list.map((item, i) => ({
      key: item.key,
      label: labelFor ? labelFor(item.key) : item.label || item.key || '(unknown)',
      value: item.value,
      percentage: item.percentage,
      color: colorForIndex(i),
    }));
  }, [data, labelFor]);

  /** Size the Y-axis to fit the longest label so names aren't truncated. */
  const yAxisWidth = useMemo(() => {
    if (items.length === 0) return LABEL_MIN_WIDTH;
    const longest = items.reduce((m, i) => Math.max(m, i.label.length), 0);
    return Math.min(
      LABEL_MAX_WIDTH,
      Math.max(LABEL_MIN_WIDTH, Math.ceil(longest * CHAR_PIXEL_WIDTH) + LABEL_RIGHT_PADDING)
    );
  }, [items]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="pt-3">
        <div style={{ height: CHART_BODY_HEIGHT }} className="w-full">
          {loading ? (
            <div className="flex h-full flex-col justify-between py-1">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="bg-muted/30 h-6 w-full animate-pulse rounded" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
              No data.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={items}
                layout="vertical"
                margin={{ top: 4, right: 8, bottom: 4, left: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis
                  type="number"
                  stroke="currentColor"
                  fontSize={11}
                  tickFormatter={v => formatBarValue(metric, Number(v))}
                />
                <YAxis
                  dataKey="label"
                  type="category"
                  stroke="currentColor"
                  fontSize={11}
                  width={yAxisWidth}
                  tickMargin={8}
                  tick={{ fill: 'currentColor' }}
                  interval={0}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'rgba(17, 24, 39, 0.95)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                  itemStyle={{ color: 'rgba(255, 255, 255, 0.9)' }}
                  labelStyle={{ color: 'rgba(255, 255, 255, 0.9)' }}
                  cursor={{ fill: 'rgba(255, 255, 255, 0.04)' }}
                  formatter={(value, _name, item) => {
                    const raw = Number(value);
                    const pct = (item?.payload as BarDatum | undefined)?.percentage ?? 0;
                    return [`${formatBarValue(metric, raw)} (${pct.toFixed(1)}%)`];
                  }}
                />
                <Bar dataKey="value" radius={[0, 4, 4, 0]} isAnimationActive={false}>
                  {items.map(item => (
                    <Cell key={item.key} fill={item.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
