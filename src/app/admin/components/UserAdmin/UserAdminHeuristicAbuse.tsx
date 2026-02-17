'use client';

import { Button } from '@/components/ui/button';
import { useQuery } from '@tanstack/react-query';
import type { UserDetailProps } from '@/types/admin';
import { useState, useMemo } from 'react';
import type {
  ApiResponse,
  GroupByDimension,
  GroupedData,
  UsageForTableDisplay,
} from '../../api/users/heuristic-analysis/types';
import { CopyJsonButton } from '@/components/admin/CopyJsonButton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toNonNullish } from '@/lib/utils';

// Table column definition structure
type TableColumn<T> = {
  key: keyof T;
  title: string;
  render: (row: T) => string | React.ReactElement;
  visible: boolean;
};

const getAbuseTooltipContent = (_item: UsageForTableDisplay) => {
  // try {
  //   const result = classifyRecord(item);
  //   const activeChecks = Object.entries(result.checks)
  //     .filter(([_, value]) => value)
  //     .map(([key, _]) => key.replace(/_/g, ' '));

  //   if (activeChecks.length === 0) return 'No abuse indicators detected';

  //   return `Flagged as abuse because:\n${activeChecks.map(check => `• ${check}`).join('\n')}`;
  // } catch (_error) {
  return 'Unable to determine abuse reasons';
  // }
};

