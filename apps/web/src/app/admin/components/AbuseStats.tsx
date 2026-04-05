'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type AbuseStatsResponse = {
  hourlyAbusePercentage: number;
  abuseCostMicrodollars: number;
  totalCostMicrodollars: number;
  abuseRequestCount: number;
  totalRequestCount: number;
  dailyAbusePercentage: number;
  dailyAbuseCostMicrodollars: number;
  dailyTotalCostMicrodollars: number;
  dailyAbuseTokenPercentage: number;
  dailyAbuseTokens: number;
  dailyTotalTokens: number;
};

export function AbuseStats() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-abuse-stats'],
    queryFn: async () => {
      const response = await fetch('/admin/api/abuse/stats');

      if (!response.ok) {
        throw new Error('Failed to fetch abuse statistics');
      }

      return (await response.json()) as AbuseStatsResponse;
    },
    refetchInterval: 60000, // Refresh every minute
  });

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Error</CardTitle>
          <CardDescription>Failed to load abuse statistics</CardDescription>
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
          <CardDescription>Fetching abuse statistics</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const formatMicrodollars = (microdollars: number) => {
    return `$${(microdollars / 1000000).toFixed(2)}`;
  };

  const formatTokens = (tokens: number) => {
    if (tokens >= 1000000) {
      return `${(tokens / 1000000).toFixed(2)}M`;
    } else if (tokens >= 1000) {
      return `${(tokens / 1000).toFixed(2)}K`;
    }
    return tokens.toString();
  };

  return (
    <div className="grid gap-4 md:grid-cols-3">
      {/* Hourly Abuse Cost Percentage */}
      <Card>
        <CardHeader>
          <CardTitle>Abuse - % Cost USD Last Hour</CardTitle>
          <CardDescription>
            Percentage of costs from requests classified as abuse in the last hour
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-4xl font-bold">{data?.hourlyAbusePercentage.toFixed(3)}%</div>
          <div className="text-muted-foreground mt-4 space-y-2 text-sm">
            <div>
              Abuse Cost: {formatMicrodollars(data?.abuseCostMicrodollars || 0)} (
              {data?.abuseRequestCount || 0} requests)
            </div>
            <div>
              Total Cost: {formatMicrodollars(data?.totalCostMicrodollars || 0)} (
              {data?.totalRequestCount || 0} requests)
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Daily Abuse Cost Percentage */}
      <Card>
        <CardHeader>
          <CardTitle>Abuse - % Cost USD last 24 hours</CardTitle>
          <CardDescription>
            Percentage of costs from requests classified as abuse in the last 24 hours
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-4xl font-bold">{data?.dailyAbusePercentage.toFixed(3)}%</div>
          <div className="text-muted-foreground mt-4 space-y-2 text-sm">
            <div>Abuse Cost: {formatMicrodollars(data?.dailyAbuseCostMicrodollars || 0)}</div>
            <div>Total Cost: {formatMicrodollars(data?.dailyTotalCostMicrodollars || 0)}</div>
          </div>
        </CardContent>
      </Card>

      {/* Daily Abuse Token Percentage */}
      <Card>
        <CardHeader>
          <CardTitle>Abuse - % By Tokens Last 24 hours</CardTitle>
          <CardDescription>
            Percentage of tokens from requests classified as abuse in the last 24 hours
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-4xl font-bold">{data?.dailyAbuseTokenPercentage.toFixed(3)}%</div>
          <div className="text-muted-foreground mt-4 space-y-2 text-sm">
            <div>Abuse Tokens: {formatTokens(data?.dailyAbuseTokens || 0)}</div>
            <div>Total Tokens: {formatTokens(data?.dailyTotalTokens || 0)}</div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
