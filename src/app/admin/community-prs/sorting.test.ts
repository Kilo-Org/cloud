import {
  sortExternalPullRequests,
  sortMergedPullRequests,
  sortClosedPullRequests,
  type ExternalOpenPullRequestRow,
  type ExternalMergedPullRequestRow,
  type ExternalClosedPullRequestRow,
} from '@/app/admin/community-prs/sorting';

function row(partial: Partial<ExternalOpenPullRequestRow>): ExternalOpenPullRequestRow {
  return {
    number: partial.number ?? 1,
    title: partial.title ?? 't',
    url: partial.url ?? 'https://example.com',
    repo: partial.repo ?? 'kilocode',
    authorLogin: partial.authorLogin ?? 'a',
    createdAt: partial.createdAt ?? new Date('2020-01-01T00:00:00.000Z').toISOString(),
    ageDays: partial.ageDays ?? 0,
    commentCount: partial.commentCount ?? 0,
    teamCommented: partial.teamCommented ?? false,
    reviewStatus: partial.reviewStatus ?? 'no_reviews',
  };
}

function mergedRow(partial: Partial<ExternalMergedPullRequestRow>): ExternalMergedPullRequestRow {
  return {
    number: partial.number ?? 1,
    title: partial.title ?? 't',
    url: partial.url ?? 'https://example.com',
    authorLogin: partial.authorLogin ?? 'a',
    mergedAt: partial.mergedAt ?? new Date('2020-01-01T00:00:00.000Z').toISOString(),
  };
}

function closedRow(partial: Partial<ExternalClosedPullRequestRow>): ExternalClosedPullRequestRow {
  const closedAt = partial.closedAt ?? new Date('2020-01-01T00:00:00.000Z').toISOString();
  const mergedAt = partial.mergedAt ?? null;
  const status = partial.status ?? (mergedAt ? 'merged' : 'closed');
  const displayDate = partial.displayDate ?? mergedAt ?? closedAt;

  return {
    number: partial.number ?? 1,
    title: partial.title ?? 't',
    url: partial.url ?? 'https://example.com',
    repo: partial.repo ?? 'kilocode',
    authorLogin: partial.authorLogin ?? 'a',
    closedAt,
    mergedAt,
    status,
    displayDate,
  };
}

describe('sortExternalPullRequests', () => {
  it('sorts by ageDays desc (oldest first)', () => {
    const rows = [
      row({ number: 1, ageDays: 2 }),
      row({ number: 2, ageDays: 10 }),
      row({ number: 3, ageDays: 5 }),
    ];
    const sorted = sortExternalPullRequests(rows, { key: 'ageDays', direction: 'desc' });
    expect(sorted.map(r => r.number)).toEqual([2, 3, 1]);
  });

  it('sorts by teamCommented asc (false first)', () => {
    const rows = [
      row({ number: 1, teamCommented: true }),
      row({ number: 2, teamCommented: false }),
      row({ number: 3, teamCommented: true }),
    ];
    const sorted = sortExternalPullRequests(rows, { key: 'teamCommented', direction: 'asc' });
    expect(sorted.map(r => r.number)).toEqual([2, 1, 3]);
  });

  it('sorts by reviewStatus desc (higher priority first)', () => {
    const rows = [
      row({ number: 1, reviewStatus: 'no_reviews' }),
      row({ number: 2, reviewStatus: 'changes_requested' }),
      row({ number: 3, reviewStatus: 'approved' }),
      row({ number: 4, reviewStatus: 'commented' }),
    ];
    const sorted = sortExternalPullRequests(rows, { key: 'reviewStatus', direction: 'desc' });
    expect(sorted.map(r => r.number)).toEqual([2, 3, 4, 1]);
  });

  it('sorts by reviewStatus asc (lower priority first)', () => {
    const rows = [
      row({ number: 1, reviewStatus: 'changes_requested' }),
      row({ number: 2, reviewStatus: 'approved' }),
      row({ number: 3, reviewStatus: 'no_reviews' }),
      row({ number: 4, reviewStatus: 'commented' }),
    ];
    const sorted = sortExternalPullRequests(rows, { key: 'reviewStatus', direction: 'asc' });
    expect(sorted.map(r => r.number)).toEqual([3, 4, 2, 1]);
  });

  it('sorts by repo asc (alphabetical)', () => {
    const rows = [
      row({ number: 1, repo: 'kilo-marketplace' }),
      row({ number: 2, repo: 'cloud' }),
      row({ number: 3, repo: 'kilocode' }),
    ];
    const sorted = sortExternalPullRequests(rows, { key: 'repo', direction: 'asc' });
    expect(sorted.map(r => r.number)).toEqual([2, 1, 3]);
  });

  it('sorts by repo desc (reverse alphabetical)', () => {
    const rows = [
      row({ number: 1, repo: 'kilo-marketplace' }),
      row({ number: 2, repo: 'cloud' }),
      row({ number: 3, repo: 'kilocode' }),
    ];
    const sorted = sortExternalPullRequests(rows, { key: 'repo', direction: 'desc' });
    expect(sorted.map(r => r.number)).toEqual([3, 1, 2]);
  });
});

