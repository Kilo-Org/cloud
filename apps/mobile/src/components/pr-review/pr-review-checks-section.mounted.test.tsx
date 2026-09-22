/* eslint-disable max-lines -- the collapsed-row, expand/collapse, view-on-provider, and loading/theme-token suites share one fixture and mock harness in this file. */
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only theme-token guard, runs in node, never bundled into the app
import { readFileSync } from 'node:fs';

import { type ComponentProps, createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExternalLink } from '@/components/ui/icons';
import { SpinningIcon } from '@/components/ui/spinning-icon';
import { ProviderPrScopeProvider } from '@/lib/pr-review/provider-pr-ref';
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
  isLoading: false,
  isError: false,
  isFetching: false,
  error: undefined as unknown,
  refetch: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({ useQuery: () => query }));
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
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
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
        headSha: 'head',
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

function tokens(node: TestRenderer.ReactTestInstance) {
  return String(node.props.className ?? '').split(/\s+/);
}

/** The row shell the loaded group rows use, shared with the placeholders. */
function rowShells(card: TestRenderer.ReactTestInstance) {
  return card.findAll(node => {
    const classes = tokens(node);
    return (
      classes.includes('min-h-11') &&
      classes.includes('flex-row') &&
      classes.includes('items-center') &&
      classes.includes('gap-3') &&
      classes.includes('px-4') &&
      classes.includes('py-3')
    );
  });
}

