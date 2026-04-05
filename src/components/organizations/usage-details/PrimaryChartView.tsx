'use client';
import { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn, formatLargeNumber } from '@/lib/utils';
import {
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  Area,
  AreaChart,
} from 'recharts';

type Metric = {
  key: string;
  title: string;
  value: string | React.ReactNode;
  chartType: 'line' | 'bar';
  data: [number[], number[]];
  icon?: React.ComponentType<{ className?: string }>;
  color?: string;
  loading?: boolean;
};

type TimeseriesDataPoint = {
  datetime: string;
  name: string;
  email: string;
  model: string;
  provider: string;
  costMicrodollars: number;
  inputTokenCount: number;
  outputTokenCount: number;
  requestCount: number;
};

type Props = {
  selectedMetric: Metric | undefined;
  timeseriesData: TimeseriesDataPoint[];
  className?: string;
  chartSplitBy?: { provider: boolean; model: boolean; tokenType: boolean };
  onChartSplitByChange?: (value: { provider: boolean; model: boolean; tokenType: boolean }) => void;
};

// Color palette for different series
const COLORS = [
  '#3b82f6', // blue
  '#ef4444', // red
  '#10b981', // green
  '#f59e0b', // amber
  '#8b5cf6', // purple
  '#ec4899', // pink
  '#14b8a6', // teal
  '#f97316', // orange
  '#6366f1', // indigo
  '#84cc16', // lime
];

