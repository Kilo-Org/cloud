'use client';
import { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
} from 'recharts';
import {
  TrendingUp,
  TrendingDown,
  Minus,
  Zap,
  Layers,
  Users,
  BarChart3,
  Users2,
  Target,
  Info,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { BackgroundChart } from '../BackgroundChart';
import { AIAdoptionDistribution } from './AIAdoptionDistribution';
import { MetricDetailDrawer } from './MetricDetailDrawer';
import { AIAdoptionEmptyState } from './AIAdoptionEmptyState';
import type { OrganizationAIAdoptionProps } from '@/app/api/organizations/hooks';

// Colors for the three series
const SERIES_COLORS = {
  frequency: '#3b82f6', // blue
  depth: '#10b981', // green
  coverage: '#f59e0b', // amber
};

export interface AIAdoptionChartProps {
  adoption: OrganizationAIAdoptionProps;
  organizationId: string;
}

export function AIAdoptionChart({
  adoption: { timeseries, weeklyTrends, userScores, isNewOrganization, isLoading },
  organizationId,
}: AIAdoptionChartProps) {
  const [activeTab, setActiveTab] = useState<'timeline' | 'distribution'>('timeline');
  const [hoveredMetric, setHoveredMetric] = useState<'frequency' | 'depth' | 'coverage' | null>(
    null
  );
  const [drawerMetric, setDrawerMetric] = useState<'frequency' | 'depth' | 'coverage' | null>(null);

  // Process data for the chart
  const chartData = useMemo(() => {
    if (!timeseries || timeseries.length === 0) return [];

    return timeseries.map(point => ({
      date: new Date(point.datetime).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      }),
      timestamp: new Date(point.datetime).getTime(),
      Frequency: Math.round(point.frequency),
      Depth: Math.round(point.depth),
      Coverage: Math.round(point.coverage),
      total: Math.round(point.frequency + point.depth + point.coverage),
    }));
  }, [timeseries]);

  // Calculate current total score
  const currentScore = useMemo(() => {
    if (!chartData || chartData.length === 0) return 0;
    const latest = chartData[chartData.length - 1];
    return latest?.total || 0;
  }, [chartData]);

  // Prepare sparkline data for weekly trends
  const sparklineData = useMemo(() => {
    if (!chartData || chartData.length < 7) {
      return {
        frequency: [[], []] as [number[], number[]],
        depth: [[], []] as [number[], number[]],
        coverage: [[], []] as [number[], number[]],
      };
    }

    const last7Days = chartData.slice(-7);

    return {
      frequency: [last7Days.map(d => d.timestamp), last7Days.map(d => d.Frequency)] as [
        number[],
        number[],
      ],
      depth: [last7Days.map(d => d.timestamp), last7Days.map(d => d.Depth)] as [number[], number[]],
      coverage: [last7Days.map(d => d.timestamp), last7Days.map(d => d.Coverage)] as [
        number[],
        number[],
      ],
    };
  }, [chartData]);

  // Custom tooltip
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const CustomTooltip = ({ active, payload }: any) => {
    if (!active || !payload || !payload.length) return null;

    const dataPoint = payload[0]?.payload;
    const total = dataPoint?.total || 0;

    return (
      <div
        className="rounded-lg border border-gray-700 p-3 shadow-lg backdrop-blur-sm"
        style={{
          backgroundColor: 'rgba(17, 24, 39, 0.95)',
          backdropFilter: 'blur(8px)',
        }}
      >
        <p className="mb-2 text-xs font-medium text-gray-400">{dataPoint?.date}</p>
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <div
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: SERIES_COLORS.coverage }}
              />
              <span className="text-sm text-gray-100">Coverage:</span>
            </div>
            <span className="text-sm font-medium text-gray-100">{dataPoint?.Coverage}</span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <div
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: SERIES_COLORS.depth }}
              />
              <span className="text-sm text-gray-100">Depth:</span>
            </div>
            <span className="text-sm font-medium text-gray-100">{dataPoint?.Depth}</span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <div
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: SERIES_COLORS.frequency }}
              />
              <span className="text-sm text-gray-100">Frequency:</span>
            </div>
            <span className="text-sm font-medium text-gray-100">{dataPoint?.Frequency}</span>
          </div>
          <div className="mt-2 border-t border-gray-700 pt-2">
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm font-medium text-gray-100">Total Score:</span>
              <span className="text-sm font-bold text-gray-100">{total}%</span>
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <Card className="w-full">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div
              className="flex h-10 w-10 items-center justify-center rounded-lg"
              style={{ backgroundColor: '#8b5cf620' }}
            >
              <TrendingUp className="h-5 w-5 text-purple-400" />
            </div>
            <div>
              <CardTitle className="text-lg font-bold">AI Adoption Score</CardTitle>
              <p className="text-muted-foreground text-xs">
                Track your organization's AI integration progress
              </p>
            </div>
          </div>
          {!isLoading && (
            <div className="flex items-center gap-4">
              <Select
                value={activeTab}
                onValueChange={value => setActiveTab(value as 'timeline' | 'distribution')}
              >
                <SelectTrigger className="w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="timeline">
                    <div className="flex items-center gap-2">
                      <BarChart3 className="h-4 w-4" />
                      Timeline
                    </div>
                  </SelectItem>
                  <SelectItem value="distribution">
                    <div className="flex items-center gap-2">
                      <Users2 className="h-4 w-4" />
                      Distribution
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
              <div className="flex flex-col gap-1">
                <div className="flex w-32 items-center justify-between">
                  <span className="text-muted-foreground text-xs">Current</span>
                  <span className="text-sm font-medium text-gray-300">{currentScore}%</span>
                </div>
                <div className="relative h-2 w-32 overflow-hidden rounded-full bg-gray-800">
                  <div
                    className="h-full bg-gradient-to-r from-blue-600 via-blue-500 to-green-500 transition-all duration-500 ease-out"
                    style={{
                      width: `${currentScore}%`,
                    }}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {isNewOrganization ? (
          <AIAdoptionEmptyState />
        ) : activeTab === 'timeline' ? (
          <>
            <div className="relative h-[180px] w-full">
              {isLoading ? (
                <Skeleton className="h-full w-full" />
              ) : chartData.length === 0 ? (
                <div className="flex h-full items-center justify-center">
                  <p className="text-muted-foreground text-sm">No data available</p>
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%" className="pt-4">
                  <BarChart data={chartData} margin={{ top: 5, right: 0, bottom: 5, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                    <XAxis
                      dataKey="date"
                      stroke="#a1a1a1"
                      tick={{ fontSize: 10 }}
                      interval="preserveStartEnd"
                      minTickGap={50}
                    />
                    <YAxis
                      stroke="#a1a1a1"
                      tick={{ fontSize: 10 }}
                      width={35}
                      domain={[0, 100]}
                      ticks={[0, 25, 50, 75, 100]}
                    />
                    <RechartsTooltip
                      content={<CustomTooltip />}
                      cursor={{ fill: 'rgba(255, 255, 255, 0.05)' }}
                    />
                    <Bar
                      dataKey="Frequency"
                      stackId="a"
                      fill={SERIES_COLORS.frequency}
                      fillOpacity={
                        hoveredMetric === null || hoveredMetric === 'frequency' ? 1 : 0.5
                      }
                      radius={[0, 0, 0, 0]}
                      isAnimationActive={false}
                      style={{ transition: 'fill-opacity 200ms ease-in-out' }}
                    />
                    <Bar
                      dataKey="Depth"
                      stackId="a"
                      fill={SERIES_COLORS.depth}
                      fillOpacity={hoveredMetric === null || hoveredMetric === 'depth' ? 1 : 0.5}
                      radius={[0, 0, 0, 0]}
                      isAnimationActive={false}
                      style={{ transition: 'fill-opacity 200ms ease-in-out' }}
                    />
                    <Bar
                      dataKey="Coverage"
                      stackId="a"
                      fill={SERIES_COLORS.coverage}
                      fillOpacity={hoveredMetric === null || hoveredMetric === 'coverage' ? 1 : 0.5}
                      radius={[4, 4, 0, 0]}
                      isAnimationActive={false}
                      style={{ transition: 'fill-opacity 200ms ease-in-out' }}
                    />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
            {/* Weekly Trend Blocks */}
            {isLoading ? (
              <div className="grid grid-cols-4 gap-4 pt-4">
                {[...Array(4)].map((_, i) => (
                  <div key={i} className="rounded-lg border border-gray-800 bg-gray-900/50 p-4">
                    <Skeleton className="h-16 w-full" />
                  </div>
                ))}
              </div>
            ) : weeklyTrends && chartData.length >= 7 ? (
              <div className="grid grid-cols-4 gap-4 pt-4">
                {/* Total Score Trend */}
                <div className="relative overflow-hidden rounded-lg border border-gray-800 bg-gray-900/50 p-4">
                  <div className="pointer-events-none">
                    <BackgroundChart
                      data={[
                        chartData.slice(-7).map(d => d.timestamp),
                        chartData.slice(-7).map(d => d.total),
                      ]}
                      color="#9ca3af"
                      className="opacity-40"
                    />
                  </div>
                  <div className="relative z-[1] flex flex-col gap-1">
                    <div className="flex items-center gap-1.5">
                      <Target className="h-3.5 w-3.5" />
                      <span className="text-sm font-medium tracking-tight whitespace-nowrap">
                        Total
                      </span>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Info className="h-3 w-3 cursor-help text-gray-500 hover:text-gray-400" />
                        </TooltipTrigger>
                        <TooltipContent side="top">
                          Combined score of frequency, depth, and coverage metrics.
                        </TooltipContent>
                      </Tooltip>
                    </div>
                    <div
                      className={cn(
                        'flex items-center gap-1.5 text-xl font-bold',
                        weeklyTrends.total.trend === 'up' && 'text-green-500',
                        weeklyTrends.total.trend === 'down' && 'text-red-500',
                        weeklyTrends.total.trend === 'neutral' && 'text-gray-400'
                      )}
                    >
                      {weeklyTrends.total.trend === 'up' && <TrendingUp className="h-5 w-5" />}
                      {weeklyTrends.total.trend === 'down' && <TrendingDown className="h-5 w-5" />}
                      {weeklyTrends.total.trend === 'neutral' && <Minus className="h-5 w-5" />}
                      {weeklyTrends.total.change >= 0 ? '+' : ''}
                      {weeklyTrends.total.change.toFixed(1)}%
                    </div>
                  </div>
                </div>

                {/* Frequency Trend */}
                <div
                  className="relative cursor-pointer overflow-hidden rounded-lg border border-gray-800 bg-gray-900/50 p-4 transition-all hover:border-gray-700 hover:bg-gray-900/70 hover:shadow-md"
                  onMouseEnter={() => setHoveredMetric('frequency')}
                  onMouseLeave={() => setHoveredMetric(null)}
                  onClick={() => setDrawerMetric('frequency')}
                >
                  <div className="pointer-events-none">
                    <BackgroundChart
                      data={sparklineData.frequency}
                      color="#9ca3af"
                      className="opacity-40"
                    />
                  </div>
                  <div className="relative z-[1] flex flex-col gap-1">
                    <div className="flex items-center gap-1.5">
                      <Zap className="h-3.5 w-3.5" />
                      <span className="text-sm font-medium tracking-tight whitespace-nowrap">
                        Frequency
                      </span>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Info className="h-3 w-3 cursor-help text-gray-500 hover:text-gray-400" />
                        </TooltipTrigger>
                        <TooltipContent side="top">
                          How often team members use AI tools in their workflow.
                        </TooltipContent>
                      </Tooltip>
                    </div>
                    <div
                      className={cn(
                        'flex items-center gap-1.5 text-xl font-bold',
                        weeklyTrends.frequency.trend === 'up' && 'text-green-500',
                        weeklyTrends.frequency.trend === 'down' && 'text-red-500',
                        weeklyTrends.frequency.trend === 'neutral' && 'text-gray-400'
                      )}
                    >
                      {weeklyTrends.frequency.trend === 'up' && <TrendingUp className="h-5 w-5" />}
                      {weeklyTrends.frequency.trend === 'down' && (
                        <TrendingDown className="h-5 w-5" />
                      )}
                      {weeklyTrends.frequency.trend === 'neutral' && <Minus className="h-5 w-5" />}
                      {weeklyTrends.frequency.change >= 0 ? '+' : ''}
                      {weeklyTrends.frequency.change.toFixed(1)}%
                    </div>
                  </div>
                </div>

                {/* Depth Trend */}
                <div
                  className="relative cursor-pointer overflow-hidden rounded-lg border border-gray-800 bg-gray-900/50 p-4 transition-all hover:border-gray-700 hover:bg-gray-900/70 hover:shadow-md"
                  onMouseEnter={() => setHoveredMetric('depth')}
                  onMouseLeave={() => setHoveredMetric(null)}
                  onClick={() => setDrawerMetric('depth')}
                >
                  <div className="pointer-events-none">
                    <BackgroundChart
                      data={sparklineData.depth}
                      color="#9ca3af"
                      className="opacity-40"
                    />
                  </div>
                  <div className="relative z-[1] flex flex-col gap-1">
                    <div className="flex items-center gap-1.5">
                      <Layers className="h-3.5 w-3.5" />
                      <span className="text-sm font-medium tracking-tight whitespace-nowrap">
                        Depth
                      </span>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Info className="h-3 w-3 cursor-help text-gray-500 hover:text-gray-400" />
                        </TooltipTrigger>
                        <TooltipContent side="top">
                          How extensively AI is integrated into each coding session.
                        </TooltipContent>
                      </Tooltip>
                    </div>
                    <div
                      className={cn(
                        'flex items-center gap-1.5 text-xl font-bold',
                        weeklyTrends.depth.trend === 'up' && 'text-green-500',
                        weeklyTrends.depth.trend === 'down' && 'text-red-500',
                        weeklyTrends.depth.trend === 'neutral' && 'text-gray-400'
                      )}
                    >
                      {weeklyTrends.depth.trend === 'up' && <TrendingUp className="h-5 w-5" />}
                      {weeklyTrends.depth.trend === 'down' && <TrendingDown className="h-5 w-5" />}
                      {weeklyTrends.depth.trend === 'neutral' && <Minus className="h-5 w-5" />}
                      {weeklyTrends.depth.change >= 0 ? '+' : ''}
                      {weeklyTrends.depth.change.toFixed(1)}%
                    </div>
                  </div>
                </div>

                {/* Coverage Trend */}
                <div
                  className="relative cursor-pointer overflow-hidden rounded-lg border border-gray-800 bg-gray-900/50 p-4 transition-all hover:border-gray-700 hover:bg-gray-900/70 hover:shadow-md"
                  onMouseEnter={() => setHoveredMetric('coverage')}
                  onMouseLeave={() => setHoveredMetric(null)}
                  onClick={() => setDrawerMetric('coverage')}
                >
                  <div className="pointer-events-none">
                    <BackgroundChart
                      data={sparklineData.coverage}
                      color="#9ca3af"
                      className="opacity-40"
                    />
                  </div>
                  <div className="relative z-[1] flex flex-col gap-1">
                    <div className="flex items-center gap-1.5">
                      <Users className="h-3.5 w-3.5" />
                      <span className="text-sm font-medium tracking-tight whitespace-nowrap">
                        Coverage
                      </span>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Info className="h-3 w-3 cursor-help text-gray-500 hover:text-gray-400" />
                        </TooltipTrigger>
                        <TooltipContent side="top">
                          Percentage of team members actively using AI tools.
                        </TooltipContent>
                      </Tooltip>
                    </div>
                    <div
                      className={cn(
                        'flex items-center gap-1.5 text-xl font-bold',
                        weeklyTrends.coverage.trend === 'up' && 'text-green-500',
                        weeklyTrends.coverage.trend === 'down' && 'text-red-500',
                        weeklyTrends.coverage.trend === 'neutral' && 'text-gray-400'
                      )}
                    >
                      {weeklyTrends.coverage.trend === 'up' && <TrendingUp className="h-5 w-5" />}
                      {weeklyTrends.coverage.trend === 'down' && (
                        <TrendingDown className="h-5 w-5" />
                      )}
                      {weeklyTrends.coverage.trend === 'neutral' && <Minus className="h-5 w-5" />}
                      {weeklyTrends.coverage.change >= 0 ? '+' : ''}
                      {weeklyTrends.coverage.change.toFixed(1)}%
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <AIAdoptionDistribution userScores={userScores || []} isLoading={isLoading} />
        )}
      </CardContent>

      {/* Metric Detail Drawer */}
      <MetricDetailDrawer
        open={drawerMetric !== null}
        onOpenChange={open => {
          if (!open) setDrawerMetric(null);
        }}
        metric={drawerMetric}
        organizationId={organizationId}
        chartData={chartData}
      />
    </Card>
  );
}
