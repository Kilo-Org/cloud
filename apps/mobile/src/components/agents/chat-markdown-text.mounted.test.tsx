/* eslint-disable max-lines -- one mounted harness covers the tap and long-press review-link states for all three providers. */
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatMarkdownText } from './chat-markdown-text';

const mocks = vi.hoisted(() => ({
  showActionSheetWithOptions: vi.fn(),
  push: vi.fn(),
  openExternalUrl: vi.fn(),
  markdownProps: [] as Record<string, unknown>[],
}));

vi.mock('react-native', () => ({ Share: { share: vi.fn() } }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@expo/react-native-action-sheet', () => ({
  useActionSheet: () => ({ showActionSheetWithOptions: mocks.showActionSheetWithOptions }),
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/i18n', () => ({ i18n: { language: 'en', t: (key: string) => key } }));
vi.mock('@/lib/analytics/posthog', () => ({
  FEATURE_FLAG_PR_REVIEW: 'pr-review',
  useFeatureFlag: () => true,
}));
vi.mock('@/lib/external-link', () => ({ openExternalUrl: mocks.openExternalUrl }));
vi.mock('@/lib/hooks/use-themed-action-sheet', () => ({
  useThemedActionSheetOptions: () => ({
    containerStyle: { backgroundColor: '#17171A' },
    textStyle: { color: '#F2F0EB' },
    titleTextStyle: { color: '#8A8680' },
    messageTextStyle: { color: '#8A8680' },
    destructiveColor: '#F28B7A',
  }),
}));
vi.mock('@/components/agents/use-message-copy', () => ({ performCopy: vi.fn() }));
vi.mock('./markdown-link-confirm', () => ({ formatLinkHost: (href: string) => href }));
vi.mock('./markdown-text', () => ({
  MarkdownText: (props: Record<string, unknown>) => {
    mocks.markdownProps.push(props);
    return null;
  },
}));

function mountChatMarkdownText(): {
  onPressLink: (href: string) => boolean;
  onLongPressLink: (href: string) => void;
} {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(ChatMarkdownText, { value: 'text' }));
  });
  const props = mocks.markdownProps.at(-1);
  if (!props) {
    throw new Error('ChatMarkdownText did not render its markdown surface');
  }
  return {
    onPressLink: props.onPressLink as (href: string) => boolean,
    onLongPressLink: props.onLongPressLink as (href: string) => void,
  };
}

/** The options array handed to the native action sheet on the last call. */
function lastSheetOptions(): string[] {
  const call = mocks.showActionSheetWithOptions.mock.calls.at(-1);
  const sheet = call?.[0] as { options?: string[] } | undefined;
  return sheet?.options ?? [];
}

/** Invoke the sheet's pressed index through the handler the sheet received. */
function pressSheetOption(index: number): void {
  const call = mocks.showActionSheetWithOptions.mock.calls.at(-1);
  const onSelect = call?.[1] as ((index: number) => void) | undefined;
  onSelect?.(index);
}

describe('ChatMarkdownText review-link recognition', () => {
  beforeEach(() => {
    mocks.showActionSheetWithOptions.mockReset();
    mocks.push.mockReset();
    mocks.openExternalUrl.mockReset();
    mocks.markdownProps = [];
  });

  it('offers Review PR for a github.com pull request and routes in-app', () => {
    const { onPressLink } = mountChatMarkdownText();

    const handled = onPressLink('https://github.com/octocat/hello-world/pull/42');

    expect(handled).toBe(true);
    expect(lastSheetOptions()).toContain('common.reviewPr');
    pressSheetOption(0);
    expect(mocks.push).toHaveBeenCalledWith('/(app)/pr-review/octocat/hello-world/42');
  });

  it('offers Review PR for a gitlab.com merge request and routes to the provider route', () => {
    const { onPressLink } = mountChatMarkdownText();

    const handled = onPressLink('https://gitlab.com/group/sub/repo/-/merge_requests/7');

    expect(handled).toBe(true);
    expect(lastSheetOptions()).toContain('common.reviewPr');
    pressSheetOption(0);
    expect(mocks.push).toHaveBeenCalledWith(
      '/(app)/pr-review/gitlab/group/sub/repo/7?instance=https%3A%2F%2Fgitlab.com'
    );
  });

  it('offers Review PR for a self-managed GitLab merge request', () => {
    const { onPressLink } = mountChatMarkdownText();

    const handled = onPressLink('https://gitlab.example.com/team/repo/-/merge_requests/9');

    expect(handled).toBe(true);
    pressSheetOption(0);
    expect(mocks.push).toHaveBeenCalledWith(
      '/(app)/pr-review/gitlab/team/repo/9?instance=https%3A%2F%2Fgitlab.example.com'
    );
  });

  it('offers Review PR for a Bitbucket pull request and routes to the provider route', () => {
    const { onPressLink } = mountChatMarkdownText();

    const handled = onPressLink('https://bitbucket.org/acme/api/pull-requests/42/overview');

    expect(handled).toBe(true);
    pressSheetOption(0);
    expect(mocks.push).toHaveBeenCalledWith('/(app)/pr-review/bitbucket/acme/api/42');
  });

  it('leaves a plain link to the default open-in-browser path', () => {
    const { onPressLink } = mountChatMarkdownText();

    expect(onPressLink('https://example.com/docs')).toBe(false);
    expect(mocks.showActionSheetWithOptions).not.toHaveBeenCalled();
  });

  it('adds the long-press Review PR option for GitLab and Bitbucket, not for plain links', () => {
    const { onLongPressLink } = mountChatMarkdownText();

    onLongPressLink('https://gitlab.com/group/repo/-/merge_requests/7');
    expect(lastSheetOptions()).toContain('common.reviewPr');
    pressSheetOption(0);
    expect(mocks.push).toHaveBeenCalledWith(
      '/(app)/pr-review/gitlab/group/repo/7?instance=https%3A%2F%2Fgitlab.com'
    );

    onLongPressLink('https://example.com/docs');
    expect(lastSheetOptions()).not.toContain('common.reviewPr');
  });
});
