/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to test React Native structure */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { PrReviewChecksSection } from './pr-review-checks-section';

const query = vi.hoisted(() => ({
  data: {
    checkRuns: [
      {
        name: 'active',
        status: 'in_progress',
        conclusion: null,
        appName: null,
        detailsUrl: null,
      },
      {
        name: 'queued',
        status: 'queued',
        conclusion: null,
        appName: null,
        detailsUrl: null,
      },
      {
        name: 'passed',
        status: 'completed',
        conclusion: 'success',
        appName: null,
        detailsUrl: null,
      },
      {
        name: 'failed',
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
}));

vi.mock('@tanstack/react-query', () => ({ useQuery: () => query }));
vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/pr-review/pr-review-reconnect-notice', () => ({
  PrReviewReconnectNotice: 'PrReviewReconnectNotice',
}));
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
vi.mock('@/i18n', () => ({ i18n: { language: 'en', t: (key: string) => key } }));
vi.mock('@/lib/external-link', () => ({ openExternalUrl: vi.fn() }));
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
    warn: 'yellow',
  }),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({ githubPrReview: { listChecks: { queryOptions: () => ({}) } } }),
}));
vi.mock('@/lib/utils', () => ({ cn: (...values: string[]) => values.filter(Boolean).join(' ') }));

describe('PrReviewChecksSection', () => {
  it('spins only pending check icons', () => {
    const rendered: { current: TestRenderer.ReactTestRenderer | null } = { current: null };
    act(() => {
      rendered.current = TestRenderer.create(
        createElement(PrReviewChecksSection, {
          owner: 'kilo',
          repo: 'cloud',
          number: 7,
          headSha: 'abc123',
        })
      );
    });
    const renderer = rendered.current;
    if (!renderer) {
      throw new Error('renderer was not created');
    }

    const icons = renderer.root.findAll(node => String(node.type) === 'SpinningIcon');
    expect(icons.map(icon => icon.props.spinning)).toEqual([true, true, false, false]);
  });
});
