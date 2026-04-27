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

const ROW_HEIGHT = 36;
const MIN_HEIGHT = 180;
const MAX_HEIGHT = 420;

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

  const chartHeight = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, items.length * ROW_HEIGHT + 24));

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
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="bg-muted/30 h-6 w-full animate-pulse rounded" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <p className="text-muted-foreground text-sm">No data.</p>
        ) : (
          <div style={{ height: chartHeight }} className="w-full">
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
          </div>
        )}
      </CardContent>
    </Card>
  );
}
