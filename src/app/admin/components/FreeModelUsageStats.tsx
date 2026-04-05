'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { FreeModelUsageStatsResponse } from '../api/free-model-usage/stats/route';

export function FreeModelUsageStats() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-free-model-usage-stats'],
    queryFn: async () => {
      const response = await fetch('/admin/api/free-model-usage/stats');

      if (!response.ok) {
        throw new Error('Failed to fetch free model usage statistics');
      }

      return (await response.json()) as FreeModelUsageStatsResponse;
    },
    refetchInterval: 60000, // Refresh every minute
  });

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Error</CardTitle>
          <CardDescription>Failed to load free model usage statistics</CardDescription>
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
          <CardDescription>Fetching free model usage statistics</CardDescription>
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
          <CardTitle>Rate Limit Configuration</CardTitle>
          <CardDescription>Current free model rate limit settings (IP-based)</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <div className="text-muted-foreground text-sm">Window Duration</div>
              <div className="text-2xl font-bold">{data?.rateLimitWindowHours} hours</div>
            </div>
            <div>
              <div className="text-muted-foreground text-sm">Max Requests / Window</div>
              <div className="text-2xl font-bold">
                {formatNumber(data?.maxRequestsPerWindow ?? 0)}
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
            <CardDescription>Last {data?.rateLimitWindowHours} hours</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{formatNumber(data?.windowUniqueIps ?? 0)}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Total Requests (Window)</CardTitle>
            <CardDescription>Last {data?.rateLimitWindowHours} hours</CardDescription>
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
            <CardTitle className="text-base">IPs at Request Limit</CardTitle>
            <CardDescription>
              IPs that have reached {formatNumber(data?.maxRequestsPerWindow ?? 0)} requests
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

      {/* Anonymous vs Authenticated Breakdown */}
      <Card>
        <CardHeader>
          <CardTitle>Request Breakdown (Window)</CardTitle>
          <CardDescription>
            Anonymous vs authenticated requests in the last {data?.rateLimitWindowHours} hours
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <div className="text-muted-foreground text-sm">Anonymous Requests</div>
              <div className="text-2xl font-bold">
                {formatNumber(data?.windowAnonymousRequests ?? 0)}
              </div>
              {(data?.windowTotalRequests ?? 0) > 0 && (
                <div className="text-muted-foreground text-sm">
                  {(
                    ((data?.windowAnonymousRequests ?? 0) / (data?.windowTotalRequests ?? 1)) *
                    100
                  ).toFixed(1)}
                  % of total
                </div>
              )}
            </div>
            <div>
              <div className="text-muted-foreground text-sm">Authenticated Requests</div>
              <div className="text-2xl font-bold">
                {formatNumber(data?.windowAuthenticatedRequests ?? 0)}
              </div>
              {(data?.windowTotalRequests ?? 0) > 0 && (
                <div className="text-muted-foreground text-sm">
                  {(
                    ((data?.windowAuthenticatedRequests ?? 0) / (data?.windowTotalRequests ?? 1)) *
                    100
                  ).toFixed(1)}
                  % of total
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Daily Stats */}
      <Card>
        <CardHeader>
          <CardTitle>Last 24 Hours</CardTitle>
          <CardDescription>Free model usage statistics for the past day</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-4">
            <div>
              <div className="text-muted-foreground text-sm">Unique IPs</div>
              <div className="text-2xl font-bold">{formatNumber(data?.dailyUniqueIps ?? 0)}</div>
            </div>
            <div>
              <div className="text-muted-foreground text-sm">Total Requests</div>
              <div className="text-2xl font-bold">
                {formatNumber(data?.dailyTotalRequests ?? 0)}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground text-sm">Anonymous Requests</div>
              <div className="text-2xl font-bold">
                {formatNumber(data?.dailyAnonymousRequests ?? 0)}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground text-sm">Authenticated Requests</div>
              <div className="text-2xl font-bold">
                {formatNumber(data?.dailyAuthenticatedRequests ?? 0)}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
