import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PrReviewChecksSection } from './pr-review-checks-section';

type Run = {
  name: string;
  status: string;
  conclusion: string | null;
  appName: string | null;
  detailsUrl: string | null;
};

const query = vi.hoisted(() => ({
  data: {
    checkRuns: [] as {
      name: string;
      status: string;
      conclusion: string | null;
      appName: string | null;
      detailsUrl: string | null;
    }[],
    rollup: { total: 0, success: 0, failure: 0, pending: 0, skipped: 0 },
  },
  isLoading: false,
  isError: false,
  isFetching: false,
  error: undefined as unknown,
  refetch: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({ useQuery: () => query }));
vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeIn: { duration: (ms: number) => ({ __fadeIn: ms }) },
  FadeOut: { duration: (ms: number) => ({ __fadeOut: ms }) },
  LinearTransition: { duration: (ms: number) => ({ __linearTransition: ms }) },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Mirror the real argument flow: a count-bearing key resolves to its
    // displayCount, so a test can tell the header total from a status label.
    // `count` rides along and is spelled out, so the test proves the call
    // hands i18next the number it needs to pick a plural form.
    t: (key: string, options?: Record<string, unknown>) =>
      options && 'displayCount' in options
        ? `${key}=${String(options.displayCount)}${'count' in options ? `/${String(options.count)}` : ''}`
        : key,
  }),
}));
// The section is tested for which rows it renders and with what counts; the
// row component owns the collapsed/expanded interaction (its own suite).
vi.mock('@/components/pr-review/pr-review-checks-status-row', () => ({
  PrReviewChecksStatusRow: 'PrReviewChecksStatusRow',
}));
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
// The section's loading card renders the UI skeleton; the real one reaches
// expo-linear-gradient and the reanimated worklets, which stay unmocked here.
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
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

function run(name: string, status: string, conclusion: string | null): Run {
  return { name, status, conclusion, appName: null, detailsUrl: null };
}

let mounted: TestRenderer.ReactTestRenderer | undefined = undefined;

