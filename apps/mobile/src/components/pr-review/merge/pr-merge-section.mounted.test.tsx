// The bounded mergeability poll owns one interval for the whole `unknown`
// window. The orchestrator re-creates its refetch callback on every render, so
// the timer must read the current callback through a ref rather than through
// the closure it was created with: a re-render must reach the next tick without
// restarting (and so extending) the bounded poll.

import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { act, TestRenderer } from '@/test/renderer';

import { PrMergeSection } from './pr-merge-section';
import { type PrOverviewDto } from '@/lib/pr-review/merge/merge-blocked-reasons';

const routerPush = vi.fn();

vi.mock('expo-router', () => ({ useRouter: () => ({ push: routerPush }) }));

vi.mock('react-native', () => ({ View: 'View', ActivityIndicator: 'ActivityIndicator' }));

vi.mock('@/components/ui/icons', () => ({
  AlertTriangle: 'AlertTriangle',
  GitBranch: 'GitBranch',
  GitMerge: 'GitMerge',
  GitPullRequest: 'GitPullRequest',
  RefreshCw: 'RefreshCw',
  ShieldAlert: 'ShieldAlert',
  XCircle: 'XCircle',
}));

vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000000', mutedForeground: '#6F6A61' }),
}));
vi.mock('@/lib/pr-review/merge/use-pr-merge-mutations', () => ({
  useUpdateBranchMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDisableAutoMergeMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@/components/pr-review/merge/pr-merge-section-parts', () => ({
  AutoMergeEnabledBanner: 'AutoMergeEnabledBanner',
  BlockedPanel: 'BlockedPanel',
  MergeabilityCheckingRow: 'MergeabilityCheckingRow',
  MergeabilityTimedOutRow: 'MergeabilityTimedOutRow',
  TerminalChip: 'TerminalChip',
}));

const POLL_INTERVAL_MS = 3000;
const POLL_MAX_TICKS = 10;

type Renderer = TestRenderer.ReactTestRenderer;

function overview(overrides: Partial<PrOverviewDto> = {}): PrOverviewDto {
  const fixture: PrOverviewDto = {
    number: 1,
    title: 'Feature',
    bodyMarkdown: null,
    author: { login: 'octocat', avatarUrl: null },
    state: 'open',
    draft: false,
    baseRef: 'main',
    headRef: 'feature/x',
    isCrossRepo: false,
    headRepoFullName: null,
    headSha: 'a'.repeat(40),
    prNodeId: 'PR_node_1',
    counts: { commits: 1, changedFiles: 1, additions: 1, deletions: 0 },
    // GitHub has not answered the mergeability re-check yet.
    mergeable: null,
    mergeableState: null,
    autoMerge: null,
    reviewDecision: null,
    labels: [],
    assignees: [],
    reviewers: [],
    linkedIssues: [],
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    closedAt: null,
    mergedAt: null,
    mergedBy: null,
    commentCount: 0,
    repo: {
      allowMergeCommit: true,
      allowSquashMerge: true,
      allowRebaseMerge: true,
      allowAutoMerge: false,
      deleteBranchOnMerge: false,
      allowUpdateBranch: true,
      viewerCanPush: true,
      viewerCanAdmin: true,
      viewerLogin: 'octocat',
    },
  };
  return { ...fixture, ...overrides };
}

function sectionElement(
  data: PrOverviewDto,
  onRefetch: () => Promise<void>
): ReturnType<typeof createElement> {
  return createElement(PrMergeSection, {
    owner: 'octocat',
    repo: 'hello',
    overview: data,
    onRefetch,
    isRefetching: false,
  });
}

function countOf(renderer: Renderer, type: string): number {
  return renderer.root.findAll(node => String(node.type) === type).length;
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

let renderer: Renderer | undefined = undefined;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});

afterEach(() => {
  renderer?.unmount();
  renderer = undefined;
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('PrMergeSection mergeability poll', () => {
  it('calls the callback a later render supplies, on the same bounded budget', () => {
    const first = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const second = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    act(() => {
      renderer = TestRenderer.create(sectionElement(overview(), first));
    });
    const mounted = renderer;
    if (!mounted) {
      throw new Error('the merge section did not mount');
    }
    expect(countOf(mounted, 'MergeabilityCheckingRow')).toBe(1);

    advance(POLL_INTERVAL_MS);
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();

    // A refetch callback of a new identity while the poll runs.
    act(() => {
      mounted.update(sectionElement(overview(), second));
    });

    advance(POLL_INTERVAL_MS);
    expect(second).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledOnce();

    // The interval was not restarted: the tick budget carries on from tick 2,
    // so ticks 3..9 still poll and tick 10 times out.
    advance(POLL_INTERVAL_MS);
    expect(second).toHaveBeenCalledTimes(2);

    advance(POLL_INTERVAL_MS * (POLL_MAX_TICKS - 3));
    // Ticks 2..9 poll (8 calls), tick 10 surfaces the timeout row instead.
    expect(second).toHaveBeenCalledTimes(POLL_MAX_TICKS - 2);
    expect(countOf(mounted, 'MergeabilityTimedOutRow')).toBe(1);
    expect(countOf(mounted, 'MergeabilityCheckingRow')).toBe(0);

    advance(POLL_INTERVAL_MS * 5);
    expect(second).toHaveBeenCalledTimes(POLL_MAX_TICKS - 2);
  });

  it('stops polling when mergeability resolves', () => {
    const onRefetch = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    act(() => {
      renderer = TestRenderer.create(sectionElement(overview(), onRefetch));
    });
    const mounted = renderer;
    if (!mounted) {
      throw new Error('the merge section did not mount');
    }
    advance(POLL_INTERVAL_MS);
    expect(onRefetch).toHaveBeenCalledOnce();

    act(() => {
      mounted.update(
        sectionElement(overview({ mergeable: true, mergeableState: 'clean' }), onRefetch)
      );
    });
    expect(countOf(mounted, 'MergeabilityCheckingRow')).toBe(0);

    advance(POLL_INTERVAL_MS * (POLL_MAX_TICKS + 5));
    expect(onRefetch).toHaveBeenCalledOnce();
  });
});
