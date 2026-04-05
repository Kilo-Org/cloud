'use client';

import { useCallback, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';
import AdminPage from '@/app/admin/components/AdminPage';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { RefreshCw } from 'lucide-react';
import { useRawTRPCClient } from '@/lib/trpc/utils';
import {
  sortExternalPullRequests,
  sortClosedPullRequests,
  type ExternalPrSort,
  type ExternalPrSortKey,
  type ClosedPrSort,
  type ClosedPrSortKey,
} from '@/app/admin/community-prs/sorting';

const ALL_REPOS = ['kilocode', 'cloud', 'kilo-marketplace', 'kilocode-legacy'] as const;
type RepoFilterId = (typeof ALL_REPOS)[number];

const REPO_LABELS: Record<RepoFilterId, string> = {
  kilocode: 'kilocode',
  cloud: 'cloud',
  'kilo-marketplace': 'marketplace',
  'kilocode-legacy': 'legacy',
};

const breadcrumbs = (
  <BreadcrumbItem>
    <BreadcrumbPage>Community PRs</BreadcrumbPage>
  </BreadcrumbItem>
);

export default function GithubPrCountsAdminPage() {
  const trpcClient = useRawTRPCClient();

  const [includeDrafts, setIncludeDrafts] = useState(false);

  const [selectedRepos, setSelectedRepos] = useState<ReadonlySet<RepoFilterId>>(new Set(ALL_REPOS));

  const toggleRepo = useCallback((repo: RepoFilterId) => {
    setSelectedRepos(prev => {
      // If all are currently selected, clicking one repo selects only that repo
      if (prev.size === ALL_REPOS.length) {
        return new Set([repo]);
      }
      const next = new Set(prev);
      if (next.has(repo)) {
        next.delete(repo);
      } else {
        next.add(repo);
      }
      // If nothing selected, revert to all
      if (next.size === 0) return new Set(ALL_REPOS);
      return next;
    });
  }, []);

  const selectAllRepos = useCallback(() => {
    setSelectedRepos(new Set(ALL_REPOS));
  }, []);

  const allSelected = selectedRepos.size === ALL_REPOS.length;
  const reposArray = useMemo(() => [...selectedRepos].sort(), [selectedRepos]);

  const [externalSort, setExternalSort] = useState<ExternalPrSort>({
    key: 'ageDays',
    direction: 'desc',
  });

  const [closedSort, setClosedSort] = useState<ClosedPrSort>({
    key: 'displayDate',
    direction: 'desc',
  });

  const toggleSort = useCallback((key: ExternalPrSortKey) => {
    setExternalSort(prev => {
      if (prev.key !== key) return { key, direction: 'desc' };
      return { key, direction: prev.direction === 'desc' ? 'asc' : 'desc' };
    });
  }, []);

  const toggleClosedSort = useCallback((key: ClosedPrSortKey) => {
    setClosedSort(prev => {
      if (prev.key !== key) return { key, direction: 'desc' };
      return { key, direction: prev.direction === 'desc' ? 'asc' : 'desc' };
    });
  }, []);

  const { data, error, isFetching, isLoading, refetch } = useQuery({
    queryKey: [
      'admin',
      'github',
      'community-prs',
      'open-summary',
      { includeDrafts, repos: reposArray },
    ],
    queryFn: async () =>
      trpcClient.admin.github.getKilocodeOpenPullRequestsSummary.query({
        includeDrafts,
        repos: reposArray,
      }),
    staleTime: 60_000,
  });

  const {
    data: closedData,
    error: closedError,
    isLoading: closedIsLoading,
    refetch: closedRefetch,
  } = useQuery({
    queryKey: ['admin', 'github', 'community-prs', 'closed', { repos: reposArray }],
    queryFn: async () =>
      trpcClient.admin.github.getKilocodeRecentlyClosedExternalPRs.query({
        repos: reposArray,
      }),
    staleTime: 60_000,
  });

  const handleRefresh = useCallback(() => {
    void refetch();
    void closedRefetch();
  }, [refetch, closedRefetch]);

  const updatedAtLabel = data?.updatedAt ? new Date(data.updatedAt).toLocaleString() : null;

  const externalRows = useMemo(() => {
    const rows = data?.externalOpenPullRequestsList ?? [];
    return sortExternalPullRequests(rows, externalSort);
  }, [externalSort, data?.externalOpenPullRequestsList]);

  const closedRows = useMemo(() => {
    const rows = closedData?.prs ?? [];
    return sortClosedPullRequests(rows, closedSort);
  }, [closedSort, closedData]);

  const urgencyStyle = useCallback((ageDays: number) => {
    if (ageDays > 14) {
      return {
        badge: 'border-red-600/40 bg-red-600/10 text-red-200',
        rowBorder: 'border-l-red-500/60',
        label: 'High',
      };
    }
    if (ageDays >= 7) {
      return {
        badge: 'border-yellow-600/40 bg-yellow-600/10 text-yellow-200',
        rowBorder: 'border-l-yellow-500/60',
        label: 'Medium',
      };
    }
    return {
      badge: 'border-emerald-600/40 bg-emerald-600/10 text-emerald-200',
      rowBorder: 'border-l-emerald-500/60',
      label: 'Low',
    };
  }, []);

  const externalPrHref = useCallback(
    (pr: { number: number; repo: string; url?: string | null }) => {
      if (pr.url) return pr.url;
      return `https://github.com/Kilo-Org/${pr.repo}/pull/${pr.number}`;
    },
    []
  );

  const reviewStatusLabel = useCallback((reviewStatus: string) => {
    if (reviewStatus === 'changes_requested') return 'Changes requested';
    if (reviewStatus === 'approved') return 'Approved';
    if (reviewStatus === 'commented') return 'Commented';
    return '-';
  }, []);

  return (
    <AdminPage
      breadcrumbs={breadcrumbs}
      buttons={
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isFetching}>
          <RefreshCw className={`mr-2 h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      }
    >
      <div className="flex w-full flex-col gap-y-6">
        <div>
          <h2 className="text-2xl font-bold">Community PRs</h2>
          <p className="text-muted-foreground mt-1">
            Counts are split by whether the PR author is a member of the GitHub org
            &quot;Kilo-Org&quot;.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-sm font-medium">Repos:</span>
          <Button
            type="button"
            variant={allSelected ? 'default' : 'outline'}
            size="sm"
            onClick={selectAllRepos}
          >
            All
          </Button>
          {ALL_REPOS.map(repo => (
            <Button
              key={repo}
              type="button"
              variant={selectedRepos.has(repo) ? 'default' : 'outline'}
              size="sm"
              onClick={() => toggleRepo(repo)}
            >
              {REPO_LABELS[repo]}
            </Button>
          ))}
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <div className="text-muted-foreground">Loading GitHub PR counts…</div>
          </div>
        ) : error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4">
            <p className="text-sm text-red-800">Error loading data: {error.message}</p>
          </div>
        ) : data ? (
          <div className="flex flex-col gap-6">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="bg-background rounded-lg border p-4">
                <div className="text-muted-foreground text-xs">Total open PRs</div>
                <div className="mt-2 text-3xl font-semibold">{data.totalOpenPullRequests}</div>
              </div>

              <div className="bg-background rounded-lg border p-4">
                <div className="text-muted-foreground text-xs">Team open PRs</div>
                <div className="mt-2 text-3xl font-semibold">{data.teamOpenPullRequests}</div>
              </div>

              <div className="bg-background rounded-lg border p-4">
                <div className="text-muted-foreground text-xs">Community open PRs</div>
                <div className="mt-2 text-3xl font-semibold">{data.externalOpenPullRequests}</div>
              </div>

              <div className="bg-background rounded-lg border p-4">
                <div className="text-muted-foreground text-xs">Last updated</div>
                <div className="mt-2 text-sm font-medium">{updatedAtLabel ?? '—'}</div>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="bg-background rounded-lg border p-4">
                <div className="text-muted-foreground text-xs">Community PRs merged this week</div>
                <div className="mt-2 text-3xl font-semibold">
                  {closedData?.thisWeekMergedCount ?? '—'}
                </div>
                {closedData?.weekStart ? (
                  <div className="text-muted-foreground mt-1 text-xs">
                    Week of {new Date(closedData.weekStart).toLocaleDateString()}
                  </div>
                ) : null}
              </div>

              <div className="bg-background rounded-lg border p-4">
                <div className="text-muted-foreground text-xs">
                  Community PRs closed (unmerged) this week
                </div>
                <div className="mt-2 text-3xl font-semibold">
                  {closedData?.thisWeekClosedCount ?? '—'}
                </div>
                {closedData?.weekStart ? (
                  <div className="text-muted-foreground mt-1 text-xs">
                    Week of {new Date(closedData.weekStart).toLocaleDateString()}
                  </div>
                ) : null}
              </div>
            </div>

            <div className="bg-background rounded-lg border p-4">
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1">
                  <h3 className="text-lg font-semibold">Community open PRs</h3>
                  <p className="text-muted-foreground text-sm">
                    Sorted by urgency by default (oldest first). &quot;Team commented&quot; checks
                    both issue comments and review comments by Kilo team members.
                  </p>
                </div>

                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={includeDrafts}
                    onCheckedChange={checked => setIncludeDrafts(Boolean(checked))}
                  />
                  Include draft PRs
                </label>

                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant={externalSort.key === 'ageDays' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => toggleSort('ageDays')}
                  >
                    Age {externalSort.key === 'ageDays' ? `(${externalSort.direction})` : ''}
                  </Button>
                  <Button
                    type="button"
                    variant={externalSort.key === 'repo' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => toggleSort('repo')}
                  >
                    Repo {externalSort.key === 'repo' ? `(${externalSort.direction})` : ''}
                  </Button>
                  <Button
                    type="button"
                    variant={externalSort.key === 'reviewStatus' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => toggleSort('reviewStatus')}
                  >
                    Review status{' '}
                    {externalSort.key === 'reviewStatus' ? `(${externalSort.direction})` : ''}
                  </Button>
                  <Button
                    type="button"
                    variant={externalSort.key === 'teamCommented' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => toggleSort('teamCommented')}
                  >
                    Team commented{' '}
                    {externalSort.key === 'teamCommented' ? `(${externalSort.direction})` : ''}
                  </Button>
                </div>

                {externalRows.length === 0 ? (
                  <div className="text-muted-foreground py-8 text-sm">No community open PRs.</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-sm">
                      <thead>
                        <tr className="text-muted-foreground border-b">
                          <th className="px-2 py-2 text-left font-medium">PR</th>
                          <th className="px-2 py-2 text-left font-medium">Repo</th>
                          <th className="px-2 py-2 text-left font-medium">Author</th>
                          <th className="px-2 py-2 text-left font-medium">Age</th>
                          <th className="px-2 py-2 text-left font-medium">Review status</th>
                          <th className="px-2 py-2 text-left font-medium">Team commented</th>
                          <th className="px-2 py-2 text-left font-medium">Urgency</th>
                        </tr>
                      </thead>
                      <tbody>
                        {externalRows.map(pr => {
                          const urgency = urgencyStyle(pr.ageDays);
                          const prHref = externalPrHref(pr);
                          return (
                            <tr
                              key={`${pr.repo}:${pr.number}`}
                              className={`border-b border-l-4 ${urgency.rowBorder} hover:bg-muted/30`}
                            >
                              <td className="px-2 py-3 align-top">
                                <a
                                  href={prHref}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-primary hover:underline"
                                >
                                  #{pr.number} <span className="text-foreground">{pr.title}</span>
                                </a>
                              </td>
                              <td className="px-2 py-3 align-top">
                                <span className="text-muted-foreground text-xs">
                                  {REPO_LABELS[pr.repo as RepoFilterId] ?? pr.repo}
                                </span>
                              </td>
                              <td className="px-2 py-3 align-top">
                                <span className="font-medium">{pr.authorLogin}</span>
                              </td>
                              <td className="px-2 py-3 align-top">
                                <div className="flex flex-col">
                                  <span className="font-medium">{pr.ageDays}d</span>
                                  <span className="text-muted-foreground text-xs">
                                    {new Date(pr.createdAt).toLocaleDateString()}
                                  </span>
                                </div>
                              </td>
                              <td className="px-2 py-3 align-top">
                                <span
                                  className={`font-medium ${pr.reviewStatus === 'approved' ? 'text-emerald-200' : ''}`}
                                >
                                  {reviewStatusLabel(pr.reviewStatus)}
                                </span>
                              </td>
                              <td className="px-2 py-3 align-top">
                                <span
                                  className={
                                    pr.teamCommented ? 'text-emerald-200' : 'text-muted-foreground'
                                  }
                                >
                                  {pr.teamCommented ? 'Yes' : 'No'}
                                </span>
                              </td>
                              <td className="px-2 py-3 align-top">
                                <span
                                  className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs ${urgency.badge}`}
                                >
                                  {urgency.label}
                                </span>
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

            <div className="bg-background rounded-lg border p-4">
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1">
                  <h3 className="text-lg font-semibold">Recently Closed PRs (External)</h3>
                  <p className="text-muted-foreground text-sm">
                    Recently closed PRs from external contributors (merged or closed without
                    merging), sorted by date (newest first).
                  </p>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant={closedSort.key === 'displayDate' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => toggleClosedSort('displayDate')}
                  >
                    Date {closedSort.key === 'displayDate' ? `(${closedSort.direction})` : ''}
                  </Button>
                  <Button
                    type="button"
                    variant={closedSort.key === 'repo' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => toggleClosedSort('repo')}
                  >
                    Repo {closedSort.key === 'repo' ? `(${closedSort.direction})` : ''}
                  </Button>
                  <Button
                    type="button"
                    variant={closedSort.key === 'status' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => toggleClosedSort('status')}
                  >
                    Status {closedSort.key === 'status' ? `(${closedSort.direction})` : ''}
                  </Button>
                </div>

                {closedIsLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <div className="text-muted-foreground">Loading closed PRs…</div>
                  </div>
                ) : closedError ? (
                  <div className="rounded-lg border border-red-200 bg-red-50 p-4">
                    <p className="text-sm text-red-800">
                      Error loading data: {closedError.message}
                    </p>
                  </div>
                ) : closedRows.length === 0 ? (
                  <div className="text-muted-foreground py-8 text-sm">No recently closed PRs.</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-sm">
                      <thead>
                        <tr className="text-muted-foreground border-b">
                          <th className="px-2 py-2 text-left font-medium">PR</th>
                          <th className="px-2 py-2 text-left font-medium">Repo</th>
                          <th className="px-2 py-2 text-left font-medium">Author</th>
                          <th className="px-2 py-2 text-left font-medium">Date</th>
                          <th className="px-2 py-2 text-left font-medium">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {closedRows.map(pr => {
                          const statusLabel = pr.status === 'merged' ? 'Merged' : 'Closed';
                          const statusBadgeClassName =
                            pr.status === 'merged'
                              ? 'border-emerald-600/40 bg-emerald-600/10 text-emerald-200'
                              : 'border-red-600/40 bg-red-600/10 text-red-200';

                          return (
                            <tr
                              key={`${pr.repo}:${pr.number}`}
                              className="hover:bg-muted/30 border-b"
                            >
                              <td className="px-2 py-3 align-top">
                                <a
                                  href={pr.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-primary hover:underline"
                                >
                                  #{pr.number} <span className="text-foreground">{pr.title}</span>
                                </a>
                              </td>
                              <td className="px-2 py-3 align-top">
                                <span className="text-muted-foreground text-xs">
                                  {REPO_LABELS[pr.repo as RepoFilterId] ?? pr.repo}
                                </span>
                              </td>
                              <td className="px-2 py-3 align-top">
                                <span className="font-medium">{pr.authorLogin}</span>
                              </td>
                              <td className="px-2 py-3 align-top">
                                <div className="flex flex-col">
                                  <span className="font-medium">
                                    {new Date(pr.displayDate).toLocaleDateString()}
                                  </span>
                                  <span className="text-muted-foreground text-xs">
                                    {new Date(pr.displayDate).toLocaleTimeString()}
                                  </span>
                                </div>
                              </td>
                              <td className="px-2 py-3 align-top">
                                <Badge variant="outline" className={statusBadgeClassName}>
                                  {statusLabel}
                                </Badge>
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
          </div>
        ) : null}
      </div>
    </AdminPage>
  );
}
