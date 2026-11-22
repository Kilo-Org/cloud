/* eslint-disable max-lines -- the collapsed-row, expand/collapse, view-on-provider and not-found suites share one fixture and mock harness in this file. */
import { type ComponentProps, createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { QueryClientProvider } from '@tanstack/react-query';

import { ExternalLink } from '@/components/ui/icons';
import { SpinningIcon } from '@/components/ui/spinning-icon';
import {
  type ProviderPrScope,
  ProviderPrScopeProvider,
  ProviderPrWebUrlProvider,
} from '@/lib/pr-review/provider-pr-ref';
import { openExternalUrl } from '@/lib/external-link';
import { createTestQueryClient } from '@/test/render-with-providers';
import { PrReviewChecksSection } from './pr-review-checks-section';
import { PrReviewUnavailableActions } from './pr-review-unavailable-actions';

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
  isError: false,
  isFetching: false,
  error: undefined as unknown,
  refetch: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Resolve a count-bearing key to `"<count> <word>"` so the collapsed row
    // labels read the way the app renders them ("1 passed", "2 pending").
    t: (key: string, options?: Record<string, unknown>) => {
      const word = key.split('.').pop() ?? key;
      return options && 'displayCount' in options ? `${String(options.displayCount)} ${word}` : key;
    },
  }),
}));
vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeIn: { duration: (ms: number) => ({ __fadeIn: ms }) },
  FadeOut: { duration: (ms: number) => ({ __fadeOut: ms }) },
  LinearTransition: { duration: (ms: number) => ({ __linearTransition: ms }) },
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/icons', () => ({
  AlertTriangle: 'AlertTriangle',
  CheckCircle2: 'CheckCircle2',
  ChevronDown: 'ChevronDown',
  ChevronUp: 'ChevronUp',
  Circle: 'Circle',
  ExternalLink: 'ExternalLink',
  Loader2: 'Loader2',
  MinusCircle: 'MinusCircle',
  // The two glyphs the recovery actions carry; the suite below mounts that
  // component for real.
  PlugZap: 'PlugZap',
  RotateCcw: 'RotateCcw',
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
    // The recovery actions' shared `StateAction` reads the disabled ink.
    primaryForeground: 'white',
    warn: 'orange',
  }),
  useMutedDisabledInk: () => 'gray',
}));
vi.mock('@/lib/external-link', () => ({ openExternalUrl: vi.fn() }));
// The settled read carries no error in the row suites, so only the not-found
// suite below reaches this: it answers the one arm that suite drives and the
// generic retryable arm for anything else.
vi.mock('@/lib/pr-review/classify-pr-review-query-state', () => ({
  classifyPrReviewQueryState: (error: unknown) =>
    (error as { data?: { code?: string } } | undefined)?.data?.code === 'NOT_FOUND'
      ? { kind: 'not-found' }
      : { kind: 'retryable' },
}));
// `PrReviewUnavailableActions` mounts for real on a provider scope; its retry
// is the shared `StateAction`, whose own styling and busy face belong to its
// suite, so here it is a host that carries the `onPress` this suite presses.
vi.mock('@/components/empty-state', () => ({ StateAction: 'StateAction' }));
// The recovery actions' own two glyphs; the rest of the icons stay the host
// stubs the row suites query.
vi.mock('sonner-native', () => ({ toast: vi.fn() }));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    githubPrReview: { listChecks: { queryOptions: () => ({}) } },
    providerReview: { listChecks: { queryOptions: () => ({}) } },
  }),
}));

// One run per status plus a second pending run: the collapsed rows must sum
// to the five checks, and every status group must be present.
function fixtureData() {
  return {
    checkRuns: [
      {
        name: 'Running',
        status: 'in_progress',
        conclusion: null,
        appName: 'GitHub Actions',
        detailsUrl: 'https://example.com/running',
      },
      {
        name: 'Queued',
        status: 'queued',
        conclusion: null,
        appName: 'GitHub Actions',
        detailsUrl: null,
      },
      {
        name: 'Passed',
        status: 'completed',
        conclusion: 'success',
        appName: 'GitHub Actions',
        detailsUrl: 'https://example.com/passed',
      },
      {
        name: 'Failed',
        status: 'completed',
        conclusion: 'failure',
        appName: 'GitHub Actions',
        detailsUrl: null,
      },
      {
        name: 'Skipped',
        status: 'completed',
        conclusion: 'skipped',
        appName: null,
        detailsUrl: null,
      },
    ],
    rollup: { total: 5, success: 1, failure: 1, pending: 2, skipped: 1 },
  };
}

