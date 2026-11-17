import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PrBadge } from './PrBadge';
import { PrHoverCardContent } from './PrHoverCardContent';
import { SessionPrIndicator } from './SessionPrIndicator';
import type { AssociatedPr } from './utils/github-pr-link';
import type { PrObservationSummary } from '@/lib/integrations/platforms/github/pr-observations';

globalThis.React = React;

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const RECENT = new Date(NOW - 30_000).toISOString();
const OLD = new Date(NOW - 90_000).toISOString();
const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const BASE = 'c'.repeat(40);

const mockMutate = jest.fn();
const mockUseMutation = jest.fn();
const mockInvalidateQueries = jest.fn();
let mutationPending = false;

jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    cliSessionsV2: {
      refreshAssociatedPullRequest: { mutationOptions: () => ({}) },
      list: { pathFilter: () => ({ queryKey: ['list'] }) },
      search: { pathFilter: () => ({ queryKey: ['search'] }) },
      worktreeDetails: { pathFilter: () => ({ queryKey: ['worktreeDetails'] }) },
    },
  }),
}));
jest.mock('@tanstack/react-query', () => ({
  useMutation: (...args: unknown[]) => mockUseMutation(...args),
  useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
}));

const observations: PrObservationSummary = {
  checks: { total: 8, failed: 2 },
  unresolvedThreads: 3,
  truncated: false,
};

const pr: AssociatedPr = {
  url: 'https://github.com/owner/repo/pull/42',
  number: 42,
  state: 'open',
  title: 'Update checks',
  headSha: HEAD,
  lastSyncedAt: OLD,
  reviewDecision: 'approved',
  reviewDecisionPending: false,
  platform: 'github',
  observations,
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  mutationPending = false;
  mockUseMutation.mockImplementation(() => ({ mutate: mockMutate, isPending: mutationPending }));
});

afterEach(() => {
  jest.restoreAllMocks();
});

function hoverCard(value = pr) {
  return renderToStaticMarkup(
    createElement(PrHoverCardContent, { pr: value, sessionId: 'session', gitBranch: 'feature' })
  );
}

function withObservations(value: Partial<PrObservationSummary>): AssociatedPr {
  return { ...pr, observations: { ...observations, ...value } };
}

function mutationOptions() {
  return mockUseMutation.mock.calls.at(-1)?.[0];
}

describe('cached PR observations', () => {
  it('renders the badge without requesting PR status on hover', () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
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
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockUseMutation).not.toHaveBeenCalled();
  });

  it('shows cached observation counts without watch controls', () => {
    const html = hoverCard();
    expect(html).toContain('8 total / 2 failed');
    expect(html).toContain('Checks (observed)');
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
    const html = hoverCard(withObservations({ checks: { total: 8, failed: 2 }, truncated: true }));
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

  it('does not add GitHub observations or refresh to other platforms', () => {
    const html = hoverCard({
      ...pr,
      platform: 'gitlab',
      state: 'unknown',
      lastSyncedAt: OLD,
    });
    expect(html).not.toContain('Checks (observed)');
    expect(html).not.toContain('Unresolved threads');
    expect(html).not.toContain('Merge conflicts');
    expect(html).not.toContain('Refresh pull request status');
    expect(mockMutate).not.toHaveBeenCalled();
  });
});