export function PrimaryChartView({
  selectedMetric,
  timeseriesData,
  className,
  chartSplitBy = { provider: false, model: false, tokenType: false },
  onChartSplitByChange,
}: Props) {
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(new Set());

  // Process timeseries data into chart format
  const { chartData, seriesKeys } = useMemo(() => {
    if (!selectedMetric || !timeseriesData.length) {
      return { chartData: [], seriesKeys: [] };
    }

    const isSplit = chartSplitBy.provider || chartSplitBy.model || chartSplitBy.tokenType;

    if (!isSplit) {
      // Aggregated view - convert the metric data to recharts format
      const [timestamps, values] = selectedMetric.data;
      const data = timestamps.map((ts, i) => ({
        timestamp: ts,
        date: new Date(ts * 1000).toLocaleDateString(),
        total: values[i] || 0,
      }));
      return { chartData: data, seriesKeys: ['total'] };
    }

    // Split view - group by provider/model/both
    // Round timestamps to nearest hour to aggregate data points
    const timeGroups = new Map<number, Map<string, number>>();
    // For active_users metric, track unique emails per series per timestamp
    const userTracking = new Map<number, Map<string, Set<string>>>();
    // Track all timestamps and series keys to ensure complete data coverage
    const allTimestamps = new Set<number>();
    const allSeriesKeys = new Set<string>();

    timeseriesData.forEach(point => {
      // Round to nearest hour for consistent grouping
      const timestamp = Math.floor(new Date(point.datetime).getTime() / 1000 / 3600) * 3600;
      allTimestamps.add(timestamp);

      // Determine series key for this point
      let seriesKey = '';
      if (selectedMetric.key === 'tokens' && chartSplitBy.tokenType) {
        // For token type splitting, we'll handle series keys later
      } else {
        if (chartSplitBy.provider && chartSplitBy.model) {
          seriesKey = `${point.provider} - ${point.model}`;
        } else if (chartSplitBy.provider) {
          seriesKey = point.provider;
        } else if (chartSplitBy.model) {
          seriesKey = point.model;
        }
        if (seriesKey) allSeriesKeys.add(seriesKey);
      }

      // Only process points where user made at least 1 request for active_users
      if (selectedMetric.key === 'users' && point.requestCount === 0) {
        return;
      }

      // For token type split, we need to create separate entries for input and output
      if (selectedMetric.key === 'tokens' && chartSplitBy.tokenType) {
        // Process input tokens
        let inputSeriesKey = 'Input';
        if (chartSplitBy.provider && chartSplitBy.model) {
          inputSeriesKey = `${point.provider} - ${point.model} - Input`;
        } else if (chartSplitBy.provider) {
          inputSeriesKey = `${point.provider} - Input`;
        } else if (chartSplitBy.model) {
          inputSeriesKey = `${point.model} - Input`;
        }

        if (!timeGroups.has(timestamp)) {
          timeGroups.set(timestamp, new Map());
        }
        let seriesMap = timeGroups.get(timestamp);
        if (seriesMap) {
          seriesMap.set(
            inputSeriesKey,
            (seriesMap.get(inputSeriesKey) || 0) + point.inputTokenCount
          );
        }

        // Process output tokens
        let outputSeriesKey = 'Output';
        if (chartSplitBy.provider && chartSplitBy.model) {
          outputSeriesKey = `${point.provider} - ${point.model} - Output`;
        } else if (chartSplitBy.provider) {
          outputSeriesKey = `${point.provider} - Output`;
        } else if (chartSplitBy.model) {
          outputSeriesKey = `${point.model} - Output`;
        }

        seriesMap = timeGroups.get(timestamp);
        if (seriesMap) {
          seriesMap.set(
            outputSeriesKey,
            (seriesMap.get(outputSeriesKey) || 0) + point.outputTokenCount
          );
        }
      } else {
        // Create series key based on split settings
        let seriesKey = '';
        if (chartSplitBy.provider && chartSplitBy.model) {
          seriesKey = `${point.provider} - ${point.model}`;
        } else if (chartSplitBy.provider) {
          seriesKey = point.provider;
        } else if (chartSplitBy.model) {
          seriesKey = point.model;
        }

        // For active_users, track unique emails per series
        if (selectedMetric.key === 'users') {
          if (!userTracking.has(timestamp)) {
            userTracking.set(timestamp, new Map());
          }
          const seriesEmailsMap = userTracking.get(timestamp);
          if (seriesEmailsMap) {
            if (!seriesEmailsMap.has(seriesKey)) {
              seriesEmailsMap.set(seriesKey, new Set());
            }
            seriesEmailsMap.get(seriesKey)?.add(point.email);
          }
        } else {
          // Get metric value for non-user metrics
          let value = 0;
          switch (selectedMetric.key) {
            case 'cost':
            case 'avgCost':
              value = point.costMicrodollars;
              break;
            case 'requests':
              value = point.requestCount;
              break;
            case 'tokens':
              value = point.inputTokenCount + point.outputTokenCount;
              break;
            case 'inputTokens':
              value = point.inputTokenCount;
              break;
            case 'outputTokens':
              value = point.outputTokenCount;
              break;
          }

          if (!timeGroups.has(timestamp)) {
            timeGroups.set(timestamp, new Map());
          }
          const seriesMap = timeGroups.get(timestamp);
          if (seriesMap) {
            seriesMap.set(seriesKey, (seriesMap.get(seriesKey) || 0) + value);
          }
        }
      }
    });

    // For active_users, convert the unique email sets to counts
    // and ensure all timestamps have all series keys (with 0 for missing data)
    if (selectedMetric.key === 'users') {
      // For token type split, collect the series keys from userTracking
      if (chartSplitBy.tokenType) {
        userTracking.forEach(seriesEmailsMap => {
          seriesEmailsMap.forEach((_, key) => {
            allSeriesKeys.add(key);
          });
        });
      }

      // Initialize all timestamps with all series keys set to 0
      allTimestamps.forEach(timestamp => {
        if (!timeGroups.has(timestamp)) {
          timeGroups.set(timestamp, new Map());
        }
        const seriesMap = timeGroups.get(timestamp);
        if (seriesMap) {
          allSeriesKeys.forEach(seriesKey => {
            seriesMap.set(seriesKey, 0);
          });
        }
      });

      // Override with actual user counts
      userTracking.forEach((seriesEmailsMap, timestamp) => {
        const seriesMap = timeGroups.get(timestamp);
        if (seriesMap) {
          seriesEmailsMap.forEach((emails, seriesKey) => {
            seriesMap.set(seriesKey, emails.size);
          });
        }
      });
    }

    // For token splits with non-user metrics, collect series keys from timeGroups
    if (selectedMetric.key === 'tokens' && chartSplitBy.tokenType) {
      timeGroups.forEach(seriesMap => {
        seriesMap.forEach((_, key) => {
          allSeriesKeys.add(key);
        });
      });
    }

    // Convert to recharts format
    const sortedTimestamps = Array.from(timeGroups.keys()).sort((a, b) => a - b);

    // If we haven't collected series keys yet (e.g., for non-user, non-token-split metrics),
    // collect them from timeGroups now
    if (allSeriesKeys.size === 0) {
      timeGroups.forEach(seriesMap => {
        seriesMap.forEach((_, key) => {
          allSeriesKeys.add(key);
        });
      });
    }

    const seriesKeysArray = Array.from(allSeriesKeys).sort();

    // Second pass: create data points with 0 for missing values
    const data = sortedTimestamps.map(ts => {
      const seriesMap = timeGroups.get(ts);
      const dataPoint: Record<string, number | string> = {
        timestamp: ts,
        date: new Date(ts * 1000).toLocaleDateString(),
      };

      // Initialize all series with 0, then override with actual values
      seriesKeysArray.forEach(key => {
        dataPoint[key] = 0;
      });

      if (seriesMap) {
        seriesMap.forEach((value, key) => {
          dataPoint[key] = value;
        });
      }

      return dataPoint;
    });

    return { chartData: data, seriesKeys: seriesKeysArray };
  }, [selectedMetric, timeseriesData, chartSplitBy]);

  const toggleSeries = (seriesKey: string) => {
    setHiddenSeries(prev => {
      const newSet = new Set(prev);
      if (newSet.has(seriesKey)) {
        newSet.delete(seriesKey);
      } else {
        newSet.add(seriesKey);
      }
      return newSet;
    });
  };

  if (!selectedMetric) {
    return (
      <Card className={cn('w-full', className)}>
        <CardContent className="flex h-64 items-center justify-center">
          <p className="text-muted-foreground">No metric selected</p>
        </CardContent>
      </Card>
    );
  }

  const IconComponent = selectedMetric.icon;

  const formatYAxis = (value: number) => {
    if (selectedMetric.key === 'cost' || selectedMetric.key === 'avgCost') {
      return `$${(value / 1000000).toFixed(2)}`;
    }
    return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : value.toString();
  };

  const formatTooltip = (value: number) => {
    if (selectedMetric.key === 'cost' || selectedMetric.key === 'avgCost') {
      return `$${(value / 1000000).toFixed(4)}`;
    }
    if (
      selectedMetric.key === 'tokens' ||
      selectedMetric.key === 'inputTokens' ||
      selectedMetric.key === 'outputTokens'
    ) {
      return formatLargeNumber(value);
    }
    return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : value.toString();
  };

  // Custom tick component to ensure unique date labels
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const CustomXAxisTick = ({ x, y, payload }: any) => {
    const date = new Date(payload.value * 1000);
    const formattedDate = date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });

    return (
      <g transform={`translate(${x},${y})`}>
        <text x={0} y={0} dy={16} textAnchor="middle" fill="#a1a1a1" fontSize={11}>
          {formattedDate}
        </text>
      </g>
    );
  };

  // Custom tooltip component
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const CustomTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload || !payload.length) return null;

    // Convert the label (which is a short date string) back to a full date
    // We need to get the timestamp from the data point
    const dataPoint = payload[0]?.payload;
    const timestamp = dataPoint?.timestamp;
    const fullDate = timestamp
      ? new Date(timestamp * 1000).toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        })
      : label;

    // Filter out entries with 0 values and sort by value (highest to lowest)
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const filteredAndSortedPayload = payload
      .filter((entry: any) => (entry.value as number) > 0)
      .sort((a: any, b: any) => (b.value as number) - (a.value as number));
    /* eslint-enable @typescript-eslint/no-explicit-any */

    // // If no non-zero values, don't show tooltip
    // if (filteredAndSortedPayload.length === 0) return null;

    return (
      <div
        className="rounded-lg border border-gray-700 p-3 shadow-lg backdrop-blur-sm"
        style={{
          backgroundColor: 'rgba(17, 24, 39, 0.95)',
          backdropFilter: 'blur(8px)',
        }}
      >
        <p className="mb-2 text-xs font-medium text-gray-400">{fullDate}</p>
        <div className="space-y-1">
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          {filteredAndSortedPayload.map((entry: any, index: number) => (
            <div key={index} className="flex items-center gap-2">
              <div className="h-2 w-2 rounded-full" style={{ backgroundColor: entry.color }} />
              <span className="text-sm font-medium text-gray-100">
                {entry.name}: {formatTooltip(entry.value as number)}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <Card className={cn('w-full', className)}>
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            {IconComponent && (
              <div
                className="flex h-10 w-10 items-center justify-center rounded-lg"
                style={{ backgroundColor: `${selectedMetric.color || '#3b82f6'}20` }}
              >
                <IconComponent className="h-5 w-5" />
              </div>
            )}
            <div>
              <CardTitle className="text-lg font-bold tracking-tight">
                {selectedMetric.title}
              </CardTitle>
              <p className="text-muted-foreground text-xs">
                {(() => {
                  const splits = [];
                  if (chartSplitBy.provider) splits.push('provider');
                  if (chartSplitBy.model) splits.push('model');
                  if (chartSplitBy.tokenType) splits.push('token type');
                  return splits.length > 0 ? `Split by ${splits.join(' and ')}` : 'Aggregated view';
                })()}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            {onChartSplitByChange && (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-xs">Split by:</span>
                <div className="flex gap-1">
                  <Button
                    variant={chartSplitBy.provider ? 'default' : 'outline'}
                    size="sm"
                    onClick={() =>
                      onChartSplitByChange({ ...chartSplitBy, provider: !chartSplitBy.provider })
                    }
                  >
                    Provider
                  </Button>
                  <Button
                    variant={chartSplitBy.model ? 'default' : 'outline'}
                    size="sm"
                    onClick={() =>
                      onChartSplitByChange({ ...chartSplitBy, model: !chartSplitBy.model })
                    }
                  >
                    Model
                  </Button>
                  {selectedMetric?.key === 'tokens' && (
                    <Button
                      variant={chartSplitBy.tokenType ? 'default' : 'outline'}
                      size="sm"
                      onClick={() =>
                        onChartSplitByChange({
                          ...chartSplitBy,
                          tokenType: !chartSplitBy.tokenType,
                        })
                      }
                    >
                      Input/Output
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="relative h-64 w-full">
          {selectedMetric.loading ? (
            <div className="flex h-full items-center justify-center">
              <div className="h-full w-full animate-pulse rounded bg-gray-700" />
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
                <defs>
                  {seriesKeys.map((key, index) => {
                    const color = COLORS[index % COLORS.length];
                    return (
                      <linearGradient key={key} id={`gradient-${key}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={color} stopOpacity={0.3} />
                        <stop offset="95%" stopColor={color} stopOpacity={0.05} />
                      </linearGradient>
                    );
                  })}
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                <XAxis
                  dataKey="timestamp"
                  stroke="#a1a1a1"
                  tick={<CustomXAxisTick />}
                  interval="preserveStartEnd"
                  minTickGap={80}
                  scale="time"
                  type="number"
                  domain={['dataMin', 'dataMax']}
                />
                <YAxis
                  stroke="#a1a1a1"
                  tick={{ fontSize: 11 }}
                  width={60}
                  tickFormatter={formatYAxis}
                />
                <Tooltip content={<CustomTooltip />} cursor={{ stroke: '#666', strokeWidth: 1 }} />
                {seriesKeys.length > 1 && (
                  <Legend
                    onClick={e => {
                      if (e.value) toggleSeries(e.value);
                    }}
                    wrapperStyle={{ cursor: 'pointer', paddingTop: '10px', fontSize: '11px' }}
                  />
                )}
                {seriesKeys.map((key, index) => (
                  <Area
                    key={key}
                    type="monotone"
                    dataKey={key}
                    stroke={COLORS[index % COLORS.length]}
                    strokeWidth={2}
                    fill={`url(#gradient-${key})`}
                    dot={{ r: 0 }}
                    activeDot={{ r: 4 }}
                    hide={hiddenSeries.has(key)}
                    isAnimationActive={false}
                    connectNulls={true}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