// Create column definitions for MicrodollarUsage
const createMicrodollarUsageColumns = (): TableColumn<UsageForTableDisplay>[] => [
  {
    key: 'created_at',
    title: 'Created At',
    render: row => (row.created_at ? new Date(row.created_at).toISOString() : 'N/A'),
    visible: true,
  },
  {
    key: 'abuse_classification',
    title: 'Abuse?',
    render: row => {
      const classification = row.abuse_classification;
      if (classification > 0) {
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="cursor-help">🔴</span>
            </TooltipTrigger>
            <TooltipContent>
              <pre className="text-xs whitespace-pre-wrap">{getAbuseTooltipContent(row)}</pre>
            </TooltipContent>
          </Tooltip>
        );
      }
      if (classification < 0) return 'no';
      return '🟡';
    },
    visible: true,
  },
  {
    key: 'generation_time',
    title: 'Duration (s)',
    render: row => (row.generation_time != null ? row.generation_time.toFixed(2) : 'N/A'),
    visible: true,
  },
  {
    key: 'latency',
    title: 'Latency (s)',
    render: row => (row.latency != null ? row.latency.toFixed(2) : 'N/A'),
    visible: false,
  },
  {
    key: 'moderation_latency',
    title: 'Moderation Latency (s)',
    render: row => (row.moderation_latency != null ? row.moderation_latency.toFixed(2) : 'N/A'),
    visible: false,
  },
  {
    key: 'http_user_agent',
    title: 'User Agent',
    render: row => row.http_user_agent || 'N/A',
    visible: true,
  },
  { key: 'model', title: 'Model', render: row => row.model || 'N/A', visible: true },
  {
    key: 'requested_model',
    title: 'Requested Model',
    render: row => row.requested_model || 'N/A',
    visible: false,
  },
  {
    key: 'cost',
    title: 'Cost',
    render: row => (row.cost ? `$${(row.cost / 1_000_000).toFixed(4)}` : '$0.0000'),
    visible: true,
  },
  {
    key: 'input_tokens',
    title: 'Tokens Inp',
    render: row => (row.input_tokens ?? 0).toLocaleString(),
    visible: true,
  },
  {
    key: 'output_tokens',
    title: 'Tokens Out',
    render: row => (row.output_tokens ?? 0).toLocaleString(),
    visible: true,
  },
  {
    key: 'cache_discount',
    title: 'Cache Discount',
    render: row => (row.cache_discount ?? 0).toLocaleString(),
    visible: false,
  },
  {
    key: 'max_tokens',
    title: 'Max Tokens',
    render: row => (row.max_tokens ?? NaN).toLocaleString(),
    visible: false,
  },
  {
    key: 'http_x_vercel_ja4_digest',
    title: 'JA4',
    render: row => (
      <span className={row.is_ja4_whitelisted ? 'bg-blue-500' : ''}>
        {row.http_x_vercel_ja4_digest || 'N/A'}
      </span>
    ),
    visible: true,
  },
  {
    key: 'has_middle_out_transform',
    title: 'middle_out',
    render: row => (row.has_middle_out_transform ? 'Yes' : 'No'),
    visible: true,
  },
  {
    key: 'user_prompt_prefix',
    title: 'User Prompt Prefix',
    render: row => row.user_prompt_prefix || 'N/A',
    visible: true,
  },
  {
    key: 'system_prompt_prefix',
    title: 'System Prompt Prefix',
    render: row => row.system_prompt_prefix || 'N/A',
    visible: true,
  },
  {
    key: 'cache_write_tokens',
    title: 'Cache Write Tokens',
    render: row => (row.cache_write_tokens ?? 0).toLocaleString(),
    visible: false,
  },
  {
    key: 'cache_hit_tokens',
    title: 'Cache Hit Tokens',
    render: row => (row.cache_hit_tokens ?? 0).toLocaleString(),
    visible: false,
  },
  {
    key: 'http_x_forwarded_for',
    title: 'IP Address',
    render: row => row.http_x_forwarded_for || 'N/A',
    visible: false,
  },
  {
    key: 'http_x_vercel_ip_city',
    title: 'City',
    render: row => row.http_x_vercel_ip_city || 'N/A',
    visible: false,
  },
  {
    key: 'http_x_vercel_ip_country',
    title: 'Country',
    render: row => row.http_x_vercel_ip_country || 'N/A',
    visible: false,
  },
  {
    key: 'http_x_vercel_ip_latitude',
    title: 'Latitude',
    render: row => (row.http_x_vercel_ip_latitude ?? NaN).toString(),
    visible: false,
  },
  {
    key: 'http_x_vercel_ip_longitude',
    title: 'Longitude',
    render: row => (row.http_x_vercel_ip_longitude ?? NaN).toString(),
    visible: false,
  },
  {
    key: 'system_prompt_length',
    title: 'System Prompt Length',
    render: row => (row.system_prompt_length ?? NaN).toString(),
    visible: false,
  },
  {
    key: 'has_tools',
    title: 'Has Tools',
    render: row => (row.has_tools ? 'Yes' : 'No'),
    visible: false,
  },
  {
    key: 'has_error',
    title: 'Has Error',
    render: row => (row.has_error ? 'Yes' : 'No'),
    visible: false,
  },
  {
    key: 'status_code',
    title: 'Status Code',
    render: row => (row.status_code != null ? row.status_code.toString() : 'N/A'),
    visible: false,
  },
  {
    key: 'finish_reason',
    title: 'Finish Reason',
    render: row => row.finish_reason || 'N/A',
    visible: false,
  },
  {
    key: 'streamed',
    title: 'Streamed',
    render: row => (row.streamed ? 'Yes' : 'No'),
    visible: false,
  },
  {
    key: 'cancelled',
    title: 'Cancelled',
    render: row => (row.cancelled ? 'Yes' : 'No'),
    visible: false,
  },
  {
    key: 'organization_id',
    title: 'Organization ID',
    render: row => row.organization_id || 'N/A',
    visible: false,
  },
  {
    key: 'project_id',
    title: 'Project ID',
    render: row => row.project_id || 'N/A',
    visible: false,
  },
  { key: 'provider', title: 'Provider', render: row => row.provider || 'N/A', visible: false },
  {
    key: 'inference_provider',
    title: 'Inference Provider',
    render: row => row.inference_provider || 'N/A',
    visible: false,
  },
  {
    key: 'is_byok',
    title: 'Is BYOK',
    render: row => (row.is_byok ? 'Yes' : 'No'),
    visible: false,
  },
  {
    key: 'is_user_byok',
    title: 'Is User BYOK',
    render: row => (row.is_user_byok ? 'Yes' : 'No'),
    visible: false,
  },
  {
    key: 'editor_name',
    title: 'Editor Name',
    render: row => row.editor_name || 'N/A',
    visible: false,
  },
  { key: 'id', title: 'ID', render: row => row.id, visible: false },
  { key: 'message_id', title: 'Message ID', render: row => row.message_id ?? '', visible: false },
  {
    key: 'session_id',
    title: 'Session ID',
    render: row => row.session_id || 'N/A',
    visible: true,
  },
  {
    key: 'upstream_id',
    title: 'Upstream ID',
    render: row => row.upstream_id || 'N/A',
    visible: false,
  },
];

