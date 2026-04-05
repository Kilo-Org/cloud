'use client';

import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { getInitialsFromName } from '@/lib/utils';
import type { AbuseExamplesResponse } from '../api/abuse/examples/route';

type BlockedFilter = 'all' | 'blocked' | 'unblocked';
type BeforeFilter = string; // ISO datetime string or empty for "now"
type UserMode = 'all' | 'trusted' | 'admin';
type AccountAgeFilter = 'all' | 'new_users' | 'old_users';
type CostFilter = 'all' | 'hide_free' | 'min_cost';
type PaymentStatusFilter = 'all' | 'paid_more' | 'paid_nothing' | 'paid_min_or_less';
type StytchValidationFilter = 'all' | 'has_stytch' | 'no_stytch';

const calculateInitialPageSize = () => {
  // Calculate based on viewport height heuristically
  // Assume each row is roughly 60px, leave space for header, filters, and pagination
  if (typeof window === 'undefined') return 25; // SSR fallback
  const availableHeight = window.innerHeight - 300; // Leave 300px for other UI elements
  const rowHeight = 60;
  const calculatedSize = Math.max(10, Math.min(100, Math.floor(availableHeight / rowHeight)));

  // Round to nearest common page size
  const pageSizes = [10, 25, 50, 100];
  return pageSizes.find(size => size >= calculatedSize) || pageSizes[pageSizes.length - 1];
};

type AbuseExampleTablesProps = {
  beforeFilter?: string;
  onBeforeFilterChange?: (value: string) => void;
};

