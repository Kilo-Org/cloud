export type ExternalOpenPullRequestRow = {
  number: number;
  title: string;
  url: string;
  repo: string;
  authorLogin: string;
  createdAt: string;
  ageDays: number;
  commentCount: number;
  teamCommented: boolean;
  reviewStatus: string;
};

export type ExternalPrSortKey = 'ageDays' | 'teamCommented' | 'reviewStatus' | 'repo';

export type ExternalPrSortDirection = 'asc' | 'desc';

export type ExternalPrSort = {
  key: ExternalPrSortKey;
  direction: ExternalPrSortDirection;
};

export type ExternalMergedPullRequestRow = {
  number: number;
  title: string;
  url: string;
  authorLogin: string;
  mergedAt: string;
};

export type ExternalClosedPullRequestStatus = 'merged' | 'closed';

export type ExternalClosedPullRequestRow = {
  number: number;
  title: string;
  url: string;
  repo: string;
  authorLogin: string;
  closedAt: string;
  mergedAt: string | null;
  status: ExternalClosedPullRequestStatus;
  displayDate: string;
};

export type MergedPrSortKey = 'mergedAt' | 'authorLogin';

export type MergedPrSort = {
  key: MergedPrSortKey;
  direction: ExternalPrSortDirection;
};

export type ClosedPrSortKey = 'displayDate' | 'status' | 'repo';

export type ClosedPrSort = {
  key: ClosedPrSortKey;
  direction: ExternalPrSortDirection;
};

export function sortExternalPullRequests(
  rows: readonly ExternalOpenPullRequestRow[],
  sort: ExternalPrSort
): ExternalOpenPullRequestRow[] {
  const mapped = rows.map((row, index) => ({ row, index }));

  mapped.sort((a, b) => {
    const primary = compareBySort(a.row, b.row, sort);
    if (primary !== 0) return primary;
    // Stable fallback
    return a.index - b.index;
  });

  return mapped.map(v => v.row);
}

function compareBySort(
  a: ExternalOpenPullRequestRow,
  b: ExternalOpenPullRequestRow,
  sort: ExternalPrSort
): number {
  const sign = sort.direction === 'asc' ? 1 : -1;
  if (sort.key === 'ageDays') return sign * (a.ageDays - b.ageDays);

  if (sort.key === 'repo') return sign * a.repo.localeCompare(b.repo);

  if (sort.key === 'teamCommented') {
    // teamCommented: booleans, default ordering is false < true.
    const aVal = a.teamCommented ? 1 : 0;
    const bVal = b.teamCommented ? 1 : 0;
    return sign * (aVal - bVal);
  }

  // reviewStatus: order by priority (changes_requested > approved > commented > no_reviews)
  const aVal = reviewStatusPriority(a.reviewStatus);
  const bVal = reviewStatusPriority(b.reviewStatus);
  return sign * (aVal - bVal);
}

export function sortMergedPullRequests(
  rows: readonly ExternalMergedPullRequestRow[],
  sort: MergedPrSort
): ExternalMergedPullRequestRow[] {
  const mapped = rows.map((row, index) => ({ row, index }));

  mapped.sort((a, b) => {
    const primary = compareByMergedSort(a.row, b.row, sort);
    if (primary !== 0) return primary;
    // Stable fallback
    return a.index - b.index;
  });

  return mapped.map(v => v.row);
}

export function sortClosedPullRequests(
  rows: readonly ExternalClosedPullRequestRow[],
  sort: ClosedPrSort
): ExternalClosedPullRequestRow[] {
  const mapped = rows.map((row, index) => ({ row, index }));

  mapped.sort((a, b) => {
    const primary = compareByClosedSort(a.row, b.row, sort);
    if (primary !== 0) return primary;
    // Stable fallback
    return a.index - b.index;
  });

  return mapped.map(v => v.row);
}

function compareByClosedSort(
  a: ExternalClosedPullRequestRow,
  b: ExternalClosedPullRequestRow,
  sort: ClosedPrSort
): number {
  const sign = sort.direction === 'asc' ? 1 : -1;

  if (sort.key === 'displayDate') {
    const dateA = new Date(a.displayDate).getTime();
    const dateB = new Date(b.displayDate).getTime();
    return sign * (dateA - dateB);
  }

  if (sort.key === 'repo') return sign * a.repo.localeCompare(b.repo);

  // status: default ordering is closed < merged (closed first, more actionable)
  const aVal = a.status === 'closed' ? 0 : 1;
  const bVal = b.status === 'closed' ? 0 : 1;
  return sign * (aVal - bVal);
}

function compareByMergedSort(
  a: ExternalMergedPullRequestRow,
  b: ExternalMergedPullRequestRow,
  sort: MergedPrSort
): number {
  const sign = sort.direction === 'asc' ? 1 : -1;

  if (sort.key === 'mergedAt') {
    const dateA = new Date(a.mergedAt).getTime();
    const dateB = new Date(b.mergedAt).getTime();
    return sign * (dateA - dateB);
  }

  // authorLogin: string comparison
  return sign * a.authorLogin.localeCompare(b.authorLogin);
}

function reviewStatusPriority(status: string): number {
  if (status === 'changes_requested') return 4;
  if (status === 'approved') return 3;
  if (status === 'commented') return 2;
  return 1; // no_reviews or unknown
}
