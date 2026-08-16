/* eslint-disable typescript-eslint/no-deprecated, typescript-eslint/no-unsafe-call -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as fixed-part-row.mounted.test.tsx) */
import { type AssociatedPrData } from '@kilocode/cloud-agent-sdk';
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionPrBadge } from './session-pr-badge';
import { describePrBadge, normalizePrBadgeState } from './session-pr-badge-model';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  openExternalUrl: vi.fn(),
  useFeatureFlag: vi.fn(() => true),
}));

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock('@/components/ui/icons', () => ({
  CircleCheck: 'CircleCheck',
  CircleX: 'CircleX',
  GitMerge: 'GitMerge',
  GitPullRequest: 'GitPullRequest',
  GitPullRequestClosed: 'GitPullRequestClosed',
  GitPullRequestDraft: 'GitPullRequestDraft',
}));
vi.mock('@/components/ui/text', () => ({
  Text: 'Text',
}));
vi.mock('@/components/ui/skeleton', () => ({
  Skeleton: 'Skeleton',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    good: '#278150',
    warn: '#9F6612',
    mutedForeground: '#6F6A61',
    destructive: '#BE4E3F',
  }),
}));
vi.mock('@/lib/external-link', () => ({
  openExternalUrl: mocks.openExternalUrl,
}));
vi.mock('@/lib/analytics/posthog', () => ({
  FEATURE_FLAG_PR_REVIEW: 'mobile-pr-review',
  useFeatureFlag: mocks.useFeatureFlag,
}));

// ── Helpers ────────────────────────────────────────────────────────────────

type BadgePr = Omit<AssociatedPrData, 'reviewDecision' | 'reviewDecisionPending'> & {
  reviewDecision: 'approved' | 'changes_requested' | 'review_required' | null;
  reviewDecisionPending: boolean;
};

function pr(overrides: Partial<BadgePr> = {}): BadgePr {
  return {
    url: 'https://github.com/octocat/hello-world/pull/42',
    number: 42,
    state: 'open',
    title: null,
    headSha: null,
    lastSyncedAt: '2026-01-01T00:00:00.000Z',
    platform: 'github',
    reviewDecision: null,
    reviewDecisionPending: false,
    ...overrides,
  };
}

function badge(state: string, decision: BadgePr['reviewDecision'], pending = false) {
  return describePrBadge({
    state,
    number: 42,
    reviewDecision: decision,
    reviewDecisionPending: pending,
  });
}

async function renderBadge(props: {
  pr: BadgePr | null;
  loading: boolean;
}): Promise<TestRenderer.ReactTestRenderer> {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(createElement(SessionPrBadge, props));
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function findHost(
  root: TestRenderer.ReactTestInstance,
  type: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => node.type === type);
}

// ── Model ──────────────────────────────────────────────────────────────────

describe('normalizePrBadgeState', () => {
  it('maps each known state to itself', () => {
    expect(normalizePrBadgeState('open')).toBe('open');
    expect(normalizePrBadgeState('closed')).toBe('closed');
    expect(normalizePrBadgeState('merged')).toBe('merged');
    expect(normalizePrBadgeState('draft')).toBe('draft');
  });

  it('maps unrecognized states to unknown (never closed)', () => {
    expect(normalizePrBadgeState('unknown')).toBe('unknown');
    expect(normalizePrBadgeState('pending')).toBe('unknown');
    expect(normalizePrBadgeState('')).toBe('unknown');
  });
});

