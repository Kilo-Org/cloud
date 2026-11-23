/* eslint-disable typescript-eslint/no-deprecated -- the DOM-free `test-renderer` mounts React/RN trees under vitest (see src/test/renderer.ts) */
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatSyncListControls } from '@/components/chat/chat-sync-list-controls';
import { i18n } from '@/i18n';
import { DEFAULT_CHAT_FILTERS, type ChatListFilters } from '@/lib/chat/sync/sync-list';
import { act, TestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

/**
 * The synced list's filters: each control reports a filter set carrying only
 * its own change, so no control can quietly reset another.
 */

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
  Platform: { OS: 'ios' },
  useWindowDimensions: () => ({ fontScale: 1, width: 400, height: 800 }),
}));
vi.mock('@/components/ui/search-field', () => ({ SearchField: 'SearchField' }));
vi.mock('@/components/ui/segmented-control', () => ({ SegmentedControl: 'SegmentedControl' }));
vi.mock('@/components/ui/switch', () => ({ Switch: 'Switch' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

let view: Awaited<ReturnType<typeof renderWithProviders>> | undefined = undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

async function mount(filters: ChatListFilters = DEFAULT_CHAT_FILTERS) {
  const onChange = vi.fn();
  view = await renderWithProviders(
    createElement(ChatSyncListControls, { filters, onChange })
  );
  return { tree: view.renderer, onChange };
}

describe('ChatSyncListControls', () => {
  it('reports the typed query and the cleared field', async () => {
    const { tree, onChange } = await mount({ ...DEFAULT_CHAT_FILTERS, origin: 'cli' });
    const field = tree.root.findAllByProps({ hasText: false }).at(0);
    await act(async () => {
      (field?.props.onChangeText as (text: string) => void)('deploy');
      await Promise.resolve();
    });
    expect(onChange).toHaveBeenLastCalledWith({ q: 'deploy', origin: 'cli', includeArchived: false });
    await act(async () => {
      (field?.props.onClear as () => void)();
      await Promise.resolve();
    });
    expect(onChange).toHaveBeenLastCalledWith({ q: '', origin: 'cli', includeArchived: false });
  });

  it('switches origin and the archived toggle without touching the query', async () => {
    const { tree, onChange } = await mount({ q: 'bug', origin: 'all', includeArchived: false });
    const segments = tree.root.findAllByProps({ semantics: 'tabs' }).at(0);
    expect(segments?.props.options.map((option: { value: string }) => option.value)).toEqual([
      'all',
      'mobile',
      'cli',
    ]);
    await act(async () => {
      (segments?.props.onChange as (value: string) => void)('mobile');
      await Promise.resolve();
    });
    expect(onChange).toHaveBeenLastCalledWith({ q: 'bug', origin: 'mobile', includeArchived: false });
    const toggle = tree.root
      .findAllByProps({ accessibilityLabel: i18n.t('modelChat.sync.includeArchived') })
      .find(node => node.props.onValueChange !== undefined);
    await act(async () => {
      (toggle?.props.onValueChange as (next: boolean) => void)(true);
      await Promise.resolve();
    });
    expect(onChange).toHaveBeenLastCalledWith({ q: 'bug', origin: 'all', includeArchived: true });
  });
});
