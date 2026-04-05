import { useMemo } from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { FormattedMicrodollars } from '@/components/organizations/FormattedMicrodollars';
import { formatIsoDateString_UsaDateOnlyFormat, formatLargeNumber } from '@/lib/utils';
import type { UsageTableColumn, UsageTableRow } from '@/components/usage/UsageTableBase';
import type { DailyUsageRollup, UsageDetailItem } from '../types';

type UseUsageTableDataResult = {
  tableData: UsageTableRow[];
  columns: UsageTableColumn[];
};

/**
 * Processes raw usage details into table format with expandable rows.
 *
 * This hook aggregates usage data by date (and optionally by model), creating
 * parent rows with expandable child rows showing per-user details.
 *
 * @param usageDetails - Raw usage details from API
 * @param groupByModel - Whether to group by model in addition to date
 * @returns Table data and column definitions
 */
export function useUsageTableData(
  usageDetails: { daily?: UsageDetailItem[] } | undefined,
  groupByModel: boolean
): UseUsageTableDataResult {
  return useMemo(() => {
    if (!usageDetails?.daily) return { tableData: [], columns: [] };

    const rollupMap = new Map<string, DailyUsageRollup>();

    // Aggregate usage data by date (and model if groupByModel is true)
    // WHY: We support two grouping modes (by day only, or by day+model). The key construction
    // determines whether we create separate rows for each model or aggregate them together.
    usageDetails.daily?.forEach((usage: UsageDetailItem) => {
      const key = groupByModel ? `${usage.date}-${usage.model || 'unknown'}` : usage.date;

      const existing = rollupMap.get(key);
      const microdollarCost = usage.microdollarCost ? parseFloat(usage.microdollarCost) : 0;

      if (existing) {
        existing.totalCost += microdollarCost;
        existing.totalTokens += usage.tokenCount;
        existing.totalInputTokens += usage.inputTokens;
        existing.totalOutputTokens += usage.outputTokens;
        existing.totalRequests += usage.requestCount;
        existing.users.push(usage);
        existing.userCount = new Set(existing.users.map(u => u.user.email)).size;
      } else {
        rollupMap.set(key, {
          date: usage.date,
          totalCost: microdollarCost,
          totalTokens: usage.tokenCount,
          totalInputTokens: usage.inputTokens,
          totalOutputTokens: usage.outputTokens,
          totalRequests: usage.requestCount,
          userCount: 1,
          users: [usage],
        });
      }
    });

    const dailyRollups = Array.from(rollupMap.values()).sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );

    // Define table columns
    const tableColumns: UsageTableColumn[] = [
      {
        key: 'date',
        label: 'Date',
        render: (value, row) => {
          // WHY: The date column conditionally renders either the date (for parent rows) or
          // user info (for expanded child rows). This dual-purpose rendering enables the
          // expandable table pattern without duplicating column definitions.
          if (row.user) {
            const user = row.user as { name: string; email: string };
            return (
              <div className="flex flex-col pl-8">
                <span className="text-sm font-medium">{user.name}</span>
                <span className="text-xs text-gray-500">{user.email}</span>
              </div>
            );
          }
          return formatIsoDateString_UsaDateOnlyFormat(value as string);
        },
      },
      ...(groupByModel
        ? [
            {
              key: 'model',
              label: 'Model',
              render: (value: unknown) => (value as string) || 'Unknown',
            },
          ]
        : []),
      {
        key: 'totalCost',
        label: 'Cost',
        render: value => <FormattedMicrodollars microdollars={value as number} />,
      },
      {
        key: 'totalRequests',
        label: 'Requests',
        render: value => formatLargeNumber(value as number),
      },
      {
        key: 'totalTokens',
        label: 'Tokens',
        render: (value, row) => {
          const totalTokens = value as number;
          const inputTokens = (row.totalInputTokens as number) || (row.inputTokens as number) || 0;
          const outputTokens =
            (row.totalOutputTokens as number) || (row.outputTokens as number) || 0;

          return (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-help">{formatLargeNumber(totalTokens)}</span>
                </TooltipTrigger>
                <TooltipContent>
                  <div className="text-xs">
                    <div>Input: {formatLargeNumber(inputTokens)}</div>
                    <div>Output: {formatLargeNumber(outputTokens)}</div>
                  </div>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          );
        },
      },
      {
        key: 'userCount',
        label: 'Users',
        render: value => (value ? formatLargeNumber(value as number) : ''),
      },
    ];

    // Create table rows with expandable user details
    const tableRows: UsageTableRow[] = dailyRollups.map(rollup => ({
      id: groupByModel ? `${rollup.date}-${rollup.users[0]?.model || 'unknown'}` : rollup.date,
      date: rollup.date,
      ...(groupByModel && { model: rollup.users[0]?.model || 'Unknown' }),
      totalCost: rollup.totalCost,
      totalTokens: rollup.totalTokens,
      totalInputTokens: rollup.totalInputTokens,
      totalOutputTokens: rollup.totalOutputTokens,
      totalRequests: rollup.totalRequests,
      userCount: rollup.userCount,
      expandable: true,
      expandedContent: rollup.users.map(usage => ({
        id: `${rollup.date}-${usage.user.email}${groupByModel ? `-${usage.model || 'unknown'}` : ''}`,
        date: rollup.date,
        user: usage.user,
        ...(groupByModel && { model: usage.model || 'Unknown' }),
        totalCost: usage.microdollarCost ? parseFloat(usage.microdollarCost) : 0,
        totalTokens: usage.tokenCount,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalRequests: usage.requestCount,
        userCount: null,
      })),
    }));

    return { tableData: tableRows, columns: tableColumns };
  }, [groupByModel, usageDetails]);
}