let mounted: TestRenderer.ReactTestRenderer | undefined = undefined;

function mountSection(props?: Partial<ComponentProps<typeof PrReviewChecksSection>>) {
  act(() => {
    mounted = TestRenderer.create(
      createElement(PrReviewChecksSection, {
        owner: 'org',
        repo: 'repo',
        number: 1,
        checks: query,
        ...props,
      })
    );
  });
  const renderer = mounted;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function groupRows(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    node => String(node.type) === 'Pressable' && node.props.accessibilityRole === 'button'
  );
}

function groupRow(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const row = groupRows(renderer).find(node => node.props.accessibilityLabel === label);
  if (!row) {
    throw new Error(`no status row labelled ${label}`);
  }
  return row;
}

function pressGroupRow(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const row = groupRow(renderer, label);
  act(() => {
    (row.props.onPress as () => void)();
  });
}

function texts(renderer: TestRenderer.ReactTestRenderer, children: string) {
  return renderer.root.findAll(
    node => String(node.type) === 'Text' && node.props.children === children
  );
}

function spinningIcons(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAllByType(SpinningIcon);
}

beforeEach(() => {
  query.isError = false;
  query.isFetching = false;
  query.error = undefined;
  query.refetch.mockClear();
  query.data = fixtureData();
});

afterEach(() => {
  act(() => {
    mounted?.unmount();
  });
  mounted = undefined;
});

describe('PrReviewChecksSection collapsed status rows', () => {
  it('renders every present status collapsed, hiding the check rows', () => {
    const renderer = mountSection();

    // One row per status, in rollup order, each reading its own count.
    expect(groupRows(renderer).map(row => row.props.accessibilityLabel)).toEqual([
      '1 passed',
      '1 failed',
      '2 pending',
      '1 skipped',
    ]);
    // Collapsed: no check name renders, and no child detail (icons or links).
    expect(texts(renderer, 'Running')).toHaveLength(0);
    expect(texts(renderer, 'Passed')).toHaveLength(0);
    expect(renderer.root.findAllByType(ExternalLink)).toHaveLength(0);
    // One icon per collapsed group header, no child icon.
    expect(spinningIcons(renderer)).toHaveLength(4);
    for (const row of groupRows(renderer)) {
      expect(row.props.accessibilityState).toEqual({ expanded: false });
    }
  });

  it('expands a row to exactly its checks, then collapses it again', () => {
    const renderer = mountSection();

    pressGroupRow(renderer, '2 pending');

    // Only the pending group's checks appear, with the unchanged detail.
    expect(texts(renderer, 'Running')).toHaveLength(1);
    expect(texts(renderer, 'Queued')).toHaveLength(1);
    expect(texts(renderer, 'Passed')).toHaveLength(0);
    // App-name subtitle and the external-link affordance are still there.
    expect(texts(renderer, 'GitHub Actions')).toHaveLength(2);
    expect(renderer.root.findAllByType(ExternalLink)).toHaveLength(1);
    // The header icon plus one spinning icon per pending child.
    const spinning = spinningIcons(renderer).filter(node => node.props.spinning);
    expect(spinning).toHaveLength(3);
    expect(groupRow(renderer, '2 pending').props.accessibilityState).toEqual({ expanded: true });

    pressGroupRow(renderer, '2 pending');

    expect(texts(renderer, 'Running')).toHaveLength(0);
    expect(texts(renderer, 'Queued')).toHaveLength(0);
    expect(spinningIcons(renderer)).toHaveLength(4);
    expect(groupRow(renderer, '2 pending').props.accessibilityState).toEqual({ expanded: false });
  });

  it('renders no group rows when the head commit has no checks', () => {
    query.data = {
      checkRuns: [],
      rollup: { total: 0, success: 0, failure: 0, pending: 0, skipped: 0 },
    };
    const renderer = mountSection();

    expect(groupRows(renderer)).toHaveLength(0);
    expect(texts(renderer, 'prReview.checks.noChecksReported')).toHaveLength(1);
  });
});

