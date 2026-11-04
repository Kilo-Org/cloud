import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PrBadge } from './PrBadge';
import { PrHoverCardContent } from './PrHoverCardContent';
import { SessionPrIndicator } from './SessionPrIndicator';
import type { AssociatedPr } from './utils/github-pr-link';
import type { PrStatus } from '@/lib/integrations/platforms/github/pr-status';

globalThis.React = React;

const mockQueryOptions = jest.fn().mockReturnValue({ queryKey: ['pr-status'] });
const mockRefetch = jest.fn();
const mockMutate = jest.fn();
const mockUseMutation = jest.fn();
const mockInvalidateQueries = jest.fn();
let mockQueryResult: {
  data: PrStatus | undefined;
  isFetching: boolean;
  isError: boolean;
  error: Error | null;
  refetch: typeof mockRefetch;
};
const mockUseQuery = jest.fn();

jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    cliSessionsV2: {
      getAssociatedPullRequestStatus: {
        queryOptions: (...args: unknown[]) => mockQueryOptions(...args),
      },
      refreshAssociatedPullRequest: { mutationOptions: () => ({}) },
      list: { pathFilter: () => ({ queryKey: ['list'] }) },
      search: { pathFilter: () => ({ queryKey: ['search'] }) },
      worktreeDetails: { pathFilter: () => ({ queryKey: ['worktreeDetails'] }) },
    },
  }),
}));
jest.mock('@tanstack/react-query', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (...args: unknown[]) => mockUseMutation(...args),
  useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
}));

const pr: AssociatedPr = {
  url: 'https://github.com/owner/repo/pull/42',
  number: 42,
  state: 'open',
  title: 'Update checks',
  headSha: 'a'.repeat(40),
  lastSyncedAt: '2026-10-21T12:00:00Z',
  reviewDecision: 'approved',
  reviewDecisionPending: false,
  platform: 'github',
  observations: { checks: { total: 8, failed: 2 }, unresolvedThreads: 3, truncated: false },
};
const status: PrStatus = {
  url: pr.url,
  number: pr.number,
  state: 'open',
  title: 'Current GitHub title',
  headSha: 'b'.repeat(40),
  baseSha: 'c'.repeat(40),
  headRef: 'feature',
  baseRef: 'main',
  baseRepoFullName: 'owner/repo',
  headRepoFullName: 'owner/repo',
  reviewDecision: 'changes_requested',
  mergeable: false,
  mergeableState: 'dirty',
  checks: { total: 8, passed: 3, failed: 2, pending: 2, skipped: 1, unknown: 0, truncated: false },
  unresolvedThreads: 4,
  threadsTruncated: false,
  unavailable: [],
  fetchedAt: '2026-11-04T22:00:00.000Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockQueryResult = {
    data: undefined,
    isFetching: false,
    isError: false,
    error: null,
    refetch: mockRefetch,
  };
  mockUseQuery.mockImplementation(() => mockQueryResult);
  mockUseMutation.mockReturnValue({ mutate: mockMutate, isPending: false });
});

function hoverCard(value = pr) {
  return renderToStaticMarkup(
    createElement(PrHoverCardContent, { pr: value, sessionId: 'session', gitBranch: 'feature' })
  );
}
describe('passive PR status', () => {
  it('shows compact observed counts without watch controls', () => {
    const html = hoverCard();
    expect(html).toContain('8 total / 2 failed');
    expect(html).toContain('Unresolved threads');
    expect(html).toContain('>3</span>');
    expect(html).not.toContain('Watch PR');
    expect(html).not.toContain('Pause');
    expect(html).not.toContain('Saved preferences');
  });
  it('does not present missing observations as zero', () => {
    const html = hoverCard({ ...pr, observations: null });
    expect(html.match(/>Unknown</g)).toHaveLength(3);
    expect(html).not.toContain('0 total');
  });
  it('distinguishes observed zero unresolved threads from unknown', () => {
    expect(
      hoverCard({ ...pr, observations: { checks: null, unresolvedThreads: 0, truncated: false } })
    ).toContain('>0</span>');
  });
  it('marks bounded observations as partial', () => {
    const html = hoverCard({
      ...pr,
      observations: { checks: { total: 8, failed: 2 }, unresolvedThreads: 3, truncated: true },
    });
    expect(html).toContain('Partial observations; some evidence is missing.');
    expect(html).toContain('8 total / 2 failed');
    expect(html).toContain('>3</span>');
    expect(html).not.toContain('+');
  });
  it('does not change badge color for failures whose requiredness is unknown', () => {
    const badge = (value: AssociatedPr) =>
      renderToStaticMarkup(createElement(PrBadge, { pr: value }));
    expect(badge(pr)).toBe(badge({ ...pr, observations: null }));
  });
  it('does not add GitHub observations to other platforms', () => {
    const html = hoverCard({ ...pr, platform: 'gitlab' });
    expect(html).not.toContain('Checks (observed)');
    expect(html).not.toContain('Merge conflicts');
    expect(mockUseQuery).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });
  it('renders just the existing badge without an opt-in eye button', () => {
    const html = renderToStaticMarkup(
      createElement(SessionPrIndicator, {
        session: {
          sessionId: 'session',
          branch: 'feature',
          repository: 'owner/repo',
          associatedPr: pr,
        },
      })
    );
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).not.toContain('Watch PR');
    expect(mockUseQuery).not.toHaveBeenCalled();
  });
});

