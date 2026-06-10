'use client';
import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { isDateOnlyString } from '@/lib/utils';
import { OTHER_COLOR, colorForIndex as paletteColorForIndex } from './colors';
import { formatMetric } from './format';
import {
  metricLabelForCostSource,
  type CostSource,
  type Granularity,
  type MetricKey,
  type PeriodOption,
  type UsageTimeseries,
} from './types';

const TOP_SERIES = 10;
const OTHER_KEY = '__other__';

type PrimaryChartProps = {
  metric: MetricKey;
  costSource: CostSource;
  data: UsageTimeseries | undefined;
  loading: boolean;
  splitByLabel?: string;
  /** Optional transform applied to series keys when labeling (legend + tooltip). */
  seriesLabelFor?: (key: string) => string;
  /**
   * Selected period. Used together with `granularity` to pick the right
   * X-axis tick format.
   */
  period: PeriodOption;
  /** Effective granularity of the fetched data. */
  granularity: Granularity;
};

export function PrimaryChart({
  metric,
  costSource,
  data,
  loading,
  splitByLabel,
  seriesLabelFor,
  period,
  granularity,
}: PrimaryChartProps) {
  const { chartData, seriesKeys, otherCount } = useMemo(() => {
    const series = data?.timeseries ?? [];
    if (series.length === 0) return { chartData: [], seriesKeys: [] as string[], otherCount: 0 };

    // When splitBy is set, labels are present. Pivot into wide format.
    const hasLabels = series.some(s => s.label);
    if (hasLabels) {
      // Rank keys by total value across the period; keep top N and aggregate the rest into "Other".
      const totals = new Map<string, number>();
      for (const p of series) {
        const key = p.label || '';
        totals.set(key, (totals.get(key) ?? 0) + (p.value || 0));
      }
      const ranked = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]);
      const topKeys = ranked.slice(0, TOP_SERIES).map(([k]) => k);
      const topKeySet = new Set(topKeys);
      const otherKeyCount = Math.max(0, ranked.length - TOP_SERIES);

      const byDatetime = new Map<string, Record<string, number | string>>();
      for (const p of series) {
        const rawKey = p.label || '';
        const bucketKey = topKeySet.has(rawKey) ? rawKey : OTHER_KEY;
        const row = byDatetime.get(p.datetime) ?? { datetime: p.datetime };
        row[bucketKey] = ((row[bucketKey] as number) ?? 0) + (p.value || 0);
        byDatetime.set(p.datetime, row);
      }
      const displayKeys = otherKeyCount > 0 ? [...topKeys, OTHER_KEY] : topKeys;
      const chartRows = Array.from(byDatetime.values())
        .map(r => {
          for (const k of displayKeys) {
            if (r[k] === undefined) r[k] = 0;
          }
          return r;
        })
        .sort((a, b) => String(a.datetime).localeCompare(String(b.datetime)));
      return { chartData: chartRows, seriesKeys: displayKeys, otherCount: otherKeyCount };
    }

    const chartRows = series.map(p => ({ datetime: p.datetime, value: p.value }));
    return { chartData: chartRows, seriesKeys: ['value'], otherCount: 0 };
  }, [data]);

  const yFormatter = (v: number) => formatMetric(metric, v);
  const xFormatter = (v: string) => {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return v;

    if (granularity === 'hour') {
      // Single-day periods: show only the hour in the viewer's local zone.
      // Multi-day hourly (e.g. Past Week): show abbreviated date + hour so
      // the viewer can distinguish which day each bucket belongs to.
      if (period === 'today' || period === 'yesterday') {
        return d.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true });
      }
      return d.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        hour12: true,
      });
    }

    // Day / week / month granularity: date label only.
    const options: Intl.DateTimeFormatOptions = {
      month: 'short',
      day: 'numeric',
    };
    if (isDateOnlyString(v)) options.timeZone = 'UTC';
    return d.toLocaleDateString('en-US', options);
  };

  const labelForKey = (key: string) => {
    if (key === 'value') return metricLabelForCostSource(metric, costSource);
    if (key === OTHER_KEY) return `Other (${otherCount})`;
    const resolved = seriesLabelFor ? seriesLabelFor(key) : key;
    return resolved || '—';
  };

  const colorForIndex = (i: number, key: string) =>
    key === OTHER_KEY ? OTHER_COLOR : paletteColorForIndex(i);

  const hasSplit = seriesKeys.length > 1;

  return (
    <div className="flex flex-col gap-3">
      {splitByLabel && <div className="text-muted-foreground text-xs">split by {splitByLabel}</div>}
      <div className="h-[300px] w-full">
        {loading ? (
          <div className="bg-muted/20 h-full w-full animate-pulse rounded" />
        ) : chartData.length === 0 ? (
          <div className="text-muted-foreground flex h-full items-center justify-center">
            No data for the selected period.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
              <defs>
                {!hasSplit &&
                  seriesKeys.map((k, i) => (
                    <linearGradient key={k} id={`gradient-${i}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={colorForIndex(i, k)} stopOpacity={0.6} />
                      <stop offset="95%" stopColor={colorForIndex(i, k)} stopOpacity={0} />
                    </linearGradient>
                  ))}
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis
                dataKey="datetime"
                tickFormatter={xFormatter}
                stroke="currentColor"
                fontSize={12}
                minTickGap={24}
              />
              <YAxis tickFormatter={yFormatter} stroke="currentColor" fontSize={12} width={80} />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'rgba(17, 24, 39, 0.95)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: 6,
                  fontSize: 12,
                }}
                labelFormatter={v => {
                  const s = String(v);
                  const d = new Date(s);
                  if (Number.isNaN(d.getTime())) return s;
                  if (isDateOnlyString(s)) {
                    return d.toLocaleDateString('en-US', {
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric',
                      timeZone: 'UTC',
                    });
                  }
                  return d.toLocaleString();
                }}
                formatter={value => yFormatter(Number(value))}
                itemSorter={item => -(Number(item.value) || 0)}
              />
              {seriesKeys.map((key, i) => (
                <Area
                  key={key}
                  type="monotone"
                  dataKey={key}
                  stroke={colorForIndex(i, key)}
                  fill={hasSplit ? 'none' : `url(#gradient-${i})`}
                  strokeWidth={2}
                  isAnimationActive={false}
                  name={labelForKey(key)}
                  dot={false}
                  activeDot={hasSplit ? { r: 3 } : { r: 4 }}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
      {hasSplit && !loading && chartData.length > 0 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {seriesKeys.map((key, i) => (
            <li key={key} className="flex items-center gap-1.5">
              <span
                className="h-2.5 w-2.5 rounded-sm"
                style={{ backgroundColor: colorForIndex(i, key) }}
              />
              <span className="text-muted-foreground">{labelForKey(key)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