describe('PrReviewChecksSection view-on-provider link', () => {
  const gitlabScope = {
    ref: {
      platform: 'gitlab' as const,
      projectPath: 'group/sub/repo',
      mrIid: 12,
      instanceHint: 'https://gitlab.example.com',
    },
    organizationId: null,
  };

  function mountEmpty(
    scope?: { ref: typeof gitlabScope.ref; organizationId: string | null },
    serverWebUrl: string | null = 'https://github.com/group/sub/repo/pull/12'
  ) {
    const previousData = query.data;
    query.data = {
      checkRuns: [],
      rollup: { total: 0, success: 0, failure: 0, pending: 0, skipped: 0 },
    };
    const section = (
      <PrReviewChecksSection owner="group/sub" repo="repo" number={12} checks={query} />
    );
    const renderer: { current: TestRenderer.ReactTestRenderer | undefined } = {
      current: undefined,
    };
    act(() => {
      renderer.current = TestRenderer.create(
        <ProviderPrWebUrlProvider value={serverWebUrl}>
          {scope ? (
            <ProviderPrScopeProvider value={scope}>{section}</ProviderPrScopeProvider>
          ) : (
            section
          )}
        </ProviderPrWebUrlProvider>
      );
    });
    const created = renderer.current;
    if (!created) {
      throw new Error('renderer was not created');
    }
    return {
      renderer: created,
      restore: () => {
        query.data = previousData;
      },
    };
  }

  beforeEach(() => {
    vi.mocked(openExternalUrl).mockClear();
  });

  function pressViewButton(renderer: TestRenderer.ReactTestRenderer) {
    const button = renderer.root.findAllByType('Button' as never)[0];
    if (!button) {
      throw new Error('the view-on-provider button did not render');
    }
    act(() => {
      (button.props.onPress as () => void)();
    });
  }

  it('labels the opened link "pull request" on the GitHub arm', () => {
    const { renderer, restore } = mountEmpty();
    pressViewButton(renderer);

    expect(openExternalUrl).toHaveBeenCalledWith('https://github.com/group/sub/repo/pull/12', {
      label: 'prReview.terms.pullRequest',
    });
    act(() => {
      renderer.unmount();
    });
    restore();
  });

  it('labels the same link "merge request" on a GitLab scope', () => {
    const { renderer, restore } = mountEmpty(
      gitlabScope,
      'https://gitlab.example.com/group/sub/repo/-/merge_requests/12'
    );
    pressViewButton(renderer);

    expect(openExternalUrl).toHaveBeenCalledWith(
      'https://gitlab.example.com/group/sub/repo/-/merge_requests/12',
      { label: 'prReview.terms.mergeRequest' }
    );
    act(() => {
      renderer.unmount();
    });
    restore();
  });

  it('opens the merge request URL the read resolved', () => {
    // The MR is served from the instance the read answered with, so the link
    // must open that URL.
    const { renderer, restore } = mountEmpty(
      {
        ref: { ...gitlabScope.ref, instanceHint: 'https://gitlab.staging.example' },
        organizationId: null,
      },
      'https://gitlab.example.com/group/sub/repo/-/merge_requests/12'
    );
    pressViewButton(renderer);

    expect(openExternalUrl).toHaveBeenCalledWith(
      'https://gitlab.example.com/group/sub/repo/-/merge_requests/12',
      { label: 'prReview.terms.mergeRequest' }
    );
    act(() => {
      renderer.unmount();
    });
    restore();
  });

  it('renders no link until the screen publishes the loaded MR URL', () => {
    const { renderer, restore } = mountEmpty(gitlabScope, null);

    expect(renderer.root.findAllByType('Button' as never)).toHaveLength(0);

    act(() => {
      renderer.unmount();
    });
    restore();
  });
});

