/* eslint-disable max-lines -- the collapsed-row, expand/collapse and view-on-provider suites share one fixture and mock harness in this file. */
import { type ComponentProps, createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExternalLink } from '@/components/ui/icons';
import { SpinningIcon } from '@/components/ui/spinning-icon';
import { ProviderPrScopeProvider, ProviderPrWebUrlProvider } from '@/lib/pr-review/provider-pr-ref';
import { openExternalUrl } from '@/lib/external-link';
import { PrReviewChecksSection } from './pr-review-checks-section';

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