describe('GitHub PR status snapshot', () => {
  beforeEach(() => {
    mockQueryResult.data = status;
  });

  it('reads the exact PR on opening without recurring polling', () => {
    hoverCard();
    expect(mockQueryOptions).toHaveBeenCalledWith({ sessionId: 'session', prUrl: pr.url });
    expect(mockUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: expect.any(Function),
      })
    );
    expect(mockUseQuery.mock.calls[0][0]).not.toHaveProperty('refetchInterval');
    const retry = mockUseQuery.mock.calls[0][0].retry;
    expect(retry(0, { data: { code: 'BAD_GATEWAY' } })).toBe(true);
    expect(retry(1, { data: { code: 'BAD_GATEWAY' } })).toBe(false);
    expect(retry(0, { data: { code: 'PRECONDITION_FAILED' } })).toBe(false);
    expect(retry(0, { data: { code: 'TOO_MANY_REQUESTS' } })).toBe(false);
  });

  it('refreshes the sidebar metadata and the live status together', () => {
    hoverCard();
    const callbacks = mockUseMutation.mock.calls[0][0];
    callbacks.onSuccess();
    callbacks.onSettled();
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['list'] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['search'] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['worktreeDetails'] });
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });

  it('shows current check outcomes, threads, conflicts, review, branch and commit', () => {
    const html = hoverCard();
    expect(html).toContain('8 total');
    expect(html).toContain('3 passed / 2 failed / 2 pending');
    expect(html).toContain('1 skipped');
    expect(html).toContain('>4</span>');
    expect(html).toContain('Conflicts detected');
    expect(html).toContain('Changes requested');
    expect(html).toContain('Current GitHub title');
    expect(html).toContain('bbbbbbb');
    expect(html).toContain('>main</span>');
    expect(html).not.toContain('aaaaaaa');
    expect(html).not.toContain('Checks (observed)');
  });

  it('does not conflate blocked merge rules with merge conflicts', () => {
    mockQueryResult.data = { ...status, mergeable: true, mergeableState: 'blocked' };
    const html = hoverCard();
    expect(html).toContain('No conflicts');
    expect(html).toContain('Blocked');
    expect(html).not.toContain('Conflicts detected');
  });

  it('keeps mergeability unknown while GitHub is calculating it', () => {
    mockQueryResult.data = { ...status, mergeable: null, mergeableState: 'unknown' };
    const html = hoverCard();
    expect(html).not.toContain('No conflicts</span>');
    expect(html).not.toContain('Conflicts detected');
  });

  it('distinguishes complete zero counts from missing data', () => {
    mockQueryResult.data = {
      ...status,
      checks: {
        total: 0,
        passed: 0,
        failed: 0,
        pending: 0,
        skipped: 0,
        unknown: 0,
        truncated: false,
      },
      unresolvedThreads: 0,
      reviewDecision: null,
    };
    const html = hoverCard();
    expect(html).toContain('0 total');
    expect(html).toContain('0 passed / 0 failed / 0 pending');
    expect(html).toContain('>0</span>');
    expect(html).toContain('No decision');
  });

  it('marks counts as partial rather than implying all checks or threads were read', () => {
    mockQueryResult.data = {
      ...status,
      checks: status.checks ? { ...status.checks, truncated: true, unknown: 1 } : null,
      threadsTruncated: true,
    };
    const html = hoverCard();
    expect(html).toContain('8');
    expect(html).toContain('+');
    expect(html).toContain('4+');
    expect(html).toContain('1 unknown');
    expect(html).toContain('Partial counts; some checks or threads could not be read.');
  });

  it('does not replace unavailable current data with old webhook counts or approval', () => {
    mockQueryResult.data = {
      ...status,
      checks: null,
      unresolvedThreads: null,
      reviewDecision: null,
      unavailable: ['checks', 'statuses', 'reviews'],
    };
    const html = hoverCard();
    expect(html.match(/>Unavailable</g)).toHaveLength(3);
    expect(html).toContain(
      'Unavailable from GitHub: check runs, commit statuses, reviews and threads.'
    );
    expect(html).not.toContain('8 total');
    expect(html).not.toContain('Approved');
  });

  it('shows fetch progress and disables refresh until it finishes', () => {
    mockQueryResult.isFetching = true;
    const html = hoverCard();
    expect(html).toContain('Fetching pull request status from GitHub...');
    expect(html).toContain('disabled=""');
    expect(html).toContain('animate-spin');
  });

  it('surfaces read errors while retaining an explicitly stale snapshot', () => {
    mockQueryResult.isError = true;
    mockQueryResult.error = new Error('GitHub could not be reached. Refresh to try again.');
    const html = hoverCard();
    expect(html).toContain('role="alert"');
    expect(html).toContain('GitHub could not be reached. Refresh to try again.');
    expect(html).toContain('Showing the last fetched status.');
    expect(html).toContain('3 passed / 2 failed / 2 pending');
  });
});
