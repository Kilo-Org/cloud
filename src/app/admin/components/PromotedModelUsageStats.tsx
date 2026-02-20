'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { PromotedModelUsageStatsResponse } from '../api/promoted-model-usage/stats/route';

export function PromotedModelUsageStats() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-promoted-model-usage-stats'],
    queryFn: async () => {
      const response = await fetch('/admin/api/promoted-model-usage/stats');

      if (!response.ok) {
        throw new Error('Failed to fetch promoted model usage statistics');
      }

      return (await response.json()) as PromotedModelUsageStatsResponse;
    },
    refetchInterval: 60000, // Refresh every minute
  });

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Error</CardTitle>
          <CardDescription>Failed to load promoted model usage statistics</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            {error instanceof Error ? error.message : 'An error occurred'}
          </p>
        </CardContent>
      </Card>
    );
  }

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Loading...</CardTitle>
          <CardDescription>Fetching promoted model usage statistics</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const formatNumber = (num: number) => {
    return num.toLocaleString();
  };

  return (
    <div className="space-y-6">
      {/* Rate Limit Configuration */}
      <Card>
        <CardHeader>
          <CardTitle>Promotion Limit Configuration</CardTitle>
          <CardDescription>
            Rate limit settings for anonymous/unauthenticated users on promoted models (IP-based)
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <div className="text-muted-foreground text-sm">Window Duration</div>
              <div className="text-2xl font-bold">{data?.promotionWindowHours} hours</div>
            </div>
            <div>
              <div className="text-muted-foreground text-sm">Max Requests / Window</div>
              <div className="text-2xl font-bold">
                {formatNumber(data?.promotionMaxRequests ?? 0)}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Current Window Stats */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Unique IPs (Window)</CardTitle>
            <CardDescription>Last {data?.promotionWindowHours} hours</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{formatNumber(data?.windowUniqueIps ?? 0)}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Total Requests (Window)</CardTitle>
            <CardDescription>Last {data?.promotionWindowHours} hours</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{formatNumber(data?.windowTotalRequests ?? 0)}</div>
            <div className="text-muted-foreground text-sm">
              Avg: {formatNumber(data?.windowAvgRequestsPerIp ?? 0)} / IP
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">IPs at Promotion Limit</CardTitle>
            <CardDescription>
              IPs that have reached {formatNumber(data?.promotionMaxRequests ?? 0)} requests
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">
              {formatNumber(data?.windowIpsAtRequestLimit ?? 0)}
            </div>
            {(data?.windowUniqueIps ?? 0) > 0 && (
              <div className="text-muted-foreground text-sm">
                {(
                  ((data?.windowIpsAtRequestLimit ?? 0) / (data?.windowUniqueIps ?? 1)) *
                  100
                ).toFixed(1)}
                % of active IPs
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
