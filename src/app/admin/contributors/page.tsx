'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import AdminPage from '../components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SortableButton } from '../components/SortableButton';
import {
  AlertCircle,
  ChevronLeft,
  Check,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Loader2,
  Plus,
  RefreshCcw,
  UserPlus,
} from 'lucide-react';
import { toast } from 'sonner';

const contributorTiers = ['contributor', 'ambassador', 'champion'] as const;
type ContributorTier = (typeof contributorTiers)[number];
type DrillInWindow = 'all_time' | 'rolling_30_days';

const PAGE_SIZE = 10;

const breadcrumbs = (
  <>
    <BreadcrumbItem>
      <BreadcrumbPage>Contributor Champions</BreadcrumbPage>
    </BreadcrumbItem>
  </>
);

type DrillInState = {
  contributorId: string;
  githubLogin: string;
  window: DrillInWindow;
};

type EnrollmentState = {
  contributorId: string;
  githubLogin: string;
  tier: ContributorTier;
};

type SortConfig<T extends string> = {
  field: T;
  direction: 'asc' | 'desc';
} | null;

type EnrolledSortField =
  | 'githubLogin'
  | 'email'
  | 'contributionsAllTime'
  | 'contributions30d'
  | 'enrolledTier'
  | 'enrolledAt';

type ReviewSortField =
  | 'githubLogin'
  | 'email'
  | 'contributionsAllTime'
  | 'contributions30d'
  | 'tier';

const KILO_ACCOUNT_FILTERS = ['all', 'yes', 'no'] as const;
type KiloAccountFilter = (typeof KILO_ACCOUNT_FILTERS)[number];

function parseKiloAccountFilter(value: string): KiloAccountFilter {
  if (value === 'all' || value === 'yes' || value === 'no') return value;
  return 'all';
}

type EnrolledFilters = {
  githubLogin: string;
  email: string;
  enrolledTier: string;
  hasKiloAccount: KiloAccountFilter;
};

type ReviewFilters = {
  githubLogin: string;
  email: string;
  tier: string;
  hasKiloAccount: KiloAccountFilter;
};

type LeaderboardRow = {
  contributorId: string;
  githubLogin: string;
  githubProfileUrl: string;
  email: string | null;
  linkedUserId: string | null;
  linkedUserName: string | null;
  contributionsAllTime: number;
  contributions30d: number;
  suggestedTier: ContributorTier | null;
  selectedTier: ContributorTier | null;
  enrolledTier: ContributorTier | null;
  enrolledAt: string | null;
  creditAmountUsd: number | null;
  creditsLastGrantedAt: string | null;
  linkedKiloUserId: string | null;
};

const TIER_CREDIT_DISPLAY: Record<ContributorTier, string> = {
  contributor: 'No monthly credits',
  ambassador: '$50/month in Kilo Credits',
  champion: '$150/month in Kilo Credits',
};

function normalizeTier(value: string): ContributorTier | null {
  if (value === 'contributor' || value === 'ambassador' || value === 'champion') {
    return value;
  }
  return null;
}

function TierDisplay({ tier }: { tier: ContributorTier | null }) {
  if (!tier) {
    return <span className="text-muted-foreground">—</span>;
  }

  return <Badge variant="outline">{tier}</Badge>;
}

function ContributionCountButton({
  count,
  onClick,
}: {
  count: number;
  onClick: () => void;
}) {
  return (
    <Button variant="link" className="h-auto p-0" onClick={onClick}>
      {count}
    </Button>
  );
}