describe('detailed cached observations', () => {
  it('renders optional detailed counts and the observed label only when incomplete', () => {
    const html = hoverCard(
      withObservations({
        checks: {
          total: 8,
          failed: 2,
          passed: 3,
          pending: 2,
          skipped: 1,
          unknown: 0,
          complete: false,
        },
        unresolvedThreads: 4,
        threadsComplete: true,
      })
    );
    expect(html).toContain('Checks (observed)');
    expect(html).toContain('8 total');
    expect(html).toContain('3 passed / 2 failed / 2 pending');
    expect(html).toContain('1 skipped');
    expect(html).not.toContain('0 unknown');
    expect(html).toContain('>4</span>');
  });

  it('labels complete check inventories without the observed qualifier', () => {
    const html = hoverCard(
      withObservations({
        checks: {
          total: 8,
          failed: 2,
          passed: 3,
          pending: 2,
          skipped: 1,
          unknown: 0,
          complete: true,
        },
      })
    );
    expect(html).not.toContain('Checks (observed)');
    expect(html).toContain('>Checks</span>');
  });

  it('renders old summaries with only their total and failed counts', () => {
    const html = hoverCard(
      withObservations({ checks: { total: 5, failed: 1 }, unresolvedThreads: 2 })
    );
    expect(html).toContain('5 total / 1 failed');
    expect(html).not.toContain('passed');
    expect(html).not.toContain('pending');
  });

  it('distinguishes a complete zero inventory from missing data', () => {
    const html = hoverCard(
      withObservations({
        checks: {
          total: 0,
          failed: 0,
          passed: 0,
          pending: 0,
          skipped: 0,
          unknown: 0,
          complete: true,
        },
        unresolvedThreads: 0,
        threadsComplete: true,
      })
    );
    expect(html).toContain('0 total');
    expect(html).toContain('0 passed / 0 failed / 0 pending');
    expect(html).toContain('>0</span>');
  });

  it('renders observed mergeability true, false, and unknown', () => {
    const mergeability = (mergeable: boolean | null, state: string) => ({
      headSha: HEAD,
      baseSha: BASE,
      baseRef: 'main',
      mergeable,
      state,
      observedAt: NOW.toString(),
    });

    const clean = hoverCard(withObservations({ mergeability: mergeability(true, 'clean') }));
    expect(clean).toContain('No conflicts');
    expect(clean).not.toContain('Conflicts detected');
    expect(clean).toContain('Clean');
    expect(clean).toContain('>main</span>');
    expect(clean).toContain(BASE);

    const dirty = hoverCard(withObservations({ mergeability: mergeability(false, 'dirty') }));
    expect(dirty).toContain('Conflicts detected');
    expect(dirty).not.toContain('No conflicts</span>');

    const unknown = hoverCard(withObservations({ mergeability: mergeability(null, 'unknown') }));
    expect(unknown).not.toContain('No conflicts</span>');
    expect(unknown).not.toContain('Conflicts detected');
  });

  it('treats mergeability for a different head as unknown', () => {
    const html = hoverCard(
      withObservations({
        mergeability: {
          headSha: OTHER_HEAD,
          baseSha: BASE,
          baseRef: 'main',
          mergeable: false,
          state: 'dirty',
          observedAt: NOW.toString(),
        },
      })
    );
    expect(html).not.toContain('Conflicts detected');
    expect(html).not.toContain('>main</span>');
  });

  it('shows a partial warning for unavailable sources without inventing freshness', () => {
    const html = hoverCard(
      withObservations({
        truncated: true,
        unavailable: ['checks', 'statuses', 'reviews'],
      })
    );
    expect(html).toContain(
      'Unavailable from GitHub: check runs, commit statuses, reviews and threads.'
    );
    expect(html).toContain('Partial observations; some evidence is missing.');
    expect(html).toContain('Synced');
    expect(html).not.toContain('just now');
    expect(html).not.toContain('less than a minute ago');
  });
});

describe('prop metadata', () => {
  it('rerenders from updated props with the winning metadata', () => {
    const first = hoverCard();
    expect(first).toContain('Update checks');
    expect(first).toContain('>open<');
    expect(first).toContain('aaaaaaa');
    expect(first).toContain('Approved');

    const second = hoverCard({
      ...pr,
      state: 'merged',
      title: 'Merged elsewhere',
      headSha: OTHER_HEAD,
      reviewDecision: 'changes_requested',
      observations: { ...observations, checks: { total: 4, failed: 0 } },
    });
    expect(second).toContain('Merged elsewhere');
    expect(second).toContain('>merged<');
    expect(second).toContain('bbbbbbb');
    expect(second).toContain('Changes requested');
    expect(second).toContain('4 total / 0 failed');
    expect(second).not.toContain('Update checks');
    expect(second).not.toContain('aaaaaaa');
    expect(second).not.toContain('Approved');
  });
});

describe('refresh action', () => {
  it('hides refresh while the cached row is recent', () => {
    const html = hoverCard({ ...pr, state: 'open', lastSyncedAt: RECENT });
    expect(html).not.toContain('Refresh pull request status');
  });

  it('shows refresh when the cached row is exactly at the throttle boundary', () => {
    const html = hoverCard({
      ...pr,
      state: 'open',
      lastSyncedAt: new Date(NOW - 60_000).toISOString(),
    });
    expect(html).toContain('Refresh pull request status');
  });

  it('shows refresh when the cached timestamp is invalid', () => {
    const html = hoverCard({ ...pr, state: 'open', lastSyncedAt: 'not-a-date' });
    expect(html).toContain('Refresh pull request status');
    expect(html).toContain('>unknown</span>');
  });

  it('shows refresh for an unsynced PR regardless of age', () => {
    const html = hoverCard({ ...pr, state: 'unknown', lastSyncedAt: RECENT });
    expect(html).toContain('Refresh pull request status');
    expect(html).toContain('Pull request status has not synced yet.');
  });

  it('only invalidates the session queries after a successful refresh', () => {
    hoverCard();
    const options = mutationOptions();
    expect(options.onSettled).toBeUndefined();
    options.onSuccess();
    expect(mockInvalidateQueries).toHaveBeenCalledTimes(3);
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['list'] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['search'] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['worktreeDetails'] });
  });

  it('disables refresh and spins while the mutation is pending', () => {
    mutationPending = true;
    const html = hoverCard();
    expect(html).toContain('disabled=""');
    expect(html).toContain('animate-spin');
    expect(mockMutate).not.toHaveBeenCalled();
  });
});
