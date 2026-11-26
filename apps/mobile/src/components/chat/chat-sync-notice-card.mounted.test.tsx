/* eslint-disable typescript-eslint/no-deprecated -- the DOM-free `test-renderer` mounts React/RN trees under vitest (see src/test/renderer.ts) */
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatSyncNoticeCard } from '@/components/chat/chat-sync-notice-card';
import { i18n } from '@/i18n';
import { act, type TestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

/**
 * The upgrade notice: it says chats now sync, its second sentence opens the
 * setting, and dismissing it reports once.
 */

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
  Platform: { OS: 'ios' },
  useWindowDimensions: () => ({ fontScale: 1, width: 400, height: 800 }),
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

let view: Awaited<ReturnType<typeof renderWithProviders>> | undefined = undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

const press = async (tree: TestRenderer.ReactTestRenderer, label: string) => {
  const node = tree.root.findAllByProps({ accessibilityLabel: label }).at(0);
  if (node === undefined) {
    throw new Error(`the card drew no control named ${label}`);
  }
  await act(async () => {
    (node.props.onPress as () => void)();
    await Promise.resolve();
  });
};

describe('ChatSyncNoticeCard', () => {
  it('names the new behaviour and opens the setting from its second sentence', async () => {
    const onDismiss = vi.fn<() => void>();
    const onOpenSettings = vi.fn<() => void>();
    view = await renderWithProviders(
      createElement(ChatSyncNoticeCard, { onDismiss, onOpenSettings })
    );
    const words = view.renderer.root
      .findAll(node => (node.type as string) === 'Text')
      .map(node => node.props.children)
      .filter((child): child is string => typeof child === 'string');
    expect(words).toContain(i18n.t('modelChat.sync.noticeBody'));
    await press(view.renderer, i18n.t('modelChat.sync.noticeAction'));
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('dismisses once when the person closes it', async () => {
    const onDismiss = vi.fn<() => void>();
    view = await renderWithProviders(
      createElement(ChatSyncNoticeCard, { onDismiss, onOpenSettings: (): void => undefined })
    );
    await press(view.renderer, i18n.t('modelChat.list.resetNoticeDismiss'));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
