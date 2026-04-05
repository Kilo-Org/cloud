'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useOrganizationUsageStats } from '@/app/api/organizations/hooks';
import { ErrorCard } from '@/components/ErrorCard';
import { LoadingCard } from '@/components/LoadingCard';
import { FormattedMicrodollars } from './FormattedMicrodollars';
import { BarChart3, ChartColumnIncreasing, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { ReactNode } from 'react';

function formatTokenCount(count: number): string {
  if (count >= 1_000_000_000_000) {
    return (count / 1_000_000_000_000).toFixed(2) + 'T';
  } else if (count >= 1_000_000_000) {
    return (count / 1_000_000_000).toFixed(2) + 'B';
  } else if (count >= 1_000_000) {
    return (count / 1_000_000).toFixed(2) + 'M';
  } else if (count >= 1_000) {
    return (count / 1_000).toFixed(2) + 'K';
  } else {
    return count.toString();
  }
}

function MetricWithTooltip({
  label,
  content,
  tooltipTitle,
  tooltipContent,
  noWrap = false,
}: {
  label: string;
  content: ReactNode;
  tooltipTitle: string;
  tooltipContent: ReactNode;
  noWrap?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="group cursor-help">
          <label
            className={`text-muted-foreground flex items-center gap-1 text-sm font-medium${
              noWrap ? 'whitespace-nowrap' : ''
            }`}
          >
            {label}
            <Info className="h-2 w-2 opacity-40 transition-opacity group-hover:opacity-70" />
          </label>
          {content}
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <div className="text-center">
          <p className="text-xs font-medium">{tooltipTitle}</p>
          {tooltipContent}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
export function OrganizationUsageSummaryCard({ organizationId }: { organizationId: string }) {
  const {
    error,
    data: usage_stats,
    isLoading,
    refetch,
  } = useOrganizationUsageStats(organizationId);

  if (isLoading) {
    return (
      <LoadingCard
        title="Usage Statistics"
        description="Loading usage statistics..."
        rowCount={1}
      />
    );
  }

  if (error) {
    return (
      <ErrorCard
        title="Usage Statistics"
        description="Error loading usage statistics"
        error={error}
        onRetry={() => refetch()}
      />
    );
  }

  if (!usage_stats) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Usage Statistics</CardTitle>
          <CardDescription>No usage data available</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">No usage statistics found</p>
        </CardContent>
      </Card>
    );
  }

  const averageRequestsPerDay = Math.round((usage_stats.totalRequestCount / 30) * 10) / 10;
  const averageInputTokensPerDay = Math.round((usage_stats.totalInputTokens / 30) * 10) / 10;
  const averageOutputTokensPerDay = Math.round((usage_stats.totalOutputTokens / 30) * 10) / 10;

  return (
    <TooltipProvider>
      <Card>
        <CardHeader>
          <CardTitle>
            <BarChart3 className="mr-2 inline h-5 w-5" />
            Usage Statistics
          </CardTitle>
          <CardDescription>Organization usage and spending (last 30 days)</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <MetricWithTooltip
              label="Total Spent"
              content={
                <FormattedMicrodollars
                  microdollars={usage_stats.totalCost}
                  decimalPlaces={2}
                  className="text-2xl font-bold"
                />
              }
              tooltipTitle="Average Cost per Request"
              tooltipContent={
                usage_stats.totalRequestCount > 0 ? (
                  <FormattedMicrodollars
                    decimalPlaces={4}
                    microdollars={usage_stats.totalCost / usage_stats.totalRequestCount}
                    className="text-sm font-semibold"
                  />
                ) : (
                  <p className="text-sm font-semibold">n/a</p>
                )
              }
            />

            <MetricWithTooltip
              label="Total Requests"
              content={
                <p className="text-xl font-semibold">
                  {usage_stats.totalRequestCount.toLocaleString()}
                </p>
              }
              tooltipTitle="Average Requests per Day"
              tooltipContent={<p className="text-sm font-semibold">{averageRequestsPerDay}</p>}
              noWrap
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <MetricWithTooltip
              label="Total Input Tokens"
              content={
                <p className="text-lg font-semibold">
                  {formatTokenCount(usage_stats.totalInputTokens)}
                </p>
              }
              tooltipTitle="Average Input Tokens per Day"
              tooltipContent={
                <p className="text-sm font-semibold">
                  {formatTokenCount(averageInputTokensPerDay)}
                </p>
              }
            />

            <MetricWithTooltip
              label="Total Output Tokens"
              content={
                <p className="text-lg font-semibold">
                  {formatTokenCount(usage_stats.totalOutputTokens)}
                </p>
              }
              tooltipTitle="Average Output Tokens per Day"
              tooltipContent={
                <p className="text-sm font-semibold">
                  {formatTokenCount(averageOutputTokensPerDay)}
                </p>
              }
              noWrap
            />
          </div>

          <Button variant="outline" asChild>
            <Link
              href={`/organizations/${organizationId}/usage-details`}
              className="whitespace-nowrap"
            >
              <ChartColumnIncreasing className="mr-2 h-4 w-4" />
              View Detailed Usage
            </Link>
          </Button>
        </CardContent>
      </Card>
    </TooltipProvider>
  );
}
