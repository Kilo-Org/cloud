/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the repository's native-free mounted test tool. */
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only theme-token guard, runs in node, never bundled into the app
import { readFileSync } from 'node:fs';

import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SpinningIcon } from '@/components/ui/spinning-icon';
import { ProviderPrScopeProvider } from '@/lib/pr-review/provider-pr-ref';
import { openExternalUrl } from '@/lib/external-link';
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

    expect(renderer.root.findAllByType(SpinningIcon)).toHaveLength(4);
    expect(renderer.root.findAllByType(SpinningIcon).map(node => node.props.icon)).toEqual([
      'Loader2',
      'Loader2',
      'CheckCircle2',
      'XCircle',
    ]);
    expect(renderer.root.findAllByType(SpinningIcon).map(node => node.props.spinning)).toEqual([
      true,
      true,
      false,
      false,
    ]);

    act(() => {
      renderer.unmount();
    });
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

  function mountSection(scope?: { ref: typeof gitlabScope.ref; organizationId: string | null }) {
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
    const { renderer, restore } = mountSection();
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
    const { renderer, restore } = mountSection(gitlabScope);
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
// painted the card's own colour. This test pins the fixed render path: the
// card holds three shared Skeleton bars in `bg-muted-soft` — the one gray
// that differs from the card in both themes — and no bar keeps the
// collision token. The CSS guard below proves the collision is real
// (`--muted` == `--secondary`) and that the token the bars now use is not
// the collision token, so a future theme change that reintroduces the
// collision fails here instead of shipping another empty gray block.
describe('PrReviewChecksSection loading state is visible on the card', () => {
  const previous = { isLoading: false, data: query.data };

  beforeEach(() => {
    query.isLoading = true;
  });

  afterEach(() => {
    query.isLoading = previous.isLoading;
    query.data = previous.data;
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

  it('paints three animated skeleton bars in a colour distinct from the card', () => {
    const renderer = mountLoading();
    const card = findCard(renderer);

    // The shared Skeleton component — the app's loading indicator (pulse +
    // shimmer), not a static block.
    const bars = card.findAll(node => String(node.type) === 'Skeleton');
    expect(bars).toHaveLength(3);
    for (const bar of bars) {
      const className = String(bar.props.className ?? '');
      expect(className.split(/\s+/)).toContain('bg-muted-soft');
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