function EmailCell({
  email,
  linkedUserId,
  linkedUserName,
}: {
  email: string | null;
  linkedUserId: string | null;
  linkedUserName: string | null;
}) {
  if (linkedUserId) {
    return (
      <Link
        href={`/admin/users/${encodeURIComponent(linkedUserId)}`}
        className="hover:underline"
      >
        {email ?? linkedUserName ?? 'Linked Kilo account'}
      </Link>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <span>{email ?? '—'}</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <AlertCircle className="text-muted-foreground h-4 w-4 shrink-0" />
        </TooltipTrigger>
        <TooltipContent>No Kilo account</TooltipContent>
      </Tooltip>
    </div>
  );
}

function matchesKiloAccount(linkedUserId: string | null, filter: KiloAccountFilter): boolean {
  if (filter === 'all') return true;
  return filter === 'yes' ? linkedUserId !== null : linkedUserId === null;
}

function TablePagination({
  page,
  totalPages,
  total,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  const startItem = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const endItem = Math.min(page * PAGE_SIZE, total);
  const hasPrev = page > 1;
  const hasNext = page < totalPages;

  return (
    <div className="flex items-center justify-between px-2 py-3">
      <div className="flex items-center justify-center text-sm font-medium whitespace-nowrap">
        Showing {startItem}–{endItem} of {total}
      </div>
      <div className="flex items-center space-x-2">
        <p className="text-sm font-medium">
          Page {page} of {totalPages || 1}
        </p>
        <Button
          variant="outline"
          className="hidden h-8 w-8 p-0 lg:flex"
          onClick={() => onPageChange(1)}
          disabled={!hasPrev}
        >
          <span className="sr-only">Go to first page</span>
          <ChevronsLeft className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          className="h-8 w-8 p-0"
          onClick={() => onPageChange(page - 1)}
          disabled={!hasPrev}
        >
          <span className="sr-only">Go to previous page</span>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          className="h-8 w-8 p-0"
          onClick={() => onPageChange(page + 1)}
          disabled={!hasNext}
        >
          <span className="sr-only">Go to next page</span>
          <ChevronRight className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          className="hidden h-8 w-8 p-0 lg:flex"
          onClick={() => onPageChange(totalPages)}
          disabled={!hasNext}
        >
          <span className="sr-only">Go to last page</span>
          <ChevronsRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function useTableSort<T extends string>(defaultField?: T, defaultDirection?: 'asc' | 'desc') {
  const [sortConfig, setSortConfig] = useState<SortConfig<T>>(
    defaultField ? { field: defaultField, direction: defaultDirection ?? 'desc' } : null
  );

  const onSort = useCallback((field: T) => {
    setSortConfig(prev => {
      if (!prev || prev.field !== field) return { field, direction: 'desc' };
      return { field, direction: prev.direction === 'desc' ? 'asc' : 'desc' };
    });
  }, []);

  return { sortConfig, onSort };
}

function matchesFilter(value: string | null | undefined, filter: string): boolean {
  if (!filter) return true;
  return (value ?? '').toLowerCase().includes(filter.toLowerCase());
}

function compareValues(
  a: string | number | null | undefined,
  b: string | number | null | undefined,
  direction: 'asc' | 'desc'
): number {
  const aVal = a ?? '';
  const bVal = b ?? '';
  const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
  return direction === 'asc' ? cmp : -cmp;
}

function sortRows<T>(
  rows: T[],
  sortConfig: SortConfig<string>,
  accessor: (row: T, field: string) => string | number | null | undefined
): T[] {
  if (!sortConfig) return rows;
  return [...rows].sort((a, b) =>
    compareValues(
      accessor(a, sortConfig.field),
      accessor(b, sortConfig.field),
      sortConfig.direction
    )
  );
}

function paginateRows<T>(rows: T[], page: number): T[] {
  const start = (page - 1) * PAGE_SIZE;
  return rows.slice(start, start + PAGE_SIZE);
}

export default function ContributorChampionsAdminPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [drillInState, setDrillInState] = useState<DrillInState | null>(null);
  const [enrollmentState, setEnrollmentState] = useState<EnrollmentState | null>(null);
  const [hasAutoSynced, setHasAutoSynced] = useState(false);

  // Enrolled table state
  const [enrolledPage, setEnrolledPage] = useState(1);
  const [enrolledFilters, setEnrolledFilters] = useState<EnrolledFilters>({
    githubLogin: '',
    email: '',
    enrolledTier: '',
    hasKiloAccount: 'all',
  });
  const enrolledSort = useTableSort<EnrolledSortField>('contributionsAllTime');

  // Review table state
  const [reviewPage, setReviewPage] = useState(1);
  const [reviewFilters, setReviewFilters] = useState<ReviewFilters>({
    githubLogin: '',
    email: '',
    tier: '',
    hasKiloAccount: 'all',
  });
  const reviewSort = useTableSort<ReviewSortField>('contributionsAllTime');

  // Manual enrollment state
  const [manualEnrollOpen, setManualEnrollOpen] = useState(false);
  const [manualEmail, setManualEmail] = useState('');
  const [manualGithub, setManualGithub] = useState('');
  const [manualTier, setManualTier] = useState<ContributorTier>('contributor');
  const [selectedKiloUser, setSelectedKiloUser] = useState<{
    userId: string;
    email: string;
    name: string | null;
  } | null>(null);

  const reviewQuery = useQuery(trpc.admin.contributorChampions.reviewQueue.queryOptions());
  const enrolledQuery = useQuery(trpc.admin.contributorChampions.enrolledList.queryOptions());

  const drillInQuery = useQuery({
    ...trpc.admin.contributorChampions.contributionDrillIn.queryOptions({
      contributorId: drillInState?.contributorId ?? '',
      window: drillInState?.window ?? 'all_time',
    }),
    enabled: drillInState !== null,
  });

  const userSearchResults = useQuery({
    ...trpc.admin.contributorChampions.searchKiloUsers.queryOptions({
      query: manualEmail,
    }),
    enabled: manualEmail.length >= 2 && !selectedKiloUser,
  });

  const manualEnrollMutation = useMutation(
    trpc.admin.contributorChampions.manualEnroll.mutationOptions({
      onSuccess: () => {
        toast.success('Contributor manually enrolled');
        setManualEnrollOpen(false);
        setManualEmail('');
        setManualGithub('');
        setManualTier('contributor');
        setSelectedKiloUser(null);
        refreshContributorQueries();
      },
      onError: error => {
        toast.error(`Failed to enroll: ${error.message}`);
      },
    })
  );

  const refreshContributorQueries = () => {
    void queryClient.invalidateQueries({
      queryKey: trpc.admin.contributorChampions.reviewQueue.queryKey(),
    });
    void queryClient.invalidateQueries({
      queryKey: trpc.admin.contributorChampions.enrolledList.queryKey(),
    });
  };

  const setSelectedTierMutation = useMutation(
    trpc.admin.contributorChampions.setSelectedTier.mutationOptions({
      onSuccess: () => {
        refreshContributorQueries();
      },
      onError: (error: { message: string }) => {
        toast.error(`Failed to update tier: ${error.message}`);
      },
    })
  );

  const enrollMutation = useMutation(
    trpc.admin.contributorChampions.enroll.mutationOptions({
      onSuccess: () => {
        toast.success('Contributor enrolled');
        setEnrollmentState(null);
        refreshContributorQueries();
      },
      onError: (error: { message: string }) => {
        toast.error(`Failed to enroll contributor: ${error.message}`);
      },
    })
  );

  const syncMutation = useMutation(
    trpc.admin.contributorChampions.syncNow.mutationOptions({
      onSuccess: () => {
        toast.success('Contributor data synced');
        refreshContributorQueries();
      },
      onError: (error: { message: string }) => {
        toast.error(`Sync failed: ${error.message}`);
      },
    })
  );

  useEffect(() => {
    if (hasAutoSynced || syncMutation.isPending) {
      return;
    }

    setHasAutoSynced(true);
    void syncMutation.mutateAsync();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- syncMutation is a stable object from useMutation; listing it causes infinite re-renders
  }, [hasAutoSynced]);

  const isLoadingTables = reviewQuery.isLoading || enrolledQuery.isLoading;

  // Enrolled: filter -> sort -> paginate
  const enrolledFiltered = useMemo(() => {
    const rows: LeaderboardRow[] = enrolledQuery.data ?? [];
    return rows.filter(
      row =>
        matchesFilter(row.githubLogin, enrolledFilters.githubLogin) &&
        matchesFilter(row.email, enrolledFilters.email) &&
        (enrolledFilters.enrolledTier === '' || row.enrolledTier === enrolledFilters.enrolledTier) &&
        matchesKiloAccount(row.linkedUserId, enrolledFilters.hasKiloAccount)
    );
  }, [enrolledQuery.data, enrolledFilters]);

  const enrolledSorted = useMemo(
    () =>
      sortRows(enrolledFiltered, enrolledSort.sortConfig, (row, field) => {
        switch (field as EnrolledSortField) {
          case 'githubLogin':
            return row.githubLogin.toLowerCase();
          case 'email':
            return (row.email ?? '').toLowerCase();
          case 'contributionsAllTime':
            return row.contributionsAllTime;
          case 'contributions30d':
            return row.contributions30d;
          case 'enrolledTier':
            return row.enrolledTier ?? '';
          case 'enrolledAt':
            return row.enrolledAt ?? '';
          default:
            return '';
        }
      }),
    [enrolledFiltered, enrolledSort.sortConfig]
  );

  const enrolledTotalPages = Math.max(1, Math.ceil(enrolledSorted.length / PAGE_SIZE));
  const enrolledPageRows = useMemo(
    () => paginateRows(enrolledSorted, enrolledPage),
    [enrolledSorted, enrolledPage]
  );

  // Reset enrolled page when filters/sort change
  useEffect(() => {
    setEnrolledPage(1);
  }, [enrolledFilters, enrolledSort.sortConfig]);

  // Review: filter -> sort -> paginate
  const reviewFiltered = useMemo(() => {
    const rows: LeaderboardRow[] = reviewQuery.data ?? [];
    return rows.filter(row => {
      const effectiveTier = row.selectedTier ?? row.suggestedTier;
      return (
        matchesFilter(row.githubLogin, reviewFilters.githubLogin) &&
        matchesFilter(row.email, reviewFilters.email) &&
        (reviewFilters.tier === '' || effectiveTier === reviewFilters.tier) &&
        matchesKiloAccount(row.linkedUserId, reviewFilters.hasKiloAccount)
      );
    });
  }, [reviewQuery.data, reviewFilters]);

  const reviewSorted = useMemo(
    () =>
      sortRows(reviewFiltered, reviewSort.sortConfig, (row, field) => {
        switch (field as ReviewSortField) {
          case 'githubLogin':
            return row.githubLogin.toLowerCase();
          case 'email':
            return (row.email ?? '').toLowerCase();
          case 'contributionsAllTime':
            return row.contributionsAllTime;
          case 'contributions30d':
            return row.contributions30d;
          case 'tier':
            return (row.selectedTier ?? row.suggestedTier) ?? '';
          default:
            return '';
        }
      }),
    [reviewFiltered, reviewSort.sortConfig]
  );

  const reviewTotalPages = Math.max(1, Math.ceil(reviewSorted.length / PAGE_SIZE));
  const reviewPageRows = useMemo(
    () => paginateRows(reviewSorted, reviewPage),
    [reviewSorted, reviewPage]
  );

  // Reset review page when filters/sort change
  useEffect(() => {
    setReviewPage(1);
  }, [reviewFilters, reviewSort.sortConfig]);

  return (
    <AdminPage
      breadcrumbs={breadcrumbs}
      buttons={
        <Button
          variant="outline"
          size="sm"
          disabled={syncMutation.isPending}
          onClick={() => void syncMutation.mutateAsync()}
        >
          {syncMutation.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCcw className="mr-2 h-4 w-4" />
          )}
          Sync now
        </Button>
      }
    >
      <div className="flex min-w-0 w-full flex-col gap-8">
        {syncMutation.isPending ? (
          <div className="bg-muted text-muted-foreground flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            Syncing contributors from merged PRs...
          </div>
        ) : null}

        {/* ── Enrolled section (moved above Review Queue) ── */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-2xl font-bold">Enrolled</h2>
            <div className="flex items-center gap-3">
              <p className="text-muted-foreground text-sm">Official contributor champions</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setManualEnrollOpen(true)}
              >
                <UserPlus className="mr-2 h-4 w-4" />
                Manual enroll
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-muted-foreground text-xs">GitHub</label>
              <Input
                placeholder="Filter GitHub…"
                className="h-8 w-[160px]"
                value={enrolledFilters.githubLogin}
                onChange={e =>
                  setEnrolledFilters(prev => ({ ...prev, githubLogin: e.target.value }))
                }
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-muted-foreground text-xs">Email</label>
              <Input
                placeholder="Filter email…"
                className="h-8 w-[200px]"
                value={enrolledFilters.email}
                onChange={e =>
                  setEnrolledFilters(prev => ({ ...prev, email: e.target.value }))
                }
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-muted-foreground text-xs">Tier</label>
              <Select
                value={enrolledFilters.enrolledTier || '__all__'}
                onValueChange={value =>
                  setEnrolledFilters(prev => ({
                    ...prev,
                    enrolledTier: value === '__all__' ? '' : value,
                  }))
                }
              >
                <SelectTrigger className="h-8 w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All tiers</SelectItem>
                  {contributorTiers.map(tier => (
                    <SelectItem key={tier} value={tier}>
                      {tier}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-muted-foreground text-xs">Kilo account</label>
              <Select
                value={enrolledFilters.hasKiloAccount}
                onValueChange={value =>
                  setEnrolledFilters(prev => ({
                    ...prev,
                    hasKiloAccount: parseKiloAccountFilter(value),
                  }))
                }
              >
                <SelectTrigger className="h-8 w-[140px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="yes">Has account</SelectItem>
                  <SelectItem value="no">No account</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <SortableButton
                      field="githubLogin"
                      sortConfig={enrolledSort.sortConfig}
                      onSort={enrolledSort.onSort}
                    >
                      GitHub
                    </SortableButton>
                  </TableHead>
                  <TableHead>
                    <SortableButton
                      field="email"
                      sortConfig={enrolledSort.sortConfig}
                      onSort={enrolledSort.onSort}
                    >
                      Email
                    </SortableButton>
                  </TableHead>
                  <TableHead>
                    <SortableButton
                      field="contributionsAllTime"
                      sortConfig={enrolledSort.sortConfig}
                      onSort={enrolledSort.onSort}
                    >
                      All-time
                    </SortableButton>
                  </TableHead>
                  <TableHead>
                    <SortableButton
                      field="contributions30d"
                      sortConfig={enrolledSort.sortConfig}
                      onSort={enrolledSort.onSort}
                    >
                      30-day
                    </SortableButton>
                  </TableHead>
                  <TableHead>
                    <SortableButton
                      field="enrolledTier"
                      sortConfig={enrolledSort.sortConfig}
                      onSort={enrolledSort.onSort}
                    >
                      Tier
                    </SortableButton>
                  </TableHead>
                  <TableHead>
                    <SortableButton
                      field="enrolledAt"
                      sortConfig={enrolledSort.sortConfig}
                      onSort={enrolledSort.onSort}
                    >
                      Enrolled At
                    </SortableButton>
                  </TableHead>
                  <TableHead>Credits/mo</TableHead>
                  <TableHead>Last Grant</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoadingTables ? (
                  <TableRow>
                    <TableCell colSpan={8} className="py-8 text-center">
                      <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                    </TableCell>
                  </TableRow>
                ) : enrolledPageRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-muted-foreground py-8 text-center">
                      No enrolled contributors.
                    </TableCell>
                  </TableRow>
                ) : (
                  enrolledPageRows.map(row => (
                    <TableRow key={row.contributorId}>
                      <TableCell className="font-medium">
                        <a
                          href={row.githubProfileUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:underline"
                        >
                          @{row.githubLogin}
                        </a>
                      </TableCell>
                      <TableCell>
                        <EmailCell
                          email={row.email}
                          linkedUserId={row.linkedUserId}
                          linkedUserName={row.linkedUserName}
                        />
                      </TableCell>
                      <TableCell>
                        <ContributionCountButton
                          count={row.contributionsAllTime}
                          onClick={() =>
                            setDrillInState({
                              contributorId: row.contributorId,
                              githubLogin: row.githubLogin,
                              window: 'all_time',
                            })
                          }
                        />
                      </TableCell>
                      <TableCell>
                        <ContributionCountButton
                          count={row.contributions30d}
                          onClick={() =>
                            setDrillInState({
                              contributorId: row.contributorId,
                              githubLogin: row.githubLogin,
                              window: 'rolling_30_days',
                            })
                          }
                        />
                      </TableCell>
                      <TableCell>
                        <TierDisplay tier={row.enrolledTier} />
                      </TableCell>
                      <TableCell>
                        {row.enrolledAt ? new Date(row.enrolledAt).toLocaleString() : '—'}
                      </TableCell>
                      <TableCell>
                        {row.creditAmountUsd ? `$${row.creditAmountUsd}` : '—'}
                      </TableCell>
                      <TableCell>
                        {row.creditsLastGrantedAt
                          ? new Date(row.creditsLastGrantedAt).toLocaleString()
                          : 'Never'}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
            {!isLoadingTables && enrolledSorted.length > 0 ? (
              <TablePagination
                page={enrolledPage}
                totalPages={enrolledTotalPages}
                total={enrolledSorted.length}
                onPageChange={setEnrolledPage}
              />
            ) : null}
          </div>
        </section>

        {/* ── Review Queue section ── */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-2xl font-bold">Review Queue</h2>
            <p className="text-muted-foreground text-sm">Pending candidates to enroll</p>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-muted-foreground text-xs">GitHub</label>
              <Input
                placeholder="Filter GitHub…"
                className="h-8 w-[160px]"
                value={reviewFilters.githubLogin}
                onChange={e =>
                  setReviewFilters(prev => ({ ...prev, githubLogin: e.target.value }))
                }
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-muted-foreground text-xs">Email</label>
              <Input
                placeholder="Filter email…"
                className="h-8 w-[200px]"
                value={reviewFilters.email}
                onChange={e =>
                  setReviewFilters(prev => ({ ...prev, email: e.target.value }))
                }
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-muted-foreground text-xs">Tier</label>
              <Select
                value={reviewFilters.tier || '__all__'}
                onValueChange={value =>
                  setReviewFilters(prev => ({
                    ...prev,
                    tier: value === '__all__' ? '' : value,
                  }))
                }
              >
                <SelectTrigger className="h-8 w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All tiers</SelectItem>
                  {contributorTiers.map(tier => (
                    <SelectItem key={tier} value={tier}>
                      {tier}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-muted-foreground text-xs">Kilo account</label>
              <Select
                value={reviewFilters.hasKiloAccount}
                onValueChange={value =>
                  setReviewFilters(prev => ({
                    ...prev,
                    hasKiloAccount: parseKiloAccountFilter(value),
                  }))
                }
              >
                <SelectTrigger className="h-8 w-[140px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="yes">Has account</SelectItem>
                  <SelectItem value="no">No account</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <SortableButton
                      field="githubLogin"
                      sortConfig={reviewSort.sortConfig}
                      onSort={reviewSort.onSort}
                    >
                      GitHub
                    </SortableButton>
                  </TableHead>
                  <TableHead>
                    <SortableButton
                      field="email"
                      sortConfig={reviewSort.sortConfig}
                      onSort={reviewSort.onSort}
                    >
                      Email
                    </SortableButton>
                  </TableHead>
                  <TableHead>
                    <SortableButton
                      field="contributionsAllTime"
                      sortConfig={reviewSort.sortConfig}
                      onSort={reviewSort.onSort}
                    >
                      All-time
                    </SortableButton>
                  </TableHead>
                  <TableHead>
                    <SortableButton
                      field="contributions30d"
                      sortConfig={reviewSort.sortConfig}
                      onSort={reviewSort.onSort}
                    >
                      30-day
                    </SortableButton>
                  </TableHead>
                  <TableHead>
                    <SortableButton
                      field="tier"
                      sortConfig={reviewSort.sortConfig}
                      onSort={reviewSort.onSort}
                    >
                      Tier
                    </SortableButton>
                  </TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoadingTables ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-8 text-center">
                      <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                    </TableCell>
                  </TableRow>
                ) : reviewPageRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-muted-foreground py-8 text-center">
                      No pending contributors.
                    </TableCell>
                  </TableRow>
                ) : (
                  reviewPageRows.map(row => {
                    const effectiveTier = row.selectedTier ?? row.suggestedTier;

                    return (
                      <TableRow key={row.contributorId}>
                        <TableCell className="font-medium">
                          <a
                            href={row.githubProfileUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:underline"
                          >
                            @{row.githubLogin}
                          </a>
                        </TableCell>
                        <TableCell>
                          <EmailCell
                            email={row.email}
                            linkedUserId={row.linkedUserId}
                            linkedUserName={row.linkedUserName}
                          />
                        </TableCell>
                        <TableCell>
                          <ContributionCountButton
                            count={row.contributionsAllTime}
                            onClick={() =>
                              setDrillInState({
                                contributorId: row.contributorId,
                                githubLogin: row.githubLogin,
                                window: 'all_time',
                              })
                            }
                          />
                        </TableCell>
                        <TableCell>
                          <ContributionCountButton
                            count={row.contributions30d}
                            onClick={() =>
                              setDrillInState({
                                contributorId: row.contributorId,
                                githubLogin: row.githubLogin,
                                window: 'rolling_30_days',
                              })
                            }
                          />
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-1">
                            <Select
                              value={effectiveTier ?? undefined}
                              onValueChange={nextValue => {
                                const parsed = normalizeTier(nextValue);
                                if (!parsed) return;
                                void setSelectedTierMutation.mutateAsync({
                                  contributorId: row.contributorId,
                                  selectedTier: parsed,
                                });
                              }}
                            >
                              <SelectTrigger className="w-[160px]">
                                <SelectValue placeholder="Choose tier" />
                              </SelectTrigger>
                              <SelectContent>
                                {contributorTiers.map(tier => (
                                  <SelectItem key={tier} value={tier}>
                                    {tier}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            {effectiveTier ? (
                              <span className="text-muted-foreground text-xs">
                                → {effectiveTier === 'contributor'
                                  ? 'no credits'
                                  : `$${effectiveTier === 'ambassador' ? '50' : '150'}/mo`}
                              </span>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="icon"
                            className="bg-green-600 hover:bg-green-700"
                            disabled={!effectiveTier || enrollMutation.isPending}
                            onClick={() => {
                              if (!effectiveTier) return;
                              setEnrollmentState({
                                contributorId: row.contributorId,
                                githubLogin: row.githubLogin,
                                tier: effectiveTier,
                              });
                            }}
                            title={
                              effectiveTier
                                ? `Add contributor as ${effectiveTier}`
                                : 'Select a tier before enrolling'
                            }
                          >
                            <Plus className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
            {!isLoadingTables && reviewSorted.length > 0 ? (
              <TablePagination
                page={reviewPage}
                totalPages={reviewTotalPages}
                total={reviewSorted.length}
                onPageChange={setReviewPage}
              />
            ) : null}
          </div>
        </section>
      </div>

      <Dialog open={drillInState !== null} onOpenChange={open => !open && setDrillInState(null)}>
        <DialogContent className="max-h-[80vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              Contributions for @{drillInState?.githubLogin}{' '}
              {drillInState?.window === 'all_time' ? '(All-time)' : '(Rolling 30 days)'}
            </DialogTitle>
            <DialogDescription>
              Full contribution rows for the selected contributor and time window.
            </DialogDescription>
          </DialogHeader>

          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Repo</TableHead>
                  <TableHead>PR</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Author</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Merged At</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {drillInQuery.isLoading ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-8 text-center">
                      <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                    </TableCell>
                  </TableRow>
                ) : drillInQuery.data && drillInQuery.data.length > 0 ? (
                  drillInQuery.data.map(item => (
                    <TableRow key={item.eventId}>
                      <TableCell>{item.repoFullName}</TableCell>
                      <TableCell>
                        <a
                          href={item.githubPrUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline"
                        >
                          #{item.githubPrNumber}
                        </a>
                      </TableCell>
                      <TableCell className="max-w-[360px] truncate" title={item.githubPrTitle}>
                        {item.githubPrTitle}
                      </TableCell>
                      <TableCell>@{item.githubAuthorLogin}</TableCell>
                      <TableCell>{item.githubAuthorEmail ?? '—'}</TableCell>
                      <TableCell>{new Date(item.mergedAt).toLocaleString()}</TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={6} className="text-muted-foreground py-8 text-center">
                      No contributions found for this window.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={enrollmentState !== null}
        onOpenChange={open => !open && setEnrollmentState(null)}
      >
        <DialogContent className="sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>Confirm enrollment</DialogTitle>
            <DialogDescription>
              Enroll @{enrollmentState?.githubLogin} as <b>{enrollmentState?.tier}</b>.
            </DialogDescription>
          </DialogHeader>

          {enrollmentState ? (
            <div className="space-y-2 text-sm">
              <p>
                <b className="capitalize">{enrollmentState.tier}</b> tier:{' '}
                {TIER_CREDIT_DISPLAY[enrollmentState.tier]}
                {enrollmentState.tier !== 'contributor'
                  ? ', renewing every 30 days'
                  : ''}
              </p>
              {(() => {
                const matchedRow = (reviewQuery.data ?? []).find(
                  r => r.contributorId === enrollmentState.contributorId
                );
                if (
                  enrollmentState.tier !== 'contributor' &&
                  (!matchedRow || !matchedRow.linkedUserId)
                ) {
                  return (
                    <p className="text-yellow-500">
                      ⚠️ No linked Kilo account found. Credits cannot be granted until the
                      contributor has a Kilo account with a matching email.
                    </p>
                  );
                }
                return null;
              })()}
              <p className="text-muted-foreground text-xs">
                Contributors are auto-upgraded when they reach 5 PRs (→ Ambassador) or 15 PRs
                (→ Champion).
              </p>
            </div>
          ) : null}

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary" disabled={enrollMutation.isPending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              disabled={enrollMutation.isPending || enrollmentState === null}
              onClick={() => {
                if (!enrollmentState) return;
                void enrollMutation.mutateAsync({
                  contributorId: enrollmentState.contributorId,
                  tier: enrollmentState.tier,
                });
              }}
            >
              {enrollMutation.isPending ? 'Enrolling...' : 'Confirm enrollment'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Manual Enrollment Dialog */}
      <Dialog
        open={manualEnrollOpen}
        onOpenChange={open => {
          if (!open) {
            setManualEnrollOpen(false);
            setManualEmail('');
            setManualGithub('');
            setManualTier('contributor');
            setSelectedKiloUser(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>Manual Enrollment</DialogTitle>
            <DialogDescription>
              Add a contributor directly to the enrolled list. Type an email to search for an existing Kilo account.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">Email</label>
              <Input
                placeholder="contributor@example.com"
                value={manualEmail}
                onChange={e => {
                  setManualEmail(e.target.value);
                  if (selectedKiloUser && e.target.value !== selectedKiloUser.email) {
                    setSelectedKiloUser(null);
                  }
                }}
              />
              {manualEmail.length >= 2 && !selectedKiloUser ? (
                <div className="max-h-[160px] overflow-y-auto rounded-md border">
                  {userSearchResults.isLoading ? (
                    <div className="flex items-center justify-center py-4">
                      <Loader2 className="h-4 w-4 animate-spin" />
                    </div>
                  ) : (userSearchResults.data ?? []).length === 0 ? (
                    <div className="text-muted-foreground px-3 py-2 text-sm">
                      No matching Kilo accounts
                    </div>
                  ) : (
                    (userSearchResults.data ?? []).map(user => (
                      <button
                        key={user.userId}
                        type="button"
                        className="hover:bg-muted flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
                        onClick={() => {
                          setSelectedKiloUser(user);
                          setManualEmail(user.email);
                        }}
                      >
                        <span className="font-medium">{user.email}</span>
                        {user.name ? (
                          <span className="text-muted-foreground">({user.name})</span>
                        ) : null}
                      </button>
                    ))
                  )}
                </div>
              ) : null}
              {selectedKiloUser ? (
                <div className="flex items-center gap-2 text-sm text-green-500">
                  <Check className="h-4 w-4" />
                  Linked to Kilo account: {selectedKiloUser.email}
                  {selectedKiloUser.name ? ` (${selectedKiloUser.name})` : ''}
                </div>
              ) : null}
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">GitHub username (optional)</label>
              <Input
                placeholder="octocat"
                value={manualGithub}
                onChange={e => setManualGithub(e.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">Tier</label>
              <Select
                value={manualTier}
                onValueChange={value => {
                  const parsed = normalizeTier(value);
                  if (parsed) setManualTier(parsed);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {contributorTiers.map(tier => (
                    <SelectItem key={tier} value={tier}>
                      {tier}
                      {tier === 'ambassador'
                        ? ' — $50/mo credits'
                        : tier === 'champion'
                          ? ' — $150/mo credits'
                          : ' — no credits'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {!selectedKiloUser && manualTier !== 'contributor' ? (
              <div className="bg-muted rounded-md px-3 py-2 text-sm">
                <AlertCircle className="mr-1 inline h-4 w-4" />
                No Kilo user selected — credits cannot be granted until linked.
              </div>
            ) : null}
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary" disabled={manualEnrollMutation.isPending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              disabled={
                manualEnrollMutation.isPending ||
                !manualEmail ||
                !/^[^@]+@[^@]+\.[^@]+$/.test(manualEmail)
              }
              onClick={() => {
                void manualEnrollMutation.mutateAsync({
                  email: manualEmail,
                  githubLogin: manualGithub || null,
                  tier: manualTier,
                  kiloUserId: selectedKiloUser?.userId ?? null,
                });
              }}
            >
              {manualEnrollMutation.isPending ? 'Enrolling...' : 'Enroll contributor'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminPage>
  );
}
