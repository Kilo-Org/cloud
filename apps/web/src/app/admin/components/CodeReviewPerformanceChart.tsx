'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { format, parseISO } from 'date-fns';

type PerformanceRow = {
  day: string;
  avgSeconds: number;
  p50Seconds: number;
  p90Seconds: number;
  count: number;
};

type ChartDataPoint = PerformanceRow & {
  label: string;
};

type TooltipPayload = {
  payload: ChartDataPoint;
  dataKey: string;
  value: number;
  name: string;
  color: string;
};

type CustomTooltipProps = {
  active?: boolean;
  payload?: TooltipPayload[];
  label?: string;
};

function formatSeconds(seconds: number | undefined): string {
  if (seconds == null || seconds === 0) return '-';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds - m * 60);
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  return `${(seconds / 3600).toFixed(1)}h`;
}

export function CodeReviewPerformanceChart({
  data,
  retryAccountingMode = 'final_outcome',
}: {
  data: PerformanceRow[];
  retryAccountingMode?: 'final_outcome' | 'all_attempts';
}) {
  const chartData = data
    .map(row => ({
      ...row,
      label: format(parseISO(row.day), 'MM/dd'),
    }))
    .sort((a, b) => a.day.localeCompare(b.day));

  const CustomTooltip = ({ active, payload, label }: CustomTooltipProps) => {
    if (!active || !payload || payload.length === 0) return null;
    const d = payload[0]?.payload;
    if (!d) return null;

    return (
      <div className="bg-background rounded-lg border p-3 shadow-sm">
        <p className="text-sm font-medium">{label}</p>
        <div className="mt-2 space-y-1 text-xs">
          <p>
            <span className="text-muted-foreground">Avg:</span> {formatSeconds(d.avgSeconds)}
            {' / '}
            <span className="text-muted-foreground">P50:</span> {formatSeconds(d.p50Seconds)}
            {' / '}
            <span className="text-muted-foreground">P90:</span> {formatSeconds(d.p90Seconds)}
          </p>
          <p className="text-muted-foreground">Count: {d.count.toLocaleString()}</p>
        </div>
      </div>
    );
  };

  const unitLabel = retryAccountingMode === 'all_attempts' ? 'attempts' : 'reviews';

  if (chartData.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Execution Time Trend</CardTitle>
          <CardDescription>No completed {unitLabel} in selected period</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Execution Time Trend</CardTitle>
        <CardDescription>
          Daily avg / p50 / p90 execution time for completed {unitLabel}, excluding queue wait
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-[350px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 60 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis
                dataKey="label"
                angle={-45}
                textAnchor="end"
                height={80}
                tick={{ fontSize: 10 }}
              />
              <YAxis
                tick={{ fontSize: 10 }}
                tickFormatter={v => formatSeconds(v)}
                label={{
                  value: 'Execution Time',
                  angle: -90,
                  position: 'insideLeft',
                  style: { fontSize: 12 },
                }}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend />

              <Line
                type="monotone"
                dataKey="p90Seconds"
                stroke="#facc15"
                strokeWidth={1}
                strokeDasharray="4 2"
                dot={false}
                name="P90"
              />
              <Line
                type="monotone"
                dataKey="avgSeconds"
                stroke="#10b981"
                strokeWidth={2}
                dot={{ r: 2 }}
                name="Avg"
              />
              <Line
                type="monotone"
                dataKey="p50Seconds"
                stroke="#60a5fa"
                strokeWidth={1}
                strokeDasharray="4 2"
                dot={false}
                name="P50"
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