describe('describePrBadge', () => {
  it('renders open + approved as a check with a good accent', () => {
    expect(badge('open', 'approved')).toEqual({
      icon: 'check',
      accent: 'good',
      accessibilityLabel: 'open pull request #42',
    });
  });

  it('renders open + changes_requested as an x with a warn accent', () => {
    expect(badge('open', 'changes_requested')).toEqual({
      icon: 'x',
      accent: 'warn',
      accessibilityLabel: 'open pull request #42',
    });
  });

  it('renders open with no decision as a pull-request icon with a good accent', () => {
    expect(badge('open', null)).toEqual({
      icon: 'pull-request',
      accent: 'good',
      accessibilityLabel: 'open pull request #42',
    });
    expect(badge('open', 'review_required')).toEqual({
      icon: 'pull-request',
      accent: 'good',
      accessibilityLabel: 'open pull request #42',
    });
  });

  it('keeps the open icon and adds Updating to the label only for unknown', () => {
    expect(badge('unknown', null)).toEqual({
      icon: 'pull-request',
      accent: 'good',
      accessibilityLabel: 'Updating, open pull request #42',
    });
  });

  it('keeps the open icon and adds Updating to the label only when pending', () => {
    expect(badge('open', null, true)).toEqual({
      icon: 'pull-request',
      accent: 'good',
      accessibilityLabel: 'Updating, open pull request #42',
    });
  });

  it('renders draft with a muted accent', () => {
    expect(badge('draft', null)).toEqual({
      icon: 'draft',
      accent: 'muted',
      accessibilityLabel: 'draft pull request #42',
    });
  });

  it('renders merged with a merge icon', () => {
    expect(badge('merged', null)).toEqual({
      icon: 'merge',
      accent: 'muted',
      accessibilityLabel: 'merged pull request #42',
    });
  });

  it('renders closed with a destructive accent', () => {
    expect(badge('closed', null)).toEqual({
      icon: 'closed',
      accent: 'destructive',
      accessibilityLabel: 'closed pull request #42',
    });
  });
});

// ── Component ──────────────────────────────────────────────────────────────

describe('SessionPrBadge mounted', () => {
  beforeEach(() => {
    mocks.push.mockClear();
    mocks.openExternalUrl.mockClear();
    mocks.useFeatureFlag.mockReturnValue(true);
  });

  it('reserves a 52pt skeleton while loading', async () => {
    const renderer = await renderBadge({ pr: null, loading: true });

    const skeletons = findHost(renderer.root, 'Skeleton');
    expect(skeletons).toHaveLength(1);
    expect(skeletons[0]?.props.className).toContain('w-[52px]');
  });

  it('renders nothing after the fetch when there is no PR', async () => {
    const renderer = await renderBadge({ pr: null, loading: false });

    expect(renderer.toJSON()).toBeNull();
  });

  it('renders the badge with the state-derived accessibility label', async () => {
    const renderer = await renderBadge({
      pr: pr({ state: 'open', reviewDecision: 'approved' }),
      loading: false,
    });

    const pressable = findHost(renderer.root, 'Pressable')[0];
    expect(pressable?.props.accessibilityLabel).toBe('open pull request #42');
    expect(findHost(renderer.root, 'CircleCheck')).toHaveLength(1);
  });

  it('navigates in-app for a GitHub PR on press', async () => {
    const renderer = await renderBadge({
      pr: pr({ platform: 'github', url: 'https://github.com/octocat/hello-world/pull/42' }),
      loading: false,
    });

    const pressable = findHost(renderer.root, 'Pressable')[0];
    pressable?.props.onPress();

    expect(mocks.push).toHaveBeenCalledWith('/(app)/pr-review/octocat/hello-world/42');
    expect(mocks.openExternalUrl).not.toHaveBeenCalled();
  });

  it('opens the browser for a GitLab PR on press', async () => {
    const renderer = await renderBadge({
      pr: pr({
        platform: 'gitlab',
        url: 'https://gitlab.com/octocat/hello-world/-/merge_requests/42',
      }),
      loading: false,
    });

    const pressable = findHost(renderer.root, 'Pressable')[0];
    pressable?.props.onPress();

    expect(mocks.openExternalUrl).toHaveBeenCalledWith(
      'https://gitlab.com/octocat/hello-world/-/merge_requests/42',
      { label: 'pull request' }
    );
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('opens the browser for a GitHub PR when the PR review flag is off', async () => {
    mocks.useFeatureFlag.mockReturnValue(false);
    const renderer = await renderBadge({
      pr: pr({ platform: 'github', url: 'https://github.com/octocat/hello-world/pull/42' }),
      loading: false,
    });

    const pressable = findHost(renderer.root, 'Pressable')[0];
    pressable?.props.onPress();

    expect(mocks.openExternalUrl).toHaveBeenCalledWith(
      'https://github.com/octocat/hello-world/pull/42',
      { label: 'pull request' }
    );
    expect(mocks.push).not.toHaveBeenCalled();
  });
});