function mount() {
  act(() => {
    mounted = TestRenderer.create(
      createElement(PrReviewChecksSection, {
        owner: 'kilo',
        repo: 'cloud',
        number: 7,
        headSha: 'abc123',
      })
    );
  });
  const renderer = mounted;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function statusRows(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(node => String(node.type) === 'PrReviewChecksStatusRow');
}

function textNodes(renderer: TestRenderer.ReactTestRenderer, children: string) {
  return renderer.root.findAll(
    node => String(node.type) === 'Text' && node.props.children === children
  );
}

function setRuns(runs: Run[]) {
  query.data = {
    checkRuns: runs,
    rollup: { total: runs.length, success: 0, failure: 0, pending: 0, skipped: 0 },
  };
}

beforeEach(() => {
  query.isLoading = false;
  query.isError = false;
  query.isFetching = false;
  query.error = undefined;
  query.refetch.mockClear();
  setRuns([]);
});

afterEach(() => {
  act(() => {
    mounted?.unmount();
  });
  mounted = undefined;
});

describe('PrReviewChecksSection status groups', () => {
  it('renders one row per present status, in summary order, each counting its own runs', () => {
    // `queued` and `in_progress` are both pending; the `error` conclusion is
    // failure, exactly as the server rollup counts it.
    setRuns([
      run('active', 'in_progress', null),
      run('queued', 'queued', null),
      run('passed', 'completed', 'success'),
      run('failed', 'completed', 'failure'),
      run('errored', 'completed', 'error'),
      run('skipped', 'completed', 'skipped'),
    ]);
    const renderer = mount();

    const rows = statusRows(renderer);
    expect(rows.map(row => [row.props.status, row.props.count])).toEqual([
      ['success', 1],
      ['failure', 2],
      ['pending', 2],
      ['skipped', 1],
    ]);
    // The hairline sits between rows, never after the last one.
    expect(rows.map(row => row.props.showSeparator)).toEqual([true, true, true, false]);
    // Each row's expanded detail is exactly the checks it counts.
    expect(rows.map(row => (row.props.children as unknown[]).length)).toEqual([1, 2, 2, 1]);
  });

  it('buckets every run where the server rollup counts it, so no row contradicts the rollup', () => {
    // The reference is `rollupState` (apps/web/src/lib/github-pr-review/
    // mappers.ts): `cancelled` and `stale` are failures, `skipped` and
    // `neutral` are skipped, and a completed run with a null or unmapped
    // conclusion is pending — never skipped.
    setRuns([
      run('passed', 'completed', 'success'),
      run('failed', 'completed', 'failure'),
      run('errored', 'completed', 'error'),
      run('timed-out', 'completed', 'timed_out'),
      run('action-required', 'completed', 'action_required'),
      run('cancelled', 'completed', 'cancelled'),
      run('stale', 'completed', 'stale'),
      run('skipped', 'completed', 'skipped'),
      run('neutral', 'completed', 'neutral'),
      run('unmapped', 'completed', 'something-else'),
      run('no-conclusion', 'completed', null),
      run('running', 'in_progress', null),
      run('queued', 'queued', null),
    ]);
    const renderer = mount();

    const rows = statusRows(renderer);
    expect(rows.map(row => [row.props.status, row.props.count])).toEqual([
      ['success', 1],
      ['failure', 6],
      ['pending', 4],
      ['skipped', 2],
    ]);
    // Every run is in exactly one row: the counts sum to the card total.
    const counted = rows.reduce((sum, row) => sum + Number(row.props.count), 0);
    expect(counted).toBe(13);
  });

  it('renders exactly one row when only one status is present', () => {
    setRuns([run('passed', 'completed', 'success')]);
    const renderer = mount();

    const rows = statusRows(renderer);
    expect(rows.map(row => [row.props.status, row.props.count])).toEqual([['success', 1]]);
    expect(rows[0]?.props.showSeparator).toBe(false);
  });

  it('renders no row for a status the head commit has no checks for', () => {
    setRuns([run('active', 'in_progress', null), run('queued', 'queued', null)]);
    const renderer = mount();

    expect(statusRows(renderer).map(row => row.props.status)).toEqual(['pending']);
  });

  it('renders the card total through the checksCount key', () => {
    setRuns([
      run('passed', 'completed', 'success'),
      run('failed', 'completed', 'failure'),
      run('skipped', 'completed', 'skipped'),
    ]);
    const renderer = mount();

    // count picks the plural form; displayCount is the formatted total.
    expect(textNodes(renderer, 'prReview.checks.checksCount=3/3')).toHaveLength(1);
  });

  it('gives the header the raw total so a one-check PR selects the singular', () => {
    setRuns([run('passed', 'completed', 'success')]);
    const renderer = mount();

    expect(textNodes(renderer, 'prReview.checks.checksCount=1/1')).toHaveLength(1);
  });
});

describe('PrReviewChecksSection empty state', () => {
  it('reports no checks and offers the view-on-provider button, with no rows', () => {
    setRuns([]);
    const renderer = mount();

    expect(textNodes(renderer, 'prReview.checks.noChecksReported')).toHaveLength(1);
    expect(statusRows(renderer)).toHaveLength(0);
    expect(renderer.root.findAll(node => String(node.type) === 'Button')).toHaveLength(1);
  });
});

describe('PrReviewChecksSection error arms', () => {
  function mountError(code: string) {
    query.isError = true;
    query.error = { data: { code } };
    return mount();
  }

  it('shows the terminal not-found message with no button', () => {
    const renderer = mountError('NOT_FOUND');

    expect(textNodes(renderer, 'prReview.checks.notAvailable')).toHaveLength(1);
    expect(renderer.root.findAll(node => String(node.type) === 'Button')).toHaveLength(0);
  });

  it('shows the terminal permission message with no button', () => {
    const renderer = mountError('FORBIDDEN');

    expect(textNodes(renderer, 'prReview.checks.noAccess')).toHaveLength(1);
    expect(renderer.root.findAll(node => String(node.type) === 'Button')).toHaveLength(0);
  });

  it.each(['PRECONDITION_FAILED', 'UNAUTHORIZED'])(
    'shows the reconnect notice for %s with no button',
    code => {
      const renderer = mountError(code);

      expect(
        renderer.root.findAll(node => String(node.type) === 'PrReviewReconnectNotice')
      ).toHaveLength(1);
      expect(renderer.root.findAll(node => String(node.type) === 'Button')).toHaveLength(0);
    }
  );

  it('shows the retryable message and retries the query on press', () => {
    const renderer = mountError('INTERNAL_SERVER_ERROR');

    expect(textNodes(renderer, 'prReview.checks.couldNotLoad')).toHaveLength(1);
    const buttons = renderer.root.findAll(node => String(node.type) === 'Button');
    expect(buttons).toHaveLength(1);
    const retry = buttons[0];
    if (!retry) {
      throw new Error('the retry button did not render');
    }
    act(() => {
      (retry.props.onPress as () => void)();
    });
    expect(query.refetch).toHaveBeenCalledTimes(1);
  });
});
