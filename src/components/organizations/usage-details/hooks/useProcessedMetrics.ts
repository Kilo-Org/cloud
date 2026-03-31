import { useMemo } from 'react';
import type { ProcessedMetricsData, MetricsTotals, TimeseriesDataPoint } from '../types';

type UseProcessedMetricsResult = {
  metricsTimeseriesData: ProcessedMetricsData;
  metricsTotals: MetricsTotals;
  metricsLoading: string[];
};

/**
 * Processes raw timeseries data into aggregated metrics for visualization.
 *
 * This hook performs time-based aggregation of usage data, calculating totals
 * for cost, requests, tokens, and active users across time periods.
 *
 * @param filteredTimeseriesData - Array of timeseries data points (already filtered)
 * @param timeseriesLoading - Whether the timeseries data is still loading
 * @returns Processed metrics data, totals, and loading states
 */
export function useProcessedMetrics(
  filteredTimeseriesData: TimeseriesDataPoint[],
  timeseriesLoading: boolean
): UseProcessedMetricsResult {
  return useMemo(() => {
    if (!filteredTimeseriesData.length) {
      return {
        metricsTimeseriesData: {
          cost: [],
          requests: [],
          avg_cost_per_req: [],
          tokens: [],
          input_tokens: [],
          output_tokens: [],
          active_users: [],
        } satisfies ProcessedMetricsData,
        metricsTotals: {
          cost: 0,
          requests: 0,
          avg_cost_per_req: 0,
          tokens: 0,
          input_tokens: 0,
          output_tokens: 0,
          active_users: 0,
        } satisfies MetricsTotals,
        metricsLoading: timeseriesLoading
          ? [
              'cost',
              'requests',
              'avg_cost_per_req',
              'tokens',
              'input_tokens',
              'output_tokens',
              'active_users',
            ]
          : [],
      };
    }

    // Group data by datetime for aggregation
    // WHY: We group by datetime first to handle multiple data points at the same timestamp
    // (e.g., different users/models at the same time). This enables proper aggregation.
    const timeGroups = new Map<string, TimeseriesDataPoint[]>();

    filteredTimeseriesData.forEach(point => {
      const timeKey = point.datetime;
      if (!timeGroups.has(timeKey)) {
        timeGroups.set(timeKey, []);
      }
      const group = timeGroups.get(timeKey);
      if (group) {
        group.push(point);
      }
    });

    // Process each time group into aggregated metrics
    const processedData: ProcessedMetricsData = {
      cost: [],
      requests: [],
      avg_cost_per_req: [],
      tokens: [],
      input_tokens: [],
      output_tokens: [],
      active_users: [],
    };

    const sortedTimes = Array.from(timeGroups.keys()).sort();

    sortedTimes.forEach(timeKey => {
      const points = timeGroups.get(timeKey);
      if (!points) return;

      // Aggregate metrics for this time period
      // WHY: Each metric requires different aggregation logic:
      // - cost/requests/tokens: simple sum
      // - avg_cost_per_req: calculated from totals to avoid averaging averages
      // - active_users: count unique emails who made at least 1 request in the time period
      const totalCost = points.reduce((sum, p) => sum + p.costMicrodollars, 0);
      const totalRequests = points.reduce((sum, p) => sum + p.requestCount, 0);
      const totalInputTokens = points.reduce((sum, p) => sum + p.inputTokenCount, 0);
      const totalOutputTokens = points.reduce((sum, p) => sum + p.outputTokenCount, 0);
      const totalTokens = totalInputTokens + totalOutputTokens;
      const uniqueUsers = new Set(points.filter(p => p.requestCount > 0).map(p => p.email)).size;
      const avgCostPerReq = totalRequests > 0 ? totalCost / totalRequests : 0;

      processedData.cost.push({ ts: timeKey, value: totalCost });
      processedData.requests.push({ ts: timeKey, value: totalRequests });
      processedData.avg_cost_per_req.push({ ts: timeKey, value: avgCostPerReq });
      processedData.tokens.push({ ts: timeKey, value: totalTokens });
      processedData.input_tokens.push({ ts: timeKey, value: totalInputTokens });
      processedData.output_tokens.push({ ts: timeKey, value: totalOutputTokens });
      processedData.active_users.push({ ts: timeKey, value: uniqueUsers });
    });

    // Calculate totals
    // WHY: active_users total is the count of ALL unique users who made at least 1 request
    // across time periods, not the sum of per-period counts (which would double-count users
    // active in multiple periods)
    const allUniqueUsers = new Set(
      filteredTimeseriesData.filter(p => p.requestCount > 0).map(p => p.email)
    ).size;

    const totalCostAll = processedData.cost.reduce((sum, p) => sum + p.value, 0);
    const totalRequestsAll = processedData.requests.reduce((sum, p) => sum + p.value, 0);

    const totals: MetricsTotals = {
      cost: totalCostAll,
      requests: totalRequestsAll,
      avg_cost_per_req: totalRequestsAll > 0 ? totalCostAll / totalRequestsAll : 0,
      tokens: processedData.tokens.reduce((sum, p) => sum + p.value, 0),
      input_tokens: processedData.input_tokens.reduce((sum, p) => sum + p.value, 0),
      output_tokens: processedData.output_tokens.reduce((sum, p) => sum + p.value, 0),
      active_users: allUniqueUsers,
    };

    return {
      metricsTimeseriesData: processedData,
      metricsTotals: totals,
      metricsLoading: timeseriesLoading
        ? [
            'cost',
            'requests',
            'avg_cost_per_req',
            'tokens',
            'input_tokens',
            'output_tokens',
            'active_users',
          ]
        : [],
    };
  }, [filteredTimeseriesData, timeseriesLoading]);
}