describe('PrReviewChecksSection not-found arm', () => {
  const gitlabScope: ProviderPrScope = {
    ref: {
      platform: 'gitlab',
      projectPath: 'group/sub/repo',
      mrIid: 12,
      instanceHint: 'https://gitlab.example.com',
    },
    organizationId: null,
  };
  const bitbucketScope: ProviderPrScope = {
    ref: { platform: 'bitbucket', workspace: 'acme', repoSlug: 'repo', prId: 12 },
    organizationId: 'org-1',
  };

  /**
   * The settled read answered NOT_FOUND. GitLab and Bitbucket fold their
   * connection failures into that same answer, so the section cannot treat it
   * as terminal there; GitHub's own NOT_FOUND is genuinely terminal and mounts
   * with no scope at all, which is the fallback the GitHub route gets.
   *
   * The real `PrReviewUnavailableActions` needs the query client its connection
   * check reads and the scope that decides whether it renders, so every arm
   * mounts under both.
   */
  function mountNotFound(scope?: ProviderPrScope) {
    const previous = { isError: query.isError, error: query.error };
    query.isError = true;
    query.error = { data: { code: 'NOT_FOUND' } };
    const client = createTestQueryClient();
    const section = (
      <PrReviewChecksSection owner="group/sub" repo="repo" number={12} checks={query} />
    );
    const renderer: { current: TestRenderer.ReactTestRenderer | undefined } = {
      current: undefined,
    };
    act(() => {
      renderer.current = TestRenderer.create(
        <QueryClientProvider client={client}>
          <ProviderPrWebUrlProvider value={null}>
            {scope ? (
              <ProviderPrScopeProvider value={scope}>{section}</ProviderPrScopeProvider>
            ) : (
              section
            )}
          </ProviderPrWebUrlProvider>
        </QueryClientProvider>
      );
    });
    const created = renderer.current;
    if (!created) {
      throw new Error('renderer was not created');
    }
    return {
      renderer: created,
      restore: () => {
        query.isError = previous.isError;
        query.error = previous.error;
        client.clear();
      },
    };
  }

  function unavailableActions(renderer: TestRenderer.ReactTestRenderer) {
    return renderer.root.findAllByType(PrReviewUnavailableActions);
  }

  /** The recovery row's one primary, the shared state action that re-reads. */
  function retryAction(renderer: TestRenderer.ReactTestRenderer) {
    const [retry] = renderer.root.findAllByType('StateAction' as never);
    if (!retry) {
      throw new Error('the retry action did not render');
    }
    return retry;
  }

  it('keeps the terminal card on the GitHub arm, with no recovery row', () => {
    const { renderer, restore } = mountNotFound();

    expect(texts(renderer, 'prReview.checks.notAvailable')).toHaveLength(1);
    expect(texts(renderer, 'prReview.terms.unavailableDescription')).toHaveLength(0);
    expect(unavailableActions(renderer)).toHaveLength(0);
    expect(renderer.root.findAllByType('Button' as never)).toHaveLength(0);

    act(() => {
      renderer.unmount();
    });
    restore();
  });

  it.each([
    { platform: 'GitLab', scope: gitlabScope },
    { platform: 'Bitbucket', scope: bitbucketScope },
  ])(
    'offers the real recovery rows on a $platform scope, retrying the checks read',
    ({ scope }) => {
      const { renderer, restore } = mountNotFound(scope);

      // GitLab and Bitbucket fold their connection failures into the same
      // NOT_FOUND a removed item produces, so the copy is the shared unavailable
      // description and the state carries the read retry plus the connection
      // check instead of the terminal card.
      expect(texts(renderer, 'prReview.terms.unavailableDescription')).toHaveLength(1);
      expect(texts(renderer, 'prReview.checks.notAvailable')).toHaveLength(0);
      const actions = unavailableActions(renderer);
      expect(actions).toHaveLength(1);
      // The card sits in the overview body, whose merge section owns the single
      // filled primary, so the row asks for the embedded presentation: an
      // outlined retry above a ghost check rather than the whole-surface
      // primary the sibling states use.
      expect(actions[0]?.props.presentation).toBe('embedded');
      const retry = actions[0]?.props.onRetry as (() => void) | undefined;
      if (!retry) {
        throw new Error('the recovery rows did not render');
      }
      act(() => {
        retry();
      });
      expect(query.refetch).toHaveBeenCalledTimes(1);

      // The real component drew both of its controls: the outlined provider
      // connection check under the retry, and the retry's own state action,
      // which re-reads the checks when pressed.
      const [connectionCheck] = renderer.root.findAllByType('Button' as never);
      expect(connectionCheck?.props.accessibilityLabel).toBe('prReview.checkConnection');
      act(() => {
        (retryAction(renderer).props.onPress as () => void)();
      });
      expect(query.refetch).toHaveBeenCalledTimes(2);

      act(() => {
        renderer.unmount();
      });
      restore();
    }
  );
});
