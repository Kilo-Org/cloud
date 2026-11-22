/* eslint-disable max-lines -- the status-group, empty-state and error-arm suites share one mock harness and one fixture in this file, so the section's every state is asserted against one wiring. */
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PrReviewChecksSection } from './pr-review-checks-section';

import {
  type ProviderPrScope,
  ProviderPrScopeProvider,
  ProviderPrWebUrlProvider,
} from '@/lib/pr-review/provider-pr-ref';

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
    truncated: undefined as boolean | undefined,
  },
  isError: false,
  isFetching: false,
  error: undefined as unknown,
  refetch: vi.fn(),
}));

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
// The recovery rows a provider scope gets instead of the terminal card: they
// mount a query client and the provider's connection check, which this file's
// harness has neither of, so they are a host here. The mounted suite
// (`pr-review-checks-section.mounted.test.tsx`) mounts the real component and
// asserts what it does.
vi.mock('@/components/pr-review/pr-review-unavailable-actions', () => ({
  PrReviewUnavailableActions: 'PrReviewUnavailableActions',
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/card', () => ({ Card: 'Card' }));
vi.mock('@/components/ui/row-group', () => ({ RowGroup: 'RowGroup' }));
vi.mock('@/components/ui/section', () => ({ Section: 'Section' }));
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

function run(name: string, status: string, conclusion: string | null): Run {
  return { name, status, conclusion, appName: null, detailsUrl: null };
}

let mounted: TestRenderer.ReactTestRenderer | undefined = undefined;

/** The URL the review screen publishes for this PR (the GitHub arm's host). */
const PR_WEB_URL = 'https://github.com/kilo/cloud/pull/7';

/**
 * Mount the section. `PR_WEB_URL` is what the review screen publishes for the
 * loaded change; `scope` is the provider route's scope, and leaving it out is
 * exactly the GitHub route's tree — `useProviderPrScope` then falls back to
 * the GitHub triple, so those cases exercise the GitHub arm.
 */
function mount(serverWebUrl: string | null = PR_WEB_URL, scope?: ProviderPrScope) {
  const section = createElement(PrReviewChecksSection, {
    owner: 'kilo',
    repo: 'cloud',
    number: 7,
    checks: query,
  });
  act(() => {
    mounted = TestRenderer.create(
      <ProviderPrWebUrlProvider value={serverWebUrl}>
        {scope ? (
          <ProviderPrScopeProvider value={scope}>{section}</ProviderPrScopeProvider>
        ) : (
          section
        )}
      </ProviderPrWebUrlProvider>
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
    truncated: undefined,
  };
}

beforeEach(() => {
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
    // Each row's expanded detail is exactly the checks it counts.
    expect(rows.map(row => (row.props.children as unknown[]).length)).toEqual([1, 2, 2, 1]);
    // The groups sit in the shared group surface, which owns the hairlines.
    expect(renderer.root.findAll(node => String(node.type) === 'RowGroup')).toHaveLength(1);
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

  it('leaves the total out when one status row already states it', () => {
    // Design review at the PR review overview fixture: the card printed "1
    // check" directly above "1 passed", so the same number appeared twice.
    setRuns([run('passed', 'completed', 'success')]);
    const renderer = mount();

    expect(textNodes(renderer, 'prReview.checks.checksCount=1/1')).toHaveLength(0);
    // The one status row still carries the count the strip used to repeat.
    expect(statusRows(renderer).map(row => [row.props.status, row.props.count])).toEqual([
      ['success', 1],
    ]);
  });

  it('keeps the total when the listing was cut and one row would claim to be complete', () => {
    setRuns([run('passed', 'completed', 'success')]);
    query.data = { ...query.data, truncated: true };
    const renderer = mount();

    expect(textNodes(renderer, 'prReview.checks.checksCount=1+/1')).toHaveLength(1);
  });

  it('marks the header total as a lower bound when the server cut the listing', () => {
    // The server read the listing up to its page ceiling and said so, so the
    // rows are the entries it read rather than every entry the ref has; the
    // header count must not read as a total.
    setRuns([run('passed', 'completed', 'success'), run('failed', 'completed', 'failure')]);
    query.data = { ...query.data, truncated: true };
    const renderer = mount();

    expect(textNodes(renderer, 'prReview.checks.checksCount=2+/2')).toHaveLength(1);
  });

  it('leaves the header total unmarked when the listing was read in full', () => {
    setRuns([run('passed', 'completed', 'success'), run('failed', 'completed', 'failure')]);
    const renderer = mount();

    expect(textNodes(renderer, 'prReview.checks.checksCount=2/2')).toHaveLength(1);
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

  it('offers no link until the screen publishes the loaded PR URL', () => {
    setRuns([]);
    const renderer = mount(null);

    expect(textNodes(renderer, 'prReview.checks.noChecksReported')).toHaveLength(1);
    expect(renderer.root.findAll(node => String(node.type) === 'Button')).toHaveLength(0);
  });
});

describe('PrReviewChecksSection error arms', () => {
  function mountError(code: string) {
    query.isError = true;
    query.error = { data: { code } };
    return mount();
  }

  it('shows the terminal not-found message on the GitHub arm, with no button', () => {
    // This harness publishes no provider scope, so the section reads the
    // GitHub triple: GitHub's NOT_FOUND is a genuinely missing ref, so it
    // stays terminal. The provider scopes' recovery rows are asserted here too
    // (they are a host in this file) and mounted for real in
    // `pr-review-checks-section.mounted.test.tsx`.
    const renderer = mountError('NOT_FOUND');

    expect(textNodes(renderer, 'prReview.checks.notAvailable')).toHaveLength(1);
    expect(renderer.root.findAll(node => String(node.type) === 'Button')).toHaveLength(0);
    expect(
      renderer.root.findAll(node => String(node.type) === 'PrReviewUnavailableActions')
    ).toHaveLength(0);
  });

  it.each([
    {
      platform: 'GitLab',
      scope: {
        ref: { platform: 'gitlab', projectPath: 'group/sub/repo', mrIid: 12 },
        organizationId: null,
      } satisfies ProviderPrScope,
    },
    {
      platform: 'Bitbucket',
      scope: {
        ref: { platform: 'bitbucket', workspace: 'acme', repoSlug: 'repo', prId: 12 },
        organizationId: 'org-1',
      } satisfies ProviderPrScope,
    },
  ])('swaps the terminal card for the recovery rows on a $platform scope', ({ scope }) => {
    // GitLab and Bitbucket fold their connection failures into the same
    // NOT_FOUND a removed item produces, so the card keeps the checks cause and
    // names the provider connection, and the state carries the recovery rows,
    // not the terminal card. The rows are a host here (see the mock above); the
    // mounted suite mounts the real ones.
    query.isError = true;
    query.error = { data: { code: 'NOT_FOUND' } };
    const renderer = mount(PR_WEB_URL, scope);

    expect(textNodes(renderer, 'prReview.checks.providerNotAvailable')).toHaveLength(1);
    expect(textNodes(renderer, 'prReview.terms.unavailableDescription')).toHaveLength(0);
    expect(textNodes(renderer, 'prReview.checks.notAvailable')).toHaveLength(0);
    const actions = renderer.root.findAll(
      node => String(node.type) === 'PrReviewUnavailableActions'
    );
    expect(actions).toHaveLength(1);
    const retry = actions[0]?.props.onRetry as (() => void) | undefined;
    if (!retry) {
      throw new Error('the recovery rows did not render');
    }
    act(() => {
      retry();
    });
    expect(query.refetch).toHaveBeenCalledTimes(1);
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