describe('sortMergedPullRequests', () => {
  it('sorts by mergedAt desc (newest first)', () => {
    const rows = [
      mergedRow({ number: 1, mergedAt: '2024-01-01T00:00:00.000Z' }),
      mergedRow({ number: 2, mergedAt: '2024-01-15T00:00:00.000Z' }),
      mergedRow({ number: 3, mergedAt: '2024-01-10T00:00:00.000Z' }),
    ];
    const sorted = sortMergedPullRequests(rows, { key: 'mergedAt', direction: 'desc' });
    expect(sorted.map(r => r.number)).toEqual([2, 3, 1]);
  });

  it('sorts by mergedAt asc (oldest first)', () => {
    const rows = [
      mergedRow({ number: 1, mergedAt: '2024-01-01T00:00:00.000Z' }),
      mergedRow({ number: 2, mergedAt: '2024-01-15T00:00:00.000Z' }),
      mergedRow({ number: 3, mergedAt: '2024-01-10T00:00:00.000Z' }),
    ];
    const sorted = sortMergedPullRequests(rows, { key: 'mergedAt', direction: 'asc' });
    expect(sorted.map(r => r.number)).toEqual([1, 3, 2]);
  });

  it('sorts by authorLogin asc (alphabetical)', () => {
    const rows = [
      mergedRow({ number: 1, authorLogin: 'charlie' }),
      mergedRow({ number: 2, authorLogin: 'alice' }),
      mergedRow({ number: 3, authorLogin: 'bob' }),
    ];
    const sorted = sortMergedPullRequests(rows, { key: 'authorLogin', direction: 'asc' });
    expect(sorted.map(r => r.number)).toEqual([2, 3, 1]);
  });

  it('sorts by authorLogin desc (reverse alphabetical)', () => {
    const rows = [
      mergedRow({ number: 1, authorLogin: 'charlie' }),
      mergedRow({ number: 2, authorLogin: 'alice' }),
      mergedRow({ number: 3, authorLogin: 'bob' }),
    ];
    const sorted = sortMergedPullRequests(rows, { key: 'authorLogin', direction: 'desc' });
    expect(sorted.map(r => r.number)).toEqual([1, 3, 2]);
  });
});

describe('sortClosedPullRequests', () => {
  it('sorts by displayDate desc (newest first)', () => {
    const rows = [
      closedRow({ number: 1, displayDate: '2024-01-01T00:00:00.000Z' }),
      closedRow({ number: 2, displayDate: '2024-01-15T00:00:00.000Z' }),
      closedRow({ number: 3, displayDate: '2024-01-10T00:00:00.000Z' }),
    ];
    const sorted = sortClosedPullRequests(rows, { key: 'displayDate', direction: 'desc' });
    expect(sorted.map(r => r.number)).toEqual([2, 3, 1]);
  });

  it('sorts by status asc (closed first)', () => {
    const rows = [
      closedRow({ number: 1, status: 'merged' }),
      closedRow({ number: 2, status: 'closed' }),
      closedRow({ number: 3, status: 'merged' }),
    ];
    const sorted = sortClosedPullRequests(rows, { key: 'status', direction: 'asc' });
    expect(sorted.map(r => r.number)).toEqual([2, 1, 3]);
  });

  it('sorts by status desc (merged first)', () => {
    const rows = [
      closedRow({ number: 1, status: 'merged' }),
      closedRow({ number: 2, status: 'closed' }),
      closedRow({ number: 3, status: 'merged' }),
    ];
    const sorted = sortClosedPullRequests(rows, { key: 'status', direction: 'desc' });
    expect(sorted.map(r => r.number)).toEqual([1, 3, 2]);
  });

  it('sorts by repo asc (alphabetical)', () => {
    const rows = [
      closedRow({ number: 1, repo: 'kilocode' }),
      closedRow({ number: 2, repo: 'cloud' }),
      closedRow({ number: 3, repo: 'kilo-marketplace' }),
    ];
    const sorted = sortClosedPullRequests(rows, { key: 'repo', direction: 'asc' });
    expect(sorted.map(r => r.number)).toEqual([2, 3, 1]);
  });
});
