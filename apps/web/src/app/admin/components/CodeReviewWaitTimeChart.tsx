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

type WaitTimeRow = {
  day: string;
  ownershipType: string;
  avgSeconds: number;
  p50Seconds: number;
  p95Seconds: number;
  count: number;
};

type PivotedWaitTimePoint = {
  day: string;
  personalAvg?: number;
  personalP50?: number;
  personalP95?: number;
  personalCount?: number;
  organizationAvg?: number;
  organizationP50?: number;
  organizationP95?: number;
  organizationCount?: number;
  singleAvg?: number;
  singleP50?: number;
  singleP95?: number;
  singleCount?: number;
};

type TooltipPayload = {
  payload: PivotedWaitTimePoint;
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
  if (seconds == null) return '-';
  if (seconds < 1) return '0s';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.round(seconds - minutes * 60);
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
  return `${(seconds / 3600).toFixed(1)}h`;
}

function getOwnershipLabel(ownershipType: string | undefined): string {
  if (ownershipType === 'organization') return 'Organizations';
  if (ownershipType === 'personal') return 'Personal';
  return 'Filtered Reviews';
}

function pivotByDay(rows: WaitTimeRow[], splitByOwnership: boolean): PivotedWaitTimePoint[] {
  const map = new Map<string, PivotedWaitTimePoint>();

  for (const row of rows) {
    const existing = map.get(row.day) ?? { day: row.day };

    if (!splitByOwnership) {
      existing.singleAvg = row.avgSeconds;
      existing.singleP50 = row.p50Seconds;
      existing.singleP95 = row.p95Seconds;
      existing.singleCount = row.count;
    } else if (row.ownershipType === 'organization') {
      existing.organizationAvg = row.avgSeconds;
      existing.organizationP50 = row.p50Seconds;
      existing.organizationP95 = row.p95Seconds;
      existing.organizationCount = row.count;
    } else {
      existing.personalAvg = row.avgSeconds;
      existing.personalP50 = row.p50Seconds;
      existing.personalP95 = row.p95Seconds;
      existing.personalCount = row.count;
    }

    map.set(row.day, existing);
  }

  return Array.from(map.values()).sort((a, b) => a.day.localeCompare(b.day));
}

type TooltipSeries = {
  label: string;
  colorClassName: string;
  avg?: number;
  p50?: number;
  p95?: number;
  count?: number;
};

function TooltipSeriesDetails({ series }: { series: TooltipSeries }) {
  if (series.avg == null) return null;

  return (
    <div>
      <p className={`text-xs font-medium ${series.colorClassName}`}>{series.label}</p>
      <p className="text-xs">
        <span className="text-muted-foreground">Avg:</span> {formatSeconds(series.avg)}
        {' / '}
        <span className="text-muted-foreground">P50:</span> {formatSeconds(series.p50)}
        {' / '}
        <span className="text-muted-foreground">P95:</span> {formatSeconds(series.p95)}
      </p>
      {series.count != null && (
        <p className="text-muted-foreground text-xs">
          {series.count.toLocaleString()} started reviews
        </p>
      )}
    </div>
  );
}

export function CodeReviewWaitTimeChart({
  data,
  splitByOwnership,
  filteredSeriesLabel,
}: {
  data: WaitTimeRow[];
  splitByOwnership: boolean;
  filteredSeriesLabel?: string;
}) {
  const chartData = pivotByDay(data, splitByOwnership).map(row => ({
    ...row,
    day: format(parseISO(row.day), 'MM/dd'),
  }));

  const singleOwnershipType = data[0]?.ownershipType;
  const singleLabel = filteredSeriesLabel ?? getOwnershipLabel(singleOwnershipType);
  const singleColor = singleOwnershipType === 'organization' ? '#047857' : '#1d4ed8';
  const singleP95Color = singleOwnershipType === 'organization' ? '#6ee7b7' : '#93c5fd';
  const singleTextClass =
    singleOwnershipType === 'organization' ? 'text-emerald-600' : 'text-blue-600';
  const description = filteredSeriesLabel
    ? `Created to started; respects current filters (${filteredSeriesLabel})`
    : 'Created to started; respects current filters';

  const CustomTooltip = ({ active, payload, label }: CustomTooltipProps) => {
    if (!active || !payload || payload.length === 0) return null;
    const d = payload[0]?.payload;
    if (!d) return null;

    return (
      <div className="bg-background rounded-lg border p-3 shadow-sm">
        <p className="text-sm font-medium">{label}</p>
        <div className="mt-2 space-y-2">
          {splitByOwnership ? (
            <>
              <TooltipSeriesDetails
                series={{
                  label: 'Personal',
                  colorClassName: 'text-blue-600',
                  avg: d.personalAvg,
                  p50: d.personalP50,
                  p95: d.personalP95,
                  count: d.personalCount,
                }}
              />
              <TooltipSeriesDetails
                series={{
                  label: 'Organizations',
                  colorClassName: 'text-emerald-600',
                  avg: d.organizationAvg,
                  p50: d.organizationP50,
                  p95: d.organizationP95,
                  count: d.organizationCount,
                }}
              />
            </>
          ) : (
            <TooltipSeriesDetails
              series={{
                label: singleLabel,
                colorClassName: singleTextClass,
                avg: d.singleAvg,
                p50: d.singleP50,
                p95: d.singleP95,
                count: d.singleCount,
              }}
            />
          )}
        </div>
      </div>
    );
  };

  if (chartData.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Queue Wait Time Trend</CardTitle>
          <CardDescription>No started reviews in selected period</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Queue Wait Time Trend</CardTitle>
        <CardDescription>{description}</CardDescription>
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
                tickFormatter={value => formatSeconds(value)}
                label={{
                  value: 'Queue Wait',
                  angle: -90,
                  position: 'insideLeft',
                  style: { fontSize: 12 },
                }}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend />

              {splitByOwnership ? (
                <>
                  <Line
                    type="monotone"
                    dataKey="personalP95"
                    stroke="#93c5fd"
                    strokeWidth={1}
                    strokeDasharray="4 2"
                    dot={false}
                    name="Personal P95"
                  />
                  <Line
                    type="monotone"
                    dataKey="personalP50"
                    stroke="#1d4ed8"
                    strokeWidth={2}
                    dot={{ r: 2 }}
                    name="Personal P50"
                  />
                  <Line
                    type="monotone"
                    dataKey="organizationP95"
                    stroke="#6ee7b7"
                    strokeWidth={1}
                    strokeDasharray="4 2"
                    dot={false}
                    name="Organizations P95"
                  />
                  <Line
                    type="monotone"
                    dataKey="organizationP50"
                    stroke="#047857"
                    strokeWidth={2}
                    dot={{ r: 2 }}
                    name="Organizations P50"
                  />
                </>
              ) : (
                <>
                  <Line
                    type="monotone"
                    dataKey="singleP95"
                    stroke={singleP95Color}
                    strokeWidth={1}
                    strokeDasharray="4 2"
                    dot={false}
                    name={`${singleLabel} P95`}
                  />
                  <Line
                    type="monotone"
                    dataKey="singleP50"
                    stroke={singleColor}
                    strokeWidth={2}
                    dot={{ r: 2 }}
                    name={`${singleLabel} P50`}
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
