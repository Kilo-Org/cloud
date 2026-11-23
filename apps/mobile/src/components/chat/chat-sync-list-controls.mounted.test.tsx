/* eslint-disable typescript-eslint/no-deprecated -- the DOM-free `test-renderer` mounts React/RN trees under vitest (see src/test/renderer.ts) */
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatSyncListControls } from '@/components/chat/chat-sync-list-controls';
import { i18n } from '@/i18n';
import { type ChatListFilters, DEFAULT_CHAT_FILTERS } from '@/lib/chat/sync/sync-list';
import { act, type ReactTestInstance } from '@/test/renderer';
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

/** The one node a query must answer with, so a missing control fails the case. */
function found(nodes: readonly ReactTestInstance[], what: string): ReactTestInstance {
  const node = nodes.at(0);
  if (node === undefined) {
    throw new Error(`the screen drew no ${what}`);
  }
  return node;
}

/** The values a mocked segmented control was handed, read without trusting props. */
function segmentValues(node: ReactTestInstance): readonly string[] {
  const props: unknown = node.props;
  if (typeof props !== 'object' || props === null || !('options' in props)) {
    throw new TypeError('the segmented control was given no props');
  }
  const narrowed: unknown = props.options;
  if (!Array.isArray(narrowed)) {
    throw new TypeError('the segmented control was given no options');
  }
  const options: readonly unknown[] = narrowed;
  return options.map(option => {
    if (typeof option !== 'object' || option === null || !('value' in option)) {
      throw new TypeError('a segmented control option is not an object with a value');
    }
    const value: unknown = option.value;
    if (typeof value !== 'string') {
      throw new TypeError('a segmented control option has no string value');
    }
    return value;
  });
}

async function mount(filters: ChatListFilters = DEFAULT_CHAT_FILTERS) {
  const onChange = vi.fn<(next: ChatListFilters) => void>();
  view = await renderWithProviders(createElement(ChatSyncListControls, { filters, onChange }));
  return { tree: view.renderer, onChange };
}

describe('ChatSyncListControls', () => {
  it('reports the typed query and the cleared field', async () => {
    const { tree, onChange } = await mount({ ...DEFAULT_CHAT_FILTERS, origin: 'cli' });
    const field = found(tree.root.findAllByProps({ hasText: false }), 'search field');
    await act(async () => {
      (field.props.onChangeText as (text: string) => void)('deploy');
      await Promise.resolve();
    });
    expect(onChange).toHaveBeenLastCalledWith({
      q: 'deploy',
      origin: 'cli',
      includeArchived: false,
    });
    await act(async () => {
      (field.props.onClear as () => void)();
      await Promise.resolve();
    });
    expect(onChange).toHaveBeenLastCalledWith({ q: '', origin: 'cli', includeArchived: false });
  });

  it('switches origin and the archived toggle without touching the query', async () => {
    const { tree, onChange } = await mount({ q: 'bug', origin: 'all', includeArchived: false });
    const segments = found(tree.root.findAllByProps({ semantics: 'tabs' }), 'origin control');
    expect(segmentValues(segments)).toEqual(['all', 'mobile', 'cli']);
    await act(async () => {
      (segments.props.onChange as (value: string) => void)('mobile');
      await Promise.resolve();
    });
    expect(onChange).toHaveBeenLastCalledWith({
      q: 'bug',
      origin: 'mobile',
      includeArchived: false,
    });
    const toggle = tree.root
      .findAllByProps({ accessibilityLabel: i18n.t('modelChat.sync.includeArchived') })
      .find(node => node.props.onValueChange !== undefined);
    if (toggle === undefined) {
      throw new Error('the screen drew no archived toggle');
    }
    await act(async () => {
      (toggle.props.onValueChange as (next: boolean) => void)(true);
      await Promise.resolve();
    });
    expect(onChange).toHaveBeenLastCalledWith({ q: 'bug', origin: 'all', includeArchived: true });
  });
});