export function AbuseExampleTables({
  beforeFilter: externalBeforeFilter,
  onBeforeFilterChange,
}: AbuseExampleTablesProps = {}) {
  const [blockedFilter, setBlockedFilter] = useState<BlockedFilter>('unblocked');
  const [internalBeforeFilter, setInternalBeforeFilter] = useState<BeforeFilter>('');

  // Use external filter if provided, otherwise use internal state
  const beforeFilter =
    externalBeforeFilter !== undefined ? externalBeforeFilter : internalBeforeFilter;
  const setBeforeFilter = onBeforeFilterChange || setInternalBeforeFilter;
  const [userMode, setUserMode] = useState<UserMode>('all');
  const [accountAgeFilter, setAccountAgeFilter] = useState<AccountAgeFilter>('all');
  const [costFilter, setCostFilter] = useState<CostFilter>('all');
  const [paymentStatusFilter, setPaymentStatusFilter] = useState<PaymentStatusFilter>('all');
  const [stytchValidationFilter, setStytchValidationFilter] =
    useState<StytchValidationFilter>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(25);

  // Initialize page size based on viewport height
  useEffect(() => {
    const initialPageSize = calculateInitialPageSize();
    setPageSize(initialPageSize);
  }, []);

  // Reset to page 1 when filters change
  useEffect(() => {
    setPage(1);
  }, [
    userMode,
    blockedFilter,
    beforeFilter,
    accountAgeFilter,
    costFilter,
    paymentStatusFilter,
    stytchValidationFilter,
    pageSize,
  ]);

  // Single query that changes based on the mode and pagination
  const { data, error, isLoading } = useQuery<AbuseExamplesResponse>({
    queryKey: [
      'abuse-examples',
      userMode,
      blockedFilter,
      beforeFilter,
      accountAgeFilter,
      costFilter,
      paymentStatusFilter,
      stytchValidationFilter,
      page,
      pageSize,
    ],
    queryFn: async () => {
      const trustedOnly = userMode === 'trusted';
      const adminOnly = userMode === 'admin';
      const response = await fetch(
        `/admin/api/abuse/examples?trusted_only=${trustedOnly}&admin_only=${adminOnly}&blocked_filter=${blockedFilter}&before_filter=${encodeURIComponent(beforeFilter)}&account_age_filter=${accountAgeFilter}&cost_filter=${costFilter}&payment_status_filter=${paymentStatusFilter}&stytch_validation_filter=${stytchValidationFilter}&page=${page}&pageSize=${pageSize}`
      );
      if (!response.ok) {
        throw new Error('Failed to fetch abuse examples');
      }
      return response.json() as Promise<AbuseExamplesResponse>;
    },
  });

  const formatDate = (dateString: string | null) => {
    if (!dateString) return 'N/A';
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;

    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;

    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
  };

  const truncateText = (text: string | null, maxLength: number = 100) => {
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
  };

  const getTableTitle = () => {
    if (userMode === 'trusted') {
      return 'Recent Trusted User Examples (t13d1812h1_5d04281c6031_ef7df7f74e48)';
    }
    if (userMode === 'admin') {
      return 'Recent Admin User Examples';
    }
    return 'Recent Abuse Examples';
  };

  if (isLoading) {
    return (
      <div className="space-y-2">
        <h3 className="text-lg font-semibold">{getTableTitle()}</h3>
        <p className="text-muted-foreground text-sm">Loading examples...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-2">
        <h3 className="text-lg font-semibold">{getTableTitle()}</h3>
        <p className="text-sm text-red-600">Failed to load examples</p>
      </div>
    );
  }

  if (!data?.examples) {
    return (
      <div className="space-y-2">
        <h3 className="text-lg font-semibold">{getTableTitle()}</h3>
        <p className="text-muted-foreground text-sm">No data available</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <label className="flex items-baseline gap-2 text-sm font-medium">
          User mode:
          <select
            value={userMode}
            onChange={e => setUserMode(e.target.value as UserMode)}
            className="rounded-md border border-gray-600 bg-gray-800 px-3 py-2 text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
          >
            <option value="all">All users</option>
            <option value="trusted">Trusted users</option>
            <option value="admin">Admin users</option>
          </select>
        </label>

        <label className="flex items-baseline gap-2 text-sm font-medium">
          User status:
          <select
            value={blockedFilter}
            onChange={e => setBlockedFilter(e.target.value as BlockedFilter)}
            className="rounded-md border border-gray-600 bg-gray-800 px-3 py-2 text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
          >
            <option value="all">All users</option>
            <option value="unblocked">Unblocked users</option>
            <option value="blocked">Blocked users</option>
          </select>
        </label>

        <div className="flex items-baseline gap-2">
          <label htmlFor="before-filter" className="text-sm font-medium">
            Before time:
          </label>
          <input
            id="before-filter"
            type="datetime-local"
            value={beforeFilter}
            onChange={e => setBeforeFilter(e.target.value)}
            className="rounded-md border border-gray-600 bg-gray-800 px-3 py-2 text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
            placeholder="Leave empty for now"
          />
        </div>

        <label className="flex items-baseline gap-2 text-sm font-medium">
          Account age:
          <select
            value={accountAgeFilter}
            onChange={e => setAccountAgeFilter(e.target.value as AccountAgeFilter)}
            className="rounded-md border border-gray-600 bg-gray-800 px-3 py-2 text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
          >
            <option value="all">Regardless of account age</option>
            <option value="new_users">Users created in past 7 days</option>
            <option value="old_users">Users created more than 7 days ago</option>
          </select>
        </label>

        <label className="flex items-baseline gap-2 text-sm font-medium">
          Cost filter:
          <select
            value={costFilter}
            onChange={e => setCostFilter(e.target.value as CostFilter)}
            className="rounded-md border border-gray-600 bg-gray-800 px-3 py-2 text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
          >
            <option value="all">Regardless of cost</option>
            <option value="hide_free">Hide free requests (cost &gt; 0)</option>
            <option value="min_cost">Requests of at least $0.10</option>
          </select>
        </label>

        <label className="flex items-baseline gap-2 text-sm font-medium">
          Payment status:
          <select
            value={paymentStatusFilter}
            onChange={e => setPaymentStatusFilter(e.target.value as PaymentStatusFilter)}
            className="rounded-md border border-gray-600 bg-gray-800 px-3 py-2 text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
          >
            <option value="all">Users regardless of payment status</option>
            <option value="paid_more">Users that have paid more than minimum top-up</option>
            <option value="paid_nothing">Users that have paid nothing</option>
            <option value="paid_min_or_less">
              Users that have paid no more than minimum top-up
            </option>
          </select>
        </label>

        <label className="flex items-baseline gap-2 text-sm font-medium">
          Stytch validation:
          <select
            value={stytchValidationFilter}
            onChange={e => setStytchValidationFilter(e.target.value as StytchValidationFilter)}
            className="rounded-md border border-gray-600 bg-gray-800 px-3 py-2 text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
          >
            <option value="all">Regardless of stytch validation</option>
            <option value="has_stytch">Users with has_validation_stytch = true</option>
            <option value="no_stytch">Users with has_validation_stytch = false</option>
          </select>
        </label>
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">{getTableTitle()}</h3>
          <div className="flex items-center gap-4">
            <span className="text-muted-foreground text-sm">
              Page {page} • Showing {data.examples.length} results
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="rounded-md border border-gray-600 bg-gray-800 px-3 py-1 text-sm font-medium text-white hover:bg-gray-700 focus:ring-2 focus:ring-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              >
                Previous
              </button>
              <button
                onClick={() => setPage(p => p + 1)}
                disabled={data.examples.length < pageSize}
                className="rounded-md border border-gray-600 bg-gray-800 px-3 py-1 text-sm font-medium text-white hover:bg-gray-700 focus:ring-2 focus:ring-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        </div>
        <table className="w-full rounded-lg border text-sm">
          <thead className="bg-gray-800">
            <tr className="border-b">
              <th className="px-3 py-2 text-left font-medium">View in Admin</th>
              <th className="px-3 py-2 text-left font-medium">System Prompt</th>
              <th className="px-3 py-2 text-left font-medium">User Prompt</th>
              <th className="px-3 py-2 text-left font-medium">Created</th>
              <th className="px-3 py-2 text-left font-medium">User Agent</th>
              <th className="px-3 py-2 text-left font-medium">JA4</th>
              <th className="px-3 py-2 text-left font-medium">Model</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {data.examples.map(example => (
              <tr key={example.id} className="hover:bg-gray-800">
                <td className="px-3">
                  <Link
                    href={`/admin/users/${encodeURIComponent(example.user.id)}`}
                    className="flex items-center gap-2 py-1"
                    title={`${example.user.google_user_name ?? 'Unknown'} • ${example.kilo_user_id}`}
                  >
                    <Avatar className="h-6 w-6 shrink-0">
                      <AvatarImage
                        src={example.user.google_user_image_url}
                        alt={example.user.google_user_name ?? ''}
                      />
                      <AvatarFallback>
                        {getInitialsFromName(example.user.google_user_name ?? 'U')}
                      </AvatarFallback>
                    </Avatar>
                    <span className="max-w-[220px] truncate">
                      {example.google_user_email || 'N/A'}
                    </span>
                    {example.blocked_reason ? (
                      <span className="inline-flex items-center rounded-full bg-red-900 px-2 py-1 text-xs font-medium text-red-300">
                        Blocked
                      </span>
                    ) : null}
                  </Link>
                </td>
                <td className="px-3 py-1">
                  <span
                    className="block max-w-[250px] truncate"
                    title={example.system_prompt_prefix || 'N/A'}
                  >
                    {truncateText(example.system_prompt_prefix, 50)}
                  </span>
                </td>
                <td className="px-3 py-1">
                  <span
                    className="block max-w-[250px] truncate"
                    title={example.user_prompt_prefix || 'N/A'}
                  >
                    {truncateText(example.user_prompt_prefix, 50)}
                  </span>
                </td>
                <td className="px-3 py-1 whitespace-nowrap">{formatDate(example.created_at)}</td>
                <td className="px-3 py-1">
                  <span
                    className="block max-w-[200px] truncate"
                    title={example.http_user_agent || 'N/A'}
                  >
                    {truncateText(example.http_user_agent, 30)}
                  </span>
                </td>
                <td className="px-3 py-1">
                  <span className={example.is_ja4_whitelisted ? 'bg-blue-500 text-white' : ''}>
                    {example.http_x_vercel_ja4_digest || 'N/A'}
                  </span>
                </td>
                <td className="px-3 py-1 whitespace-nowrap">{example.model || 'N/A'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
