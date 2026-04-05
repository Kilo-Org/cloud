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
import { format, parseISO, addDays } from 'date-fns';

type DailyData = {
  day: string;
  abuseCostMicrodollars: number;
  nonAbuseCostMicrodollars: number;
  totalCostMicrodollars: number;
  abusePercentage: number;
};

type ApiResponse = {
  data: DailyData[];
  summary: {
    totalAbuseCost: number;
    totalNonAbuseCost: number;
    overallAbusePercentage: number;
  };
};

type AbuseDailyChartProps = {
  onBarClick: (endTime: string) => void;
};

export function AbuseDailyChart({ onBarClick }: AbuseDailyChartProps) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-abuse-daily-stats'],
    queryFn: async () => {
      const response = await fetch('/admin/api/abuse/daily-stats');

      if (!response.ok) {
        throw new Error('Failed to fetch daily abuse statistics');
      }

      return (await response.json()) as ApiResponse;
    },
    refetchInterval: 86400000, // Refresh every day
  });

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Error</CardTitle>
          <CardDescription>Failed to load daily abuse statistics</CardDescription>
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
          <CardDescription>Fetching daily abuse statistics</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const formatMicrodollars = (microdollars: number) => {
    return `$${(microdollars / 1000000).toFixed(2)}`;
  };

  // Transform data for the chart
  type ChartDataPoint = {
    day: string;
    nonAbuseCost: number;
    abuseCost: number;
    abusePercentage: number;
    originalDay: string;
  };

  const chartData: ChartDataPoint[] = data.data.map(item => ({
    day: format(parseISO(item.day), 'MM/dd'),
    nonAbuseCost: item.nonAbuseCostMicrodollars / 1000000,
    abuseCost: item.abuseCostMicrodollars / 1000000,
    abusePercentage: item.abusePercentage,
    originalDay: item.day, // Keep the original day for click handling
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
      const totalCost = nonAbuseCost + abuseCost;

      return (
        <div className="bg-background rounded-lg border p-3 shadow-sm">
          <p className="text-sm font-medium">{label}</p>
          <div className="mt-2 space-y-1">
            <p className="text-sm">
              <span className="text-muted-foreground">Total Cost:</span>{' '}
              <span className="font-medium">${totalCost.toFixed(2)}</span>
            </p>
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
    const totalCost = data.summary.totalAbuseCost + data.summary.totalNonAbuseCost;
    const avgDailyCost = totalCost / data.data.length;
    const avgDailyAbuseCost = data.summary.totalAbuseCost / data.data.length;

    return (
      <div className="mt-4 space-y-2">
        <div className="flex flex-wrap items-center justify-center gap-6 text-sm">
          <div className="flex items-center gap-2">
            <div className="h-3 w-3 bg-green-600" />
            <span className="text-muted-foreground">Non-Abuse Cost (7d)</span>
            <span className="font-medium">
              {formatMicrodollars(data.summary.totalNonAbuseCost)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="h-3 w-3 bg-red-600" />
            <span className="text-muted-foreground">Abuse Cost (7d)</span>
            <span className="font-medium">{formatMicrodollars(data.summary.totalAbuseCost)}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="h-3 w-3 bg-blue-600" />
            <span className="text-muted-foreground">Abuse Percentage (7d)</span>
            <span className="font-medium">{data.summary.overallAbusePercentage.toFixed(2)}%</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-6 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Avg Daily Cost:</span>
            <span className="font-medium">{formatMicrodollars(avgDailyCost)}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Avg Daily Abuse Cost:</span>
            <span className="font-medium">{formatMicrodollars(avgDailyAbuseCost)}</span>
          </div>
        </div>
      </div>
    );
  };

  // Calculate dynamic Y-axis domain for better visualization
  const maxCost = Math.max(...chartData.map(d => d.nonAbuseCost + d.abuseCost));
  const maxPercentage = Math.max(...chartData.map(d => d.abusePercentage));
  const yAxisMaxCost = Math.ceil(maxCost * 1.1); // Add 10% padding
  const yAxisMaxPercentage = Math.min(Math.ceil(maxPercentage * 1.2), 100); // Add 20% padding, cap at 100%

  // Handle bar click - calculate end of day and convert to datetime-local format
  const handleBarClick = (data: unknown, index: number) => {
    if (index >= chartData.length) return;

    const clickedDataPoint = chartData[index];
    if (!clickedDataPoint?.originalDay) return;

    // Parse the day and add 1 day to get the end of the period
    const dayStart = parseISO(clickedDataPoint.originalDay);
    const dayEnd = addDays(dayStart, 1);

    // Format for datetime-local input (YYYY-MM-DDTHH:MM)
    const endTime = format(dayEnd, "yyyy-MM-dd'T'HH:mm");
    onBarClick(endTime);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Abuse Cost - Last 7 Days</CardTitle>
        <CardDescription>
          Daily breakdown of abuse vs non-abuse costs with percentage trend
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-[400px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 60 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis
                dataKey="day"
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
                domain={[0, yAxisMaxCost]}
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
                domain={[0, yAxisMaxPercentage]}
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
                className="cursor-pointer"
              />
              <Bar
                yAxisId="left"
                dataKey="abuseCost"
                stackId="cost"
                fill="#dc2626"
                name="Abuse Cost"
                onClick={handleBarClick}
                className="cursor-pointer"
              />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="abusePercentage"
                stroke="#2563eb"
                strokeWidth={2}
                dot={{ r: 2 }}
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
