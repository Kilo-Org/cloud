/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer for RN trees under vitest (node env, no jsdom). */

// Outcome-first detail-screen contract: the screen leads with the conclusion
// (status + error), then findings, council, gate, and metadata. A null council
// result renders "No findings" (not a success checkmark). A permanent error
// (NOT_FOUND/FORBIDDEN/UNAUTHORIZED) shows no Retry; a transient error does.

import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ReviewDetailScreen } from './review-detail-screen';

const detail = vi.hoisted(() => ({
  isLoading: false,
  isError: false,
  isFetching: false,
  error: null as { data?: { code?: string } } | null,
  data: null as unknown,
  refetch: vi.fn(),
}));

const queryErrors = vi.hoisted(() => ({
  errors: [] as { variant?: string; title?: string; onRetry?: () => void }[],
}));

const buttons = vi.hoisted(() => ({
  rendered: [] as { children?: unknown; onPress?: () => void }[],
}));

vi.mock('react-native', () => ({
  View: 'View',
  Alert: { alert: vi.fn() },
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeIn: { duration: vi.fn() },
  FadeOut: { duration: vi.fn() },
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('expo-haptics', () => ({
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Warning: 'warning', Success: 'success' },
}));
vi.mock('@kilocode/app-shared/code-review', () => ({
  isCancellableReviewStatus: () => false,
  isRetriggerableReviewStatus: () => false,
}));
vi.mock('@kilocode/app-shared/utils', () => ({
  formatDollars: String,
  fromMicrodollars: (value: unknown) => value,
}));
vi.mock('@/components/code-reviewer/review-list-screen', () => ({
  statusMeta: (status: string) => ({
    label: status === 'completed' ? 'Completed' : status,
    className: 'text-good',
  }),
}));
vi.mock('@/components/query-error', () => ({
  QueryError: (props: { variant?: string; title?: string; onRetry?: () => void }) => {
    queryErrors.errors.push(props);
    return null;
  },
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: () => null }));
vi.mock('@/components/ui/button', () => ({
  Button: (props: { children?: unknown; onPress?: () => void }) => {
    buttons.rendered.push(props);
    return props.children;
  },
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: () => null }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/tab-screen', () => ({
  TabScreenScrollView: ({ children }: { children?: unknown }) => children,
}));
vi.mock('@/lib/analytics/posthog', () => ({
  FEATURE_FLAG_PR_REVIEW: 'pr-review',
  useFeatureFlag: () => true,
}));
vi.mock('@/lib/code-reviewer-open-pr-destination', () => ({
  resolveCodeReviewerOpenPrDestination: () => ({ kind: 'external' }),
}));
vi.mock('@/lib/code-reviewer-config', () => ({
  reviewerPlatformLabel: () => 'GitHub',
}));
vi.mock('@/lib/external-link', () => ({ openExternalUrl: vi.fn() }));
vi.mock('@/lib/hooks/use-code-reviews', () => ({
  useReviewDetail: () => detail,
  useCancelReview: () => ({ isPending: false, mutate: vi.fn() }),
  useRetriggerReview: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock('@/lib/profile-agent-navigation', () => ({ getPrReviewPath: vi.fn() }));
vi.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  parseTimestamp: (value: unknown) => value,
  timeAgo: () => 'now',
}));

function collectText(node: unknown): string[] {
  if (node == null) {
    return [];
  }
  if (typeof node === 'string') {
    return [node];
  }
  if (Array.isArray(node)) {
    return node.flatMap(n => collectText(n));
  }
  if (typeof node === 'object' && 'children' in node) {
    return collectText((node as { children?: unknown }).children);
  }
  return [];
}

function makeReview(over: Record<string, unknown> = {}) {
  return {
    pr_title: 'Fix login',
    repo_full_name: 'org/repo',
    pr_number: 42,
    pr_author: 'alice',
    pr_url: 'https://github.com/org/repo/pull/42',
    status: 'completed',
    error_message: null,
    head_ref: 'feature/x',
    base_ref: 'main',
    platform: 'github',
    model: 'claude',
    created_at: '2024-01-01T00:00:00.000Z',
    started_at: null,
    completed_at: null,
    total_cost_musd: null,
    check_run_id: 123,
    rawIdsRedacted: false,
    manual_config: { agentConfig: { gate_threshold: 'critical' } },
    council_result: null,
    ...over,
  };
}

function renderScreen(): string[] {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(ReviewDetailScreen, { scope: 'personal', reviewId: 'rev-1' })
    );
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return collectText(renderer.toJSON());
}

beforeEach(() => {
  detail.isLoading = false;
  detail.isError = false;
  detail.isFetching = false;
  detail.error = null;
  detail.data = null;
  detail.refetch.mockClear();
  queryErrors.errors = [];
  buttons.rendered = [];
});