beforeEach(() => {
  query.isLoading = false;
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

  function mountEmpty(scope?: { ref: typeof gitlabScope.ref; organizationId: string | null }) {
    const previousData = query.data;
    query.data = {
      checkRuns: [],
      rollup: { total: 0, success: 0, failure: 0, pending: 0, skipped: 0 },
    };
    const section = (
      <PrReviewChecksSection owner="group/sub" repo="repo" number={12} headSha="head" />
    );
    const renderer: { current: TestRenderer.ReactTestRenderer | undefined } = {
      current: undefined,
    };
    act(() => {
      renderer.current = TestRenderer.create(
        scope ? <ProviderPrScopeProvider value={scope}>{section}</ProviderPrScopeProvider> : section
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
    const { renderer, restore } = mountEmpty(gitlabScope);
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
});

// Spot check e1-nav-mr.png: the CHECKS section rendered as an empty gray
// block — no loading indicator, no empty copy, no error copy. The screen
// was in the loading state, and the state was invisible: the skeleton bars
// carried `bg-muted` inside a `bg-secondary` card, and `--muted` equals
// `--secondary` in BOTH themes (apps/mobile/src/global.css), so the bars
// painted the card's own colour. This suite pins the fixed render path: the
// card reserves the loaded card's shape — a header strip plus one placeholder
// row per status the card can show — and every bar keeps `bg-muted-soft`, the
// one gray that differs from the card in both themes. The CSS guard below
// proves the collision is real (`--muted` == `--secondary`) and that the token
// the bars now use is not the collision token, so a future theme change that
// reintroduces the collision fails here instead of shipping another empty gray
// block.
describe('PrReviewChecksSection loading state reserves the loaded card', () => {
  const previous = { isLoading: false };

  beforeEach(() => {
    query.isLoading = true;
  });

  afterEach(() => {
    query.isLoading = previous.isLoading;
  });

  function mountLoading() {
    const renderer: { current: TestRenderer.ReactTestRenderer | undefined } = {
      current: undefined,
    };
    act(() => {
      renderer.current = TestRenderer.create(
        createElement(PrReviewChecksSection, {
          owner: 'group/sub',
          repo: 'repo',
          number: 12,
          headSha: 'head',
        })
      );
    });
    const created = renderer.current;
    if (!created) {
      throw new Error('renderer was not created');
    }
    return created;
  }

  function findCard(renderer: TestRenderer.ReactTestRenderer) {
    const cards = renderer.root.findAll(
      node =>
        String(node.type) === 'View' &&
        typeof node.props.className === 'string' &&
        node.props.className.split(/\s+/).includes('bg-secondary')
    );
    expect(cards).toHaveLength(1);
    const card = cards[0];
    if (!card) {
      throw new Error('the checks card did not render');
    }
    return card;
  }

  it('paints every skeleton bar in a colour distinct from the card', () => {
    const renderer = mountLoading();
    const card = findCard(renderer);

    // The shared Skeleton component — the app's loading indicator (pulse +
    // shimmer), not a static block.
    const bars = card.findAll(node => String(node.type) === 'Skeleton');
    expect(bars.length).toBeGreaterThan(0);
    for (const bar of bars) {
      expect(tokens(bar)).toContain('bg-muted-soft');
    }

    // The defect itself: no node in the card may keep the bare `bg-muted`
    // token — on this card it is the card's own colour, i.e. invisible.
    const invisible = card.findAll(
      node =>
        typeof node.props.className === 'string' &&
        /(^|\s)bg-muted(\s|$)/.test(node.props.className)
    );
    expect(invisible).toHaveLength(0);

    // The state is announced, not only shown.
    expect(card.props.accessibilityRole).toBe('progressbar');
    expect(card.props.accessibilityLabel).toBe('common.loading');

    act(() => {
      renderer.unmount();
    });
  });

  it('mirrors the loaded card: a header strip plus one row per status', () => {
    const renderer = mountLoading();
    const card = findCard(renderer);

    const headerStrips = card.findAll(
      node =>
        tokens(node).includes('border-b-[0.5px]') &&
        tokens(node).includes('px-4') &&
        tokens(node).includes('py-2')
    );
    expect(headerStrips).toHaveLength(1);
    const headerStrip = headerStrips[0];
    if (!headerStrip) {
      throw new Error('the header strip did not render');
    }
    expect(headerStrip.findAll(node => String(node.type) === 'Skeleton')).toHaveLength(1);

    expect(rowShells(card)).toHaveLength(4);

    // The card hairline sits between rows, never after the last one: the
    // header strip's own border plus one between each pair of four rows.
    const hairlines = card.findAll(node => tokens(node).includes('border-b-[0.5px]'));
    expect(hairlines).toHaveLength(4);

    act(() => {
      renderer.unmount();
    });
  });

  it('reserves as many placeholder rows as the loaded card can show', () => {
    const loadingRenderer = mountLoading();
    const reserved = rowShells(findCard(loadingRenderer)).length;
    act(() => {
      loadingRenderer.unmount();
    });

    // The loaded card can never exceed one row per status; the fixture spans
    // all four, so it settles into exactly the reserved rows.
    query.isLoading = false;
    const loaded = mountSection();
    expect(groupRows(loaded)).toHaveLength(reserved);
  });

  it('keeps the CHECKS heading rendered while loading, so the block is labelled', () => {
    const renderer = mountLoading();
    const headings = renderer.root.findAll(
      node => String(node.type) === 'Text' && node.props.children === 'prReview.checks.title'
    );
    expect(headings).toHaveLength(1);
    act(() => {
      renderer.unmount();
    });
  });

  it('mounts a fresh card when the loading card is replaced by content', () => {
    // The reported regression (e2): React Native on Android keeps a View's
    // contentDescription when a later render drops its `accessibilityLabel`,
    // so the loaded card kept the loading card's content-desc and a screen
    // reader announced "Loading…" over the loaded rows. The reused native view
    // is the defect, so a state switch must mount a new card; the distinct
    // keys on the two cards are what makes React unmount one and mount the
    // other, and an update that reuses the instance fails here.
    const renderer = mountSection();
    const loadingCard = findCard(renderer);
    expect(loadingCard.props.accessibilityRole).toBe('progressbar');
    expect(loadingCard.props.accessibilityLabel).toBe('common.loading');

    query.isLoading = false;
    act(() => {
      renderer.update(
        createElement(PrReviewChecksSection, {
          owner: 'org',
          repo: 'repo',
          number: 1,
          headSha: 'head',
        })
      );
    });

    const loadedCard = findCard(renderer);
    expect(loadedCard.props.accessibilityLabel).toBeUndefined();
    expect(loadedCard).not.toBe(loadingCard);
  });

  it('guards the theme tokens: bg-muted collides with the card, bg-muted-soft does not', () => {
    const css = readFileSync(new URL('../../global.css', import.meta.url), 'utf8');
    const values = (name: string) =>
      [...css.matchAll(new RegExp(`--${name}:\\s*([^;]+);`, 'g'))].map(match =>
        (match[1] ?? '').trim().toLowerCase()
      );
    const secondary = values('secondary');
    const muted = values('muted');
    const mutedSoft = values('muted-soft');

    // Both theme blocks are present.
    expect(secondary.length).toBeGreaterThanOrEqual(2);
    expect(muted).toHaveLength(secondary.length);
    expect(mutedSoft).toHaveLength(secondary.length);
    // The collision that made the old skeleton invisible, pinned so the
    // test above stays meaningful.
    expect(muted).toEqual(secondary);
    // The fix token must contrast with the card in every theme.
    for (const [index, soft] of mutedSoft.entries()) {
      expect(soft).not.toBe(secondary[index]);
    }
  });
});
