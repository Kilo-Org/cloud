'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { format, parseISO, addHours } from 'date-fns';

type HourlyData = {
  hour: string;
  abuseCostMicrodollars: number;
  nonAbuseCostMicrodollars: number;
  totalCostMicrodollars: number;
  abusePercentage: number;
};

type ApiResponse = {
  data: HourlyData[];
  summary: {
    totalAbuseCost: number;
    totalNonAbuseCost: number;
    overallAbusePercentage: number;
  };
};

type AbuseHourlyChartProps = {
  onBarClick?: (endTime: string) => void;
};

export function AbuseHourlyChart({ onBarClick }: AbuseHourlyChartProps) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-abuse-hourly-stats'],
    queryFn: async () => {
      const response = await fetch('/admin/api/abuse/hourly-stats');

      if (!response.ok) {
        throw new Error('Failed to fetch hourly abuse statistics');
      }

      return (await response.json()) as ApiResponse;
    },
    refetchInterval: 3600000, // Refresh every hour
  });

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Error</CardTitle>
          <CardDescription>Failed to load hourly abuse statistics</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            {error instanceof Error ? error.message : 'An error occurred'}
          </p>
        </CardContent>
      </Card>
    );
  }

  if (isLoading || !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Loading...</CardTitle>
          <CardDescription>Fetching hourly abuse statistics</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const formatMicrodollars = (microdollars: number) => {
    return `$${(microdollars / 1000000).toFixed(2)}`;
  };

  // Transform data for the chart
  type ChartDataPoint = {
    hour: string;
    nonAbuseCost: number;
    abuseCost: number;
    abusePercentage: number;
    originalHour: string;
  };

  const chartData: ChartDataPoint[] = data.data.map(item => ({
    hour: format(parseISO(item.hour), 'MM/dd HH:00'),
    nonAbuseCost: item.nonAbuseCostMicrodollars / 1000000,
    abuseCost: item.abuseCostMicrodollars / 1000000,
    abusePercentage: item.abusePercentage,
    originalHour: item.hour, // Keep the original hour for click handling
  }));

  // Custom tooltip
  type TooltipPayload = {
    dataKey: string;
    value: number;
  };

  type CustomTooltipProps = {
    active?: boolean;
    payload?: TooltipPayload[];
    label?: string;
  };

  const CustomTooltip = ({ active, payload, label }: CustomTooltipProps) => {
    if (active && payload && payload.length) {
      const nonAbuseCost = payload.find(p => p.dataKey === 'nonAbuseCost')?.value || 0;
      const abuseCost = payload.find(p => p.dataKey === 'abuseCost')?.value || 0;
      const abusePercentage = payload.find(p => p.dataKey === 'abusePercentage')?.value || 0;

      return (
        <div className="bg-background rounded-lg border p-3 shadow-sm">
          <p className="text-sm font-medium">{label}</p>
          <div className="mt-2 space-y-1">
            <p className="text-sm">
              <span className="text-muted-foreground">Non-Abuse Cost:</span>{' '}
              <span className="font-medium">${nonAbuseCost.toFixed(2)}</span>
            </p>
            <p className="text-sm">
              <span className="text-muted-foreground">Abuse Cost:</span>{' '}
              <span className="font-medium">${abuseCost.toFixed(2)}</span>
            </p>
            <p className="text-sm">
              <span className="text-muted-foreground">Abuse Percentage:</span>{' '}
              <span className="font-medium">{abusePercentage.toFixed(2)}%</span>
            </p>
          </div>
        </div>
      );
    }
    return null;
  };

  // Custom legend content
  const renderLegend = () => {
    return (
      <div className="mt-4 flex flex-wrap items-center justify-center gap-6 text-sm">
        <div className="flex items-center gap-2">
          <div className="h-3 w-3 bg-green-600" />
          <span className="text-muted-foreground">Non-Abuse Cost USD</span>
          <span className="font-medium">{formatMicrodollars(data.summary.totalNonAbuseCost)}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="h-3 w-3 bg-red-600" />
          <span className="text-muted-foreground">Abuse Cost USD</span>
          <span className="font-medium">{formatMicrodollars(data.summary.totalAbuseCost)}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="h-3 w-3 bg-blue-600" />
          <span className="text-muted-foreground">Abuse Percentage</span>
          <span className="font-medium">{data.summary.overallAbusePercentage.toFixed(2)}%</span>
        </div>
      </div>
    );
  };

  // Handle bar click - calculate end of hour and convert to datetime-local format
  const handleBarClick = (data: unknown, index: number) => {
    if (!onBarClick || index >= chartData.length) return;

    const clickedDataPoint = chartData[index];
    if (!clickedDataPoint?.originalHour) return;

    // Parse the hour and add 1 hour to get the end of the period
    const hourStart = parseISO(clickedDataPoint.originalHour);
    const hourEnd = addHours(hourStart, 1);

    // Format for datetime-local input (YYYY-MM-DDTHH:MM)
    const endTime = format(hourEnd, "yyyy-MM-dd'T'HH:mm");
    onBarClick(endTime);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Abuse Cost - Last 12 Hours</CardTitle>
        <CardDescription>
          Hourly breakdown of abuse vs non-abuse costs with percentage trend
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-[400px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 60 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis
                dataKey="hour"
                angle={-45}
                textAnchor="end"
                height={100}
                className="text-xs"
                tick={{ fontSize: 10 }}
              />
              <YAxis
                yAxisId="left"
                orientation="left"
                className="text-xs"
                tick={{ fontSize: 10 }}
                label={{
                  value: 'Cost (USD)',
                  angle: -90,
                  position: 'insideLeft',
                  style: { fontSize: 12 },
                }}
                domain={[0, 'dataMax']}
                tickFormatter={value => `$${value.toFixed(0)}`}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                className="text-xs"
                tick={{ fontSize: 10 }}
                label={{
                  value: 'Abuse Percentage (%)',
                  angle: 90,
                  position: 'insideRight',
                  style: { fontSize: 12 },
                }}
                domain={[0, 16]}
                tickFormatter={value => `${value}`}
              />
              <Tooltip content={<CustomTooltip />} />
              <Bar
                yAxisId="left"
                dataKey="nonAbuseCost"
                stackId="cost"
                fill="#16a34a"
                name="Non-Abuse Cost"
                onClick={handleBarClick}
                style={{ cursor: onBarClick ? 'pointer' : 'default' }}
              />
              <Bar
                yAxisId="left"
                dataKey="abuseCost"
                stackId="cost"
                fill="#dc2626"
                name="Abuse Cost"
                onClick={handleBarClick}
                style={{ cursor: onBarClick ? 'pointer' : 'default' }}
              />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="abusePercentage"
                stroke="#2563eb"
                strokeWidth={2}
                dot={false}
                name="Abuse Percentage"
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        {renderLegend()}
      </CardContent>
    </Card>
  );
}