export function UserAdminHeuristicAbuse({ id }: Pick<UserDetailProps, 'id'>) {
  const [timeGrouping, setTimeGrouping] = useState<'day' | 'week' | 'month'>('day');
  const [includeUserAgent, setIncludeUserAgent] = useState(false);
  const [includeModel, setIncludeModel] = useState(false);
  const [showRawData, setShowRawData] = useState(false);
  const [onlyAbuse, setOnlyAbuse] = useState(false);
  const [page, setPage] = useState(1);
  const [columns, setColumns] = useState(() => createMicrodollarUsageColumns());
  const [showColumnDropdown, setShowColumnDropdown] = useState(false);

  const buildGroupBy = () => {
    const dimensions: GroupByDimension[] = [timeGrouping];
    if (includeUserAgent) dimensions.push('userAgent');
    if (includeModel) dimensions.push('model');
    return dimensions.join(',');
  };

  const { data, error, isLoading } = useQuery<ApiResponse>({
    queryKey: ['admin-user-heuristic-analysis', id, buildGroupBy(), showRawData, onlyAbuse, page],
    queryFn: async (): Promise<ApiResponse> => {
      const endpoint = showRawData
        ? `/admin/api/users/heuristic-analysis/raw?userId=${id}&page=${page}&limit=40&onlyAbuse=${onlyAbuse}`
        : `/admin/api/users/heuristic-analysis/grouped?userId=${id}&groupBy=${buildGroupBy()}`;

      const response = await fetch(endpoint);
      if (!response.ok) {
        throw new Error('Failed to fetch heuristic analysis data');
      }

      return response.json() as Promise<ApiResponse>;
    },
  });

  const paginatedData = useMemo(() => {
    if (showRawData && data && 'pagination' in data) {
      return data;
    }
    return null;
  }, [data, showRawData]);

  const fmt = {
    currency: (d: number | null) => (d ? `$${d.toFixed(4)}` : '$0.0000'),
    number: (n: number | null) => (n ? n.toLocaleString() : '0'),
    date: (s: string | null) => (s ? new Date(s).toISOString() : 'N/A'),
  };

  const parseGroupKey = (groupKey: string) => {
    if (!groupKey || typeof groupKey !== 'string') {
      return {};
    }

    const parts = groupKey.split('|');
    const parsed: Record<string, string> = {};

    parts.forEach(part => {
      if (part && part.includes(':')) {
        const [key, value] = part.split(':');
        if (key && value !== undefined) {
          parsed[key] = value;
        }
      }
    });

    return parsed;
  };

  const getAbuseStatusColor = (_o: UsageForTableDisplay) => {
    // const result = isLikelyAbuse(o);
    // if (result === true) return '';
    // if (result === false) return 'text-gray-300';
    return '';
  };

  // Toggle column visibility
  const toggleColumnVisibility = (columnKey: keyof UsageForTableDisplay) => {
    setColumns(prevColumns =>
      prevColumns.map(col => (col.key === columnKey ? { ...col, visible: !col.visible } : col))
    );
  };

  // Get visible columns
  const visibleColumns = columns.filter(col => col.visible);

  // Toggle all columns
  const toggleAllColumns = (visible: boolean) => {
    setColumns(prevColumns => prevColumns.map(col => ({ ...col, visible })));
  };

  // Group data by dimensions (excluding likelyAbuse) for aggregated display
  const aggregateGroupedData = (groupedData: GroupedData[]) => {
    return Array.from(
      groupedData
        .filter(item => item && item.groupKey) // Filter out invalid items
        .reduce(
          (acc, item) => {
            const keyWithoutAbuse = item.groupKey
              .split('|')
              .filter(part => !part.startsWith('likelyAbuse:'))
              .join('|');

            if (!acc.has(keyWithoutAbuse)) {
              acc.set(keyWithoutAbuse, {
                groupKey: keyWithoutAbuse,
                totalCount: 0,
                totalCost: 0,
                totalInputTokens: 0,
                totalOutputTokens: 0,
                likelyAbuseCount: 0,
                notAbuseCount: 0,
                unknownCount: 0,
              });
            }

            const agg = toNonNullish(acc.get(keyWithoutAbuse));
            agg.totalCount += item.count || 0;
            agg.totalCost += item.costDollars || 0;
            agg.totalInputTokens += item.inputTokens || 0;
            agg.totalOutputTokens += item.outputTokens || 0;

            if (item.likelyAbuse === true) {
              agg.likelyAbuseCount += item.count || 0;
            } else if (item.likelyAbuse === false) {
              agg.notAbuseCount += item.count || 0;
            } else {
              agg.unknownCount += item.count || 0;
            }

            return acc;
          },
          new Map<
            string,
            {
              groupKey: string;
              totalCount: number;
              totalCost: number;
              totalInputTokens: number;
              totalOutputTokens: number;
              likelyAbuseCount: number;
              notAbuseCount: number;
              unknownCount: number;
            }
          >()
        )
        .values()
    );
  };

  const timeGroupingControls = (
    <div>
      <span className="text-sm font-medium">Time Grouping:</span>
      {(['day', 'week', 'month'] as const).map(option => (
        <label
          key={option}
          className="ml-4 inline-flex flex-row-reverse items-baseline gap-1.5 text-sm capitalize"
        >
          {option}

          <input
            type="radio"
            name="timeGrouping"
            value={option}
            checked={timeGrouping === option}
            onChange={e => setTimeGrouping(e.target.value as 'day' | 'week' | 'month')}
            className="h-4 w-4 self-center"
          />
        </label>
      ))}
    </div>
  );
  const otherGroupingControls = (
    <div className="flex gap-6">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={includeUserAgent}
          onChange={e => setIncludeUserAgent(e.target.checked)}
          className="h-4 w-4"
        />
        <span className="text-sm">Group by User Agent</span>
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={includeModel}
          onChange={e => setIncludeModel(e.target.checked)}
          className="h-4 w-4"
        />
        <span className="text-sm">Group by Model</span>
      </label>
    </div>
  );
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-xl font-semibold">
        Analysis of usage patterns for potential abuse detection
      </h2>
      <div className="italic">
        Note: abuse after 2025-08-21 12:30Z{' '}
        <a
          href="https://github.com/Kilo-Org/kilocode-backend/pull/2084"
          className="text-blue-600 underline hover:text-blue-300"
        >
          must have intentionally added the X-KiloCode-Version header!
        </a>
      </div>
      <div className="flex gap-4">
        <Button
          variant={showRawData ? 'default' : 'outline'}
          size="sm"
          onClick={() => {
            setShowRawData(!showRawData);
            setPage(1); // Reset pagination when switching views
          }}
        >
          {showRawData ? 'Show Grouped Data' : 'Show Raw Data (disable grouping)'}
        </Button>
        {showRawData && (
          <>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={onlyAbuse}
                onChange={e => {
                  setOnlyAbuse(e.target.checked);
                  setPage(1); // Reset pagination when filtering
                }}
                className="h-4 w-4"
              />
              <span className="text-sm">Only show abuse</span>
            </label>
            <DropdownMenu open={showColumnDropdown} onOpenChange={setShowColumnDropdown}>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  Columns ({visibleColumns.length}/{columns.length})
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="max-h-96 overflow-y-auto">
                <DropdownMenuItem onClick={() => toggleAllColumns(true)}>
                  <span className="text-sm">Show All</span>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => toggleAllColumns(false)}>
                  <span className="text-sm">Hide All</span>
                </DropdownMenuItem>
                <div className="my-1 border-t"></div>
                {columns.map(column => (
                  <DropdownMenuItem
                    key={String(column.key)}
                    onClick={() => toggleColumnVisibility(column.key)}
                  >
                    <label className="flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={column.visible}
                        onChange={() => toggleColumnVisibility(column.key)}
                        className="h-4 w-4"
                      />
                      <span className="text-sm">{column.title}</span>
                    </label>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>
      {!showRawData && timeGroupingControls}
      {!showRawData && otherGroupingControls}

      <div className="mt-2">
        {isLoading ? (
          <p className="text-muted-foreground text-sm">Loading heuristic analysis data...</p>
        ) : error ? (
          <p className="text-sm text-red-600">Failed to load heuristic analysis data</p>
        ) : !data || !('data' in data) || data.data.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No heuristic analysis data found for this user.
          </p>
        ) : showRawData ? (
          /* Raw Data Table */
          <>
            <div>
              <table className="w-max text-sm">
                <thead>
                  <tr className="border-b">
                    {visibleColumns.map(column => (
                      <th key={String(column.key)} className="px-1 text-left">
                        {column.title}
                      </th>
                    ))}
                    <th className="px-1 text-left">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.data as UsageForTableDisplay[]).map(item => (
                    <tr key={item.id} className="border-b">
                      {visibleColumns.map(column => (
                        <td
                          key={String(column.key)}
                          className={`px-1 ${column.key === 'abuse_classification' ? getAbuseStatusColor(item) : ''} max-w-xs truncate`}
                          title={
                            [
                              'user_prompt_prefix',
                              'system_prompt_prefix',
                              'http_user_agent',
                            ].includes(String(column.key))
                              ? (item[column.key] as string) || 'N/A'
                              : undefined
                          }
                        >
                          {column.render(item)}
                        </td>
                      ))}
                      <td className="px-1">
                        <CopyJsonButton rawData={item} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {paginatedData && (
              <div className="mt-4 flex">
                <p className="text-muted-foreground text-sm">
                  Showing page {paginatedData.pagination.page} of{' '}
                  {paginatedData.pagination.totalPages}
                </p>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    disabled={paginatedData.pagination.page <= 1}
                  >
                    Previous
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setPage(p => p + 1)}
                    disabled={paginatedData.pagination.page >= paginatedData.pagination.totalPages}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        ) : (
          /* Grouped Data Table */
          <div>
            <table className="w-max text-sm">
              <thead>
                <tr className="border-b">
                  <th className="px-1 text-left">
                    {timeGrouping.charAt(0).toUpperCase() + timeGrouping.slice(1)}
                  </th>
                  {includeUserAgent && <th className="px-1 text-left">User Agent</th>}
                  {includeModel && <th className="px-1 text-left">Model</th>}
                  <th className="px-1 text-right">Total Records</th>
                  <th className="px-1 text-right">Total Cost</th>
                  <th className="px-1 text-right">Input Tokens</th>
                  <th className="px-1 text-right">Output Tokens</th>
                  <th className="px-1 text-right">Likely Abuse</th>
                  <th className="px-1 text-right">Not Abuse</th>
                  <th className="px-1 text-right">Unknown</th>
                </tr>
              </thead>
              <tbody>
                {aggregateGroupedData(data.data as GroupedData[]).map(item => {
                  const parsed = parseGroupKey(item.groupKey);
                  return (
                    <tr key={item.groupKey} className="border-b">
                      <td className="px-1">{parsed[timeGrouping] || 'N/A'}</td>
                      {includeUserAgent && (
                        <td className="max-w-xs truncate px-1" title={parsed.userAgent || 'N/A'}>
                          {parsed.userAgent || 'N/A'}
                        </td>
                      )}
                      {includeModel && <td className="px-1">{parsed.model || 'N/A'}</td>}
                      <td className="px-1 text-right">{fmt.number(item.totalCount)}</td>
                      <td className="px-1 text-right">{fmt.currency(item.totalCost)}</td>
                      <td className="px-1 text-right">{fmt.number(item.totalInputTokens)}</td>
                      <td className="px-1 text-right">{fmt.number(item.totalOutputTokens)}</td>
                      <td className="px-1 text-right text-red-600">
                        {fmt.number(item.likelyAbuseCount)}
                      </td>
                      <td className="px-1 text-right text-green-600">
                        {fmt.number(item.notAbuseCount)}
                      </td>
                      <td className="text-muted-foreground px-1 text-right">
                        {fmt.number(item.unknownCount)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