describe('ReviewDetailScreen outcome-first order', () => {
  it('leads with conclusion, then findings, council, gate, then metadata', () => {
    detail.data = {
      success: true,
      review: makeReview({
        council_result: {
          decision: 'block',
          aggregationStrategy: 'unanimous',
          specialists: [
            {
              id: 'sec',
              name: 'Security',
              vote: 'block',
              findings: [{ path: 'a.ts', line: 1, severity: 'critical', rationale: 'unsafe' }],
            },
          ],
        },
      }),
      tokenUsage: { input: 0, output: 0 },
    };

    const texts = renderScreen();

    const idx = (marker: string) => texts.indexOf(marker);
    expect(idx('Completed')).toBeGreaterThanOrEqual(0);
    expect(idx('Findings')).toBeGreaterThan(idx('Completed'));
    expect(idx('Council')).toBeGreaterThan(idx('Findings'));
    expect(idx('Gate')).toBeGreaterThan(idx('Council'));
    expect(idx('Details')).toBeGreaterThan(idx('Gate'));
  });

  it('shows the error message inside the conclusion', () => {
    detail.data = {
      success: true,
      review: makeReview({ error_message: 'review crashed' }),
      tokenUsage: { input: 0, output: 0 },
    };

    const texts = renderScreen();

    expect(texts).toContain('review crashed');
    expect(texts.indexOf('Completed')).toBeLessThan(texts.indexOf('review crashed'));
  });
});

describe('ReviewDetailScreen empty council', () => {
  it('renders "No findings" for a null council result (not a success checkmark)', () => {
    detail.data = {
      success: true,
      review: makeReview({ council_result: null }),
      tokenUsage: { input: 0, output: 0 },
    };

    const texts = renderScreen();

    expect(texts).toContain('No findings');
    expect(texts).not.toContain('Council');
  });

  it('renders "No findings" when every specialist has zero findings', () => {
    detail.data = {
      success: true,
      review: makeReview({
        council_result: { decision: 'pass', aggregationStrategy: 'unanimous', specialists: [] },
      }),
      tokenUsage: { input: 0, output: 0 },
    };

    const texts = renderScreen();

    expect(texts).toContain('No findings');
  });
});

describe('ReviewDetailScreen redacted check run', () => {
  it('renders "Hidden" (not "None") when the check run is redacted', () => {
    detail.data = {
      success: true,
      review: makeReview({ check_run_id: null, rawIdsRedacted: true }),
      tokenUsage: { input: 0, output: 0 },
    };

    const texts = renderScreen();

    expect(texts).toContain('Hidden');
    expect(texts).not.toContain('None');
  });
});

describe('ReviewDetailScreen findings pagination', () => {
  it('keeps earlier findings visible when "Show more" reveals the 21st', () => {
    const findings = Array.from({ length: 21 }, (_, i) => ({
      path: `f${i}.ts`,
      severity: 'nitpick',
      rationale: `r${i}`,
    }));
    detail.data = {
      success: true,
      review: makeReview({
        council_result: {
          decision: 'block',
          aggregationStrategy: 'unanimous',
          specialists: [{ id: 'sec', name: 'Security', vote: 'block', findings }],
        },
      }),
      tokenUsage: { input: 0, output: 0 },
    };

    const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
    act(() => {
      ref.current = TestRenderer.create(
        createElement(ReviewDetailScreen, { scope: 'personal', reviewId: 'rev-1' })
      );
    });
    const renderer = ref.current;
    if (!renderer) {
      throw new Error('renderer was not created');
    }

    const before = collectText(renderer.toJSON());
    expect(before).toContain('f0.ts');
    expect(before).toContain('f19.ts');
    expect(before).not.toContain('f20.ts');

    const showMore = buttons.rendered.find(button => {
      const child = button.children as { props?: { children?: unknown } } | null;
      return child?.props?.children === 'Show more';
    });
    expect(showMore).toBeDefined();
    const onPress = showMore?.onPress;
    expect(onPress).toBeDefined();
    if (onPress) {
      act(() => {
        onPress();
      });
    }

    const after = collectText(renderer.toJSON());
    expect(after).toContain('f0.ts');
    expect(after).toContain('f19.ts');
    expect(after).toContain('f20.ts');
  });
});

describe('ReviewDetailScreen error states', () => {
  it('shows a permanent error with no Retry for NOT_FOUND', () => {
    detail.isError = true;
    detail.error = { data: { code: 'NOT_FOUND' } };
    detail.data = null;

    renderScreen();

    expect(queryErrors.errors).toHaveLength(1);
    expect(queryErrors.errors[0]?.variant).toBe('not-found');
    expect(queryErrors.errors[0]?.onRetry).toBeUndefined();
  });

  it('shows a transient error with Retry for an unknown code', () => {
    detail.isError = true;
    detail.error = { data: { code: 'INTERNAL_SERVER_ERROR' } };
    detail.data = null;

    renderScreen();

    expect(queryErrors.errors).toHaveLength(1);
    expect(queryErrors.errors[0]?.variant).toBe('server');
    expect(queryErrors.errors[0]?.onRetry).toBeDefined();
  });
});
