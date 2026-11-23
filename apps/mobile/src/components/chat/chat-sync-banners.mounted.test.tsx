/* eslint-disable typescript-eslint/no-deprecated -- the DOM-free `test-renderer` mounts React/RN trees under vitest (see src/test/renderer.ts) */
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatSyncBanner } from '@/components/chat/chat-sync-banners';
import { i18n } from '@/i18n';
import { act, TestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

/**
 * The sync surfaces over a chat and over the list: the busy banner names the
 * other device's turn, the diverged banner offers the one way out, the
 * prompt asks once, and neither draws anything when it should not.
 */

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
  Platform: { OS: 'ios' },
  useWindowDimensions: () => ({ fontScale: 1, width: 400, height: 800 }),
}));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

let view: Awaited<ReturnType<typeof renderWithProviders>> | undefined = undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

function textOf(tree: TestRenderer.ReactTestRenderer, id: string): string {
  const node = tree.root.findAllByProps({ testID: id }).at(0);
  return JSON.stringify(node?.props ?? {});
}

describe('ChatSyncBanner', () => {
  it('draws nothing while the chat owns its own turn', async () => {
    view = await renderWithProviders(
      createElement(ChatSyncBanner, { banner: { kind: 'none' }, onDiscard: () => undefined })
    );
    expect(view.renderer.root.findAllByProps({ testID: 'chat-sync-banner-busy' })).toHaveLength(0);
    expect(view.renderer.root.findAllByProps({ testID: 'chat-sync-banner-diverged' })).toHaveLength(0);
  });

  it('names the busy tail read-only', async () => {
    view = await renderWithProviders(
      createElement(ChatSyncBanner, { banner: { kind: 'busy' }, onDiscard: () => undefined })
    );
    const banner = view.renderer.root.findAllByProps({ testID: 'chat-sync-banner-busy' }).at(0);
    expect(banner).toBeDefined();
    expect(banner?.props.accessibilityRole).toBe('alert');
    expect(textOf(view.renderer, 'chat-sync-banner-busy')).toContain(
      i18n.t('modelChat.sync.busyTitle')
    );
  });

  it('offers discard-and-reload on a diverged chat and calls it', async () => {
    const onDiscard = vi.fn();
    view = await renderWithProviders(
      createElement(ChatSyncBanner, { banner: { kind: 'diverged' }, onDiscard })
    );
    const button = view.renderer.root
      .findAllByProps({ accessibilityLabel: i18n.t('modelChat.sync.divergedAction') })
      .at(0);
    await act(async () => {
      (button?.props.onPress as () => void)();
      await Promise.resolve();
    });
    expect(onDiscard).toHaveBeenCalledOnce();
  });
});
