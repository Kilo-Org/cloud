import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { ChatTitle } from './chat-title';
import { CHAT_TITLE_MAX_LENGTH } from '@/lib/chat/store';
import { act } from '@/test/renderer';
import { renderWithProviders, type RenderWithProvidersResult } from '@/test/render-with-providers';

vi.mock('react-native', () => ({ Pressable: 'Pressable' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/chat/beta-pill', () => ({ BetaPill: 'BetaPill' }));
vi.mock('@/components/rename-modal', () => ({ RenameModal: 'RenameModal' }));

let view: RenderWithProvidersResult | undefined = undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

function assertHandler(value: unknown): asserts value is (...args: unknown[]) => unknown {
  if (typeof value !== 'function') {
    throw new TypeError('Expected a UI handler');
  }
}

describe('the chat title', () => {
  it('disables rename until the chat has a stored row', async () => {
    view = await renderWithProviders(
      createElement(ChatTitle, {
        title: 'Chat',
        initialValue: '',
        canRename: false,
        onRename: vi.fn(),
      })
    );

    const title = view.renderer.root.find(node => (node.type as string) === 'Pressable');
    expect(title.props.disabled).toBe(true);
    expect(view.renderer.root.findAll(node => (node.type as string) === 'BetaPill')).toHaveLength(
      1
    );
  });

  it('opens the current name, saves it, and closes the dialog', async () => {
    const rename = vi.fn(async () => {
      await Promise.resolve();
    });
    view = await renderWithProviders(
      createElement(ChatTitle, {
        title: 'My chat',
        initialValue: 'My chat',
        canRename: true,
        onRename: rename,
      })
    );
    const tree = view.renderer;
    const title = tree.root.find(node => (node.type as string) === 'Pressable');
    expect(title.props.disabled).toBe(false);

    const press: unknown = title.props.onPress;
    assertHandler(press);
    act(() => {
      press();
    });
    const dialog = tree.root.find(node => (node.type as string) === 'RenameModal');
    expect(dialog.props.initialValue).toBe('My chat');
    expect(dialog.props.maxLength).toBe(CHAT_TITLE_MAX_LENGTH);
    const save: unknown = dialog.props.onSave;
    assertHandler(save);
    await act(async () => {
      await save('New name');
    });
    expect(rename).toHaveBeenCalledWith('New name');
    const close: unknown = dialog.props.onClose;
    assertHandler(close);
    act(() => {
      close();
    });
    expect(tree.root.findAll(node => (node.type as string) === 'RenameModal')).toHaveLength(0);
  });
});
