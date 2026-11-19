import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, TestRenderer } from '@/test/renderer';

import { openExternalUrl } from '@/lib/external-link';
import { type ProviderPrRef, ProviderPrWebUrlProvider } from '@/lib/pr-review/provider-pr-ref';
import { ListFooter, type ListFooterProps } from './pr-review-discussion-list-footer';

const GITHUB_REF: ProviderPrRef = {
  platform: 'github',
  owner: 'octocat',
  repo: 'hello-world',
  number: 7,
};
const PR_WEB_URL = 'https://github.com/octocat/hello-world/pull/7';
const GITLAB_MR_WEB_URL = 'https://gitlab.example.com/octocat/hello-world/-/merge_requests/7';

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // The count-bearing notice spells out both numbers it is handed, so the
    // test proves the caller passes i18next the raw count for the plural form
    // and the formatted one for display.
    t: (key: string, options?: Record<string, unknown>) =>
      options && 'count' in options
        ? `${key}=${String(options.displayCount)}/${String(options.count)}`
        : key,
  }),
}));
vi.mock('@/i18n', () => ({ i18n: { language: 'en', t: (key: string) => key } }));
vi.mock('@/lib/external-link', () => ({ openExternalUrl: vi.fn() }));
vi.mock('@/lib/code-reviewer-config', () => ({
  reviewerPlatformLabel: (platform: string) => platform,
}));
vi.mock('@/lib/format', () => ({ formatNumber: (value: number) => `n${String(value)}` }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: 'black' }),
}));
vi.mock('@/lib/screen-insets', () => ({ useDetailScreenBottomPadding: () => 32 }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({ ExternalLink: 'ExternalLink' }));

const BASE_PROPS: ListFooterProps = {
  prRef: GITHUB_REF,
  hasNextPage: false,
  isFetchingNextPage: false,
  laterPageError: false,
  onLoadMore: () => undefined,
  onRetryLoadMore: () => undefined,
};

function mountFooter(
  overrides: Partial<ListFooterProps> = {},
  webUrl: string | null = null
): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      <ProviderPrWebUrlProvider value={webUrl}>
        <ListFooter {...BASE_PROPS} {...overrides} />
      </ProviderPrWebUrlProvider>
    );
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function texts(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAll(node => (node.type as unknown) === 'Text')
    .map(node => {
      const children: unknown = node.props.children;
      return typeof children === 'string' ? children : '';
    });
}

function githubButton(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAll(node => (node.type as unknown) === 'Button')
    .find(node => node.props.accessibilityLabel === 'common.viewOnGitHub');
}

beforeEach(() => {
  vi.mocked(openExternalUrl).mockClear();
});

describe('ListFooter truncated conversation notice', () => {
  it('says the discussion was cut, with the loaded count, above Load more', () => {
    const renderer = mountFooter({ truncatedConversationCount: 500, hasNextPage: true });

    expect(texts(renderer)).toEqual([
      'prReview.discussion.conversationTruncated=n500/500',
      'common.viewOnGitHub',
      'common.loadMore',
    ]);

    renderer.unmount();
  });

  it('keeps the notice when there is no Load more left, instead of the bare spacer', () => {
    const renderer = mountFooter({ truncatedConversationCount: 500, hasNextPage: false });

    expect(texts(renderer)).toEqual([
      'prReview.discussion.conversationTruncated=n500/500',
      'common.viewOnGitHub',
    ]);

    renderer.unmount();
  });

  it('keeps the notice beside a later-page error', () => {
    const renderer = mountFooter({ truncatedConversationCount: 500, laterPageError: true });

    expect(texts(renderer)).toEqual([
      'prReview.discussion.conversationTruncated=n500/500',
      'common.viewOnGitHub',
      'prReview.discussion.couldNotLoadMore',
      'common.retry',
    ]);

    renderer.unmount();
  });

  it('opens the pull request on GitHub, derived from the ref alone', () => {
    // The GitHub route publishes no web URL (only a provider route resolves
    // one), so the recovery link must not depend on it.
    const renderer = mountFooter({ truncatedConversationCount: 500, hasNextPage: true });

    const button = githubButton(renderer);
    if (!button) {
      throw new Error('the notice rendered no GitHub button');
    }
    // The stub Button holds the notice's handler as an untyped host prop; the
    // press is what the test drives. Same cast the sibling suites use.
    const press = button.props.onPress as () => void;
    act(() => {
      press();
    });

    // The toast copy reads "Could not open {{label}}", so the link hands over
    // the provider's noun rather than the button's own text.
    expect(openExternalUrl).toHaveBeenCalledWith(PR_WEB_URL, {
      label: 'prReview.terms.pullRequest',
    });

    renderer.unmount();
  });

  it('names the provider on a merge request and opens it with the provider noun', () => {
    const renderer = mountFooter(
      {
        prRef: { platform: 'gitlab', projectPath: 'octocat/hello-world', mrIid: 7 },
        truncatedConversationCount: 500,
        hasNextPage: true,
      },
      GITLAB_MR_WEB_URL
    );

    const button = renderer.root
      .findAll(node => (node.type as unknown) === 'Button')
      .find(node => node.props.accessibilityLabel === 'prReview.terms.viewOnProvider');
    if (!button) {
      throw new Error('the notice rendered no provider button');
    }
    const press = button.props.onPress as () => void;
    act(() => {
      press();
    });

    expect(openExternalUrl).toHaveBeenCalledWith(GITLAB_MR_WEB_URL, {
      label: 'prReview.terms.mergeRequest',
    });

    renderer.unmount();
  });

  it('greys out the notice but keeps the sentence when no URL can be built', () => {
    // A GitLab link needs the instance the read resolved: without it the
    // notice still says the discussion was cut and offers no dead link.
    const renderer = mountFooter(
      {
        prRef: { platform: 'gitlab', projectPath: 'octocat/hello-world', mrIid: 7 },
        truncatedConversationCount: 500,
        hasNextPage: true,
      },
      null
    );

    expect(texts(renderer)).toEqual([
      'prReview.discussion.conversationTruncated=n500/500',
      'common.loadMore',
    ]);

    renderer.unmount();
  });

  it('renders no notice and no button for a complete conversation', () => {
    const renderer = mountFooter({ hasNextPage: true });

    expect(texts(renderer)).toEqual(['common.loadMore']);
    expect(githubButton(renderer)).toBeUndefined();

    renderer.unmount();
  });

  it('keeps the bottom clearance spacer for a complete conversation', () => {
    const renderer = mountFooter();

    const spacer = renderer.root.find(
      node => (node.type as unknown) === 'View' && node.props.style !== undefined
    );
    expect(spacer.props.style).toEqual({ height: 32 });

    renderer.unmount();
  });
});
