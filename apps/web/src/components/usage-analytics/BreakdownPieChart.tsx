'use client';
import { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { cn } from '@/lib/utils';
import { OTHER_COLOR, PALETTE } from './colors';
import { formatDollarsFromMicrodollars } from './format';
import type { Dimension, UsageBreakdown } from './types';

const TOP_N = 8;

type BreakdownPieChartProps = {
  title: string;
  dimension: Dimension;
  data: UsageBreakdown | undefined;
  loading: boolean;
  labelFor?: (value: string) => string;
};

type Slice = {
  key: string;
  label: string;
  value: number;
  percentage: number;
  color: string;
  /** Real values backing this slice (excludes the synthetic "Other" aggregate). */
  sourceKeys?: string[];
};

export function BreakdownPieChart({ title, data, loading, labelFor }: BreakdownPieChartProps) {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  const slices = useMemo<Slice[]>(() => {
    const items = data?.breakdown ?? [];
    if (items.length === 0) return [];

    const totalValue = items.reduce((s, i) => s + i.value, 0);
    if (totalValue <= 0) return [];

    const sorted = [...items].sort((a, b) => b.value - a.value);
    const head = sorted.slice(0, TOP_N);
    const tail = sorted.slice(TOP_N);

    const headSlices = head.map((item, i): Slice => {
      const display = labelFor ? labelFor(item.key) : item.label || item.key || '(unknown)';
      return {
        key: item.key,
        label: display,
        value: item.value,
        percentage: (item.value / totalValue) * 100,
        color: PALETTE[i % PALETTE.length],
      };
    });

    if (tail.length === 0) return headSlices;

    const otherValue = tail.reduce((s, i) => s + i.value, 0);
    return [
      ...headSlices,
      {
        key: '__other__',
        label: `Other (${tail.length})`,
        value: otherValue,
        percentage: (otherValue / totalValue) * 100,
        color: OTHER_COLOR,
        sourceKeys: tail.map(t => t.key),
      },
    ];
  }, [data, labelFor]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="pt-3">
        {loading ? (
          <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center">
            <div className="flex w-full justify-center sm:w-1/2">
              <div className="bg-muted/30 aspect-square w-full max-w-[280px] animate-pulse rounded-full" />
            </div>
            <div className="flex w-full flex-col gap-2 sm:w-1/2">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="bg-muted/30 h-4 w-full animate-pulse rounded" />
              ))}
            </div>
          </div>
        ) : slices.length === 0 ? (
          <p className="text-muted-foreground text-sm">No data.</p>
        ) : (
          <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center">
            <div className="flex w-full justify-center sm:w-1/2">
              <div className="relative aspect-square w-full max-w-[280px]">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={slices}
                      cx="50%"
                      cy="50%"
                      innerRadius="56%"
                      outerRadius="92%"
                      paddingAngle={2}
                      dataKey="value"
                      strokeWidth={0}
                      onMouseEnter={(_, i) => setHoveredKey(slices[i]?.key ?? null)}
                      onMouseLeave={() => setHoveredKey(null)}
                    >
                      {slices.map(slice => (
                        <Cell key={slice.key} fill={slice.color} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{
                        backgroundColor: 'rgba(17, 24, 39, 0.95)',
                        border: '1px solid rgba(255,255,255,0.08)',
                        borderRadius: 6,
                        fontSize: 12,
                      }}
                      formatter={(value, _name, item) => {
                        const raw = Number(value);
                        const pct = (item?.payload as Slice | undefined)?.percentage ?? 0;
                        return [
                          `${formatDollarsFromMicrodollars(raw)} (${pct.toFixed(1)}%)`,
                          (item?.payload as Slice | undefined)?.label ?? '',
                        ];
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>
            <ul className="flex w-full min-w-0 flex-col gap-1 text-xs sm:w-1/2">
              {slices.map(slice => (
                <li
                  key={slice.key}
                  className={cn(
                    'flex items-center gap-2 rounded px-1.5 py-1 transition-colors',
                    hoveredKey === slice.key && 'bg-muted/40'
                  )}
                  onMouseEnter={() => setHoveredKey(slice.key)}
                  onMouseLeave={() => setHoveredKey(null)}
                >
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-sm"
                    style={{ backgroundColor: slice.color }}
                  />
                  <span className="min-w-0 flex-1 truncate font-medium">{slice.label}</span>
                  <span className="text-muted-foreground shrink-0">
                    {slice.percentage.toFixed(1)}%
                  </span>
                  <span className="shrink-0 font-mono">
                    {formatDollarsFromMicrodollars(slice.value)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
