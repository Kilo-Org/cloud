/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the repository's native-free mounted test tool. */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { SpinningIcon } from '@/components/ui/spinning-icon';
import { PrReviewChecksSection } from './pr-review-checks-section';

const query = vi.hoisted(() => ({
  data: {
    checkRuns: [
      {
        name: 'Running',
        status: 'in_progress',
        conclusion: null,
        appName: null,
        detailsUrl: null,
      },
      {
        name: 'Queued',
        status: 'queued',
        conclusion: null,
        appName: null,
        detailsUrl: null,
      },
      {
        name: 'Passed',
        status: 'completed',
        conclusion: 'success',
        appName: null,
        detailsUrl: null,
      },
      {
        name: 'Failed',
        status: 'completed',
        conclusion: 'failure',
        appName: null,
        detailsUrl: null,
      },
    ],
    rollup: { total: 4, success: 1, failure: 1, pending: 2, skipped: 0 },
  },
  isLoading: false,
  isError: false,
  isFetching: false,
  refetch: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({ useQuery: () => query }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/icons', () => ({
  AlertTriangle: 'AlertTriangle',
  CheckCircle2: 'CheckCircle2',
  Circle: 'Circle',
  ExternalLink: 'ExternalLink',
  Loader2: 'Loader2',
  MinusCircle: 'MinusCircle',
  XCircle: 'XCircle',
}));
vi.mock('@/components/ui/spinning-icon', () => ({ SpinningIcon: 'SpinningIcon' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/pr-review/pr-review-reconnect-notice', () => ({
  PrReviewReconnectNotice: 'PrReviewReconnectNotice',
}));
vi.mock('@/i18n', () => ({ i18n: { language: 'en', t: (key: string) => key } }));
vi.mock('@/lib/format', () => ({
  formatList: (parts: string[]) => parts.join(', '),
  formatNumber: String,
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    destructive: 'red',
    foreground: 'black',
    good: 'green',
    mutedForeground: 'gray',
    warn: 'orange',
  }),
}));
vi.mock('@/lib/external-link', () => ({ openExternalUrl: vi.fn() }));
vi.mock('@/lib/pr-review/classify-pr-review-query-state', () => ({
  classifyPrReviewQueryState: () => ({ kind: 'retryable' }),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({ githubPrReview: { listChecks: { queryOptions: () => ({}) } } }),
}));

describe('PrReviewChecksSection check status icons', () => {
  it('rotates pending check icons but not finished check icons', () => {
    const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
    act(() => {
      ref.current = TestRenderer.create(
        createElement(PrReviewChecksSection, {
          owner: 'org',
          repo: 'repo',
          number: 1,
          headSha: 'head',
        })
      );
    });
    const renderer = ref.current;
    if (!renderer) {
      throw new Error('renderer was not created');
    }

    expect(renderer.root.findAllByType(SpinningIcon)).toHaveLength(2);
    expect(renderer.root.findAllByType(SpinningIcon).map(node => node.props.icon)).toEqual([
      'Loader2',
      'Loader2',
    ]);
    expect(renderer.root.findAll(node => String(node.type) === 'CheckCircle2')).toHaveLength(1);
    expect(renderer.root.findAll(node => String(node.type) === 'XCircle')).toHaveLength(1);

    act(() => {
      renderer.unmount();
    });
  });
});
