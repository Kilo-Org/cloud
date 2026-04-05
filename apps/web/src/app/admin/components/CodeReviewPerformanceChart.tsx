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
  agentVersion: string;
  avgSeconds: number;
  p50Seconds: number;
  p90Seconds: number;
  count: number;
};

type PivotedDataPoint = {
  day: string;
  v1Avg?: number;
  v1P50?: number;
  v1P90?: number;
  v2Avg?: number;
  v2P50?: number;
  v2P90?: number;
};

type TooltipPayload = {
  payload: PivotedDataPoint;
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

/**
 * Pivot interleaved rows [{day, agentVersion, ...}] into one row per day
 * with v1/v2 columns for recharts.
 */
function pivotByDay(rows: PerformanceRow[]): PivotedDataPoint[] {
  const map = new Map<string, PivotedDataPoint>();
  for (const row of rows) {
    const existing = map.get(row.day) ?? { day: row.day };
    if (row.agentVersion === 'v1') {
      existing.v1Avg = row.avgSeconds;
      existing.v1P50 = row.p50Seconds;
      existing.v1P90 = row.p90Seconds;
    } else if (row.agentVersion === 'v2') {
      existing.v2Avg = row.avgSeconds;
      existing.v2P50 = row.p50Seconds;
      existing.v2P90 = row.p90Seconds;
    }
    map.set(row.day, existing);
  }
  return Array.from(map.values()).sort((a, b) => a.day.localeCompare(b.day));
}

export function CodeReviewPerformanceChart({
  data,
  agentVersion,
}: {
  data: PerformanceRow[];
  agentVersion: 'all' | 'v1' | 'v2';
}) {
  const chartData = pivotByDay(data).map(row => ({
    ...row,
    day: format(parseISO(row.day), 'MM/dd'),
  }));

  const showV1 = agentVersion === 'all' || agentVersion === 'v1';
  const showV2 = agentVersion === 'all' || agentVersion === 'v2';

  const CustomTooltip = ({ active, payload, label }: CustomTooltipProps) => {
    if (!active || !payload || payload.length === 0) return null;
    const d = payload[0]?.payload;
    if (!d) return null;

    return (
      <div className="bg-background rounded-lg border p-3 shadow-sm">
        <p className="text-sm font-medium">{label}</p>
        <div className="mt-2 space-y-1">
          {showV1 && d.v1Avg != null && (
            <>
              <p className="text-xs font-medium text-blue-600">V1</p>
              <p className="text-xs">
                <span className="text-muted-foreground">Avg:</span> {formatSeconds(d.v1Avg)}
                {' / '}
                <span className="text-muted-foreground">P50:</span> {formatSeconds(d.v1P50)}
                {' / '}
                <span className="text-muted-foreground">P90:</span> {formatSeconds(d.v1P90)}
              </p>
            </>
          )}
          {showV2 && d.v2Avg != null && (
            <>
              <p className="text-xs font-medium text-emerald-600">V2</p>
              <p className="text-xs">
                <span className="text-muted-foreground">Avg:</span> {formatSeconds(d.v2Avg)}
                {' / '}
                <span className="text-muted-foreground">P50:</span> {formatSeconds(d.v2P50)}
                {' / '}
                <span className="text-muted-foreground">P90:</span> {formatSeconds(d.v2P90)}
              </p>
            </>
          )}
        </div>
      </div>
    );
  };

  if (chartData.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Execution Time Trend</CardTitle>
          <CardDescription>No completed reviews in selected period</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Execution Time Trend</CardTitle>
        <CardDescription>
          Daily avg / p50 / p90 execution time (excludes queue wait)
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-[350px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 60 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis
                dataKey="day"
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

              {showV1 && (
                <>
                  <Line
                    type="monotone"
                    dataKey="v1P90"
                    stroke="#93c5fd"
                    strokeWidth={1}
                    strokeDasharray="4 2"
                    dot={false}
                    name="V1 P90"
                  />
                  <Line
                    type="monotone"
                    dataKey="v1Avg"
                    stroke="#3b82f6"
                    strokeWidth={2}
                    dot={{ r: 2 }}
                    name="V1 Avg"
                  />
                  <Line
                    type="monotone"
                    dataKey="v1P50"
                    stroke="#1d4ed8"
                    strokeWidth={1}
                    strokeDasharray="4 2"
                    dot={false}
                    name="V1 P50"
                  />
                </>
              )}

              {showV2 && (
                <>
                  <Line
                    type="monotone"
                    dataKey="v2P90"
                    stroke="#6ee7b7"
                    strokeWidth={1}
                    strokeDasharray="4 2"
                    dot={false}
                    name="V2 P90"
                  />
                  <Line
                    type="monotone"
                    dataKey="v2Avg"
                    stroke="#10b981"
                    strokeWidth={2}
                    dot={{ r: 2 }}
                    name="V2 Avg"
                  />
                  <Line
                    type="monotone"
                    dataKey="v2P50"
                    stroke="#047857"
                    strokeWidth={1}
                    strokeDasharray="4 2"
                    dot={false}
                    name="V2 P50"
                  />
                </>
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
