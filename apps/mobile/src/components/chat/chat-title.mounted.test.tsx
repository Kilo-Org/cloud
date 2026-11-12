import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { ChatTitle } from './chat-title';
import { HEADER_TITLE_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { CHAT_TITLE_MAX_LENGTH } from '@/lib/chat/store';
import { act } from '@/test/renderer';
import { renderWithProviders, type RenderWithProvidersResult } from '@/test/render-with-providers';

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/chat/beta-pill', () => ({ BetaPill: 'BetaPill' }));
vi.mock('@/components/rename-modal', () => ({ RenameModal: 'RenameModal' }));

let view: RenderWithProvidersResult | undefined = undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

type Instance = RenderWithProvidersResult['renderer']['root'];

function assertHandler(value: unknown): asserts value is (...args: unknown[]) => unknown {
  if (typeof value !== 'function') {
    throw new TypeError('Expected a UI handler');
  }
}

// The widths the design gate measured on this header at font scale 1: the name
// "Chat" and the BETA notice, in the room the 360dp compact cell gives the pair
// (the name then shrank to "C…") and in the room the 411dp cell gives it.
const TITLE_WIDTH = 33.52;
const NOTICE_WIDTH = 41.52;
const COMPACT_SLOT = 76.19;
const BASE_SLOT = 127.62;

function mount(title = 'Chat') {
  return renderWithProviders(
    createElement(ChatTitle, { title, initialValue: title, canRename: true, onRename: vi.fn() })
  );
}

function layout(instance: Instance, width: number) {
  const handler: unknown = instance.props.onLayout;
  assertHandler(handler);
  act(() => {
    handler({ nativeEvent: { layout: { width, height: 0, x: 0, y: 0 } } });
  });
}

/** The transparent copy the notice's width comes from, and the name's node. */
function nodes(tree: Instance) {
  const pressable = tree.find(node => (node.type as string) === 'Pressable');
  return {
    pressable,
    title: pressable.find(node => (node.type as string) === 'Text'),
    notice: pressable.find(node => (node.type as string) === 'View'),
    drawn: pressable.findAll(node => (node.type as string) === 'BetaPill'),
  };
}

function measure(instance: Instance, widths: { slot: number; title: number; notice: number }) {
  const { pressable, title, notice } = nodes(instance);
  layout(pressable, widths.slot);
  layout(title, widths.title);
  layout(notice, widths.notice);
}

describe('the chat title', () => {
  it('measures the notice without giving it a place in the row', async () => {
    // The first frame must not squeeze the name to make room for a notice that
    // may not fit: the notice is drawn only after the measurement says both fit
    // together, and the measurement itself takes no room.
    view = await mount();

    const { notice, drawn } = nodes(view.renderer.root);
    expect(notice.props.className).toContain('absolute');
    expect(notice.props.className).toContain('opacity-0');
    expect(notice.props['aria-hidden']).toBe(true);
    expect(drawn).toHaveLength(1);
  });

  it('draws the notice when the name and the notice fit beside each other', async () => {
    view = await mount();
    measure(view.renderer.root, {
      slot: BASE_SLOT,
      title: TITLE_WIDTH,
      notice: NOTICE_WIDTH,
    });

    expect(nodes(view.renderer.root).drawn).toHaveLength(2);
  });

  it('gives the notice up rather than squeezing the name on a narrow header', async () => {
    // 33.52 + 7 gap + 41.52 = 82.04 does not fit the compact cell's 76.19dp:
    // the name keeps its width and stays whole.
    view = await mount();
    measure(view.renderer.root, {
      slot: COMPACT_SLOT,
      title: TITLE_WIDTH,
      notice: NOTICE_WIDTH,
    });

    expect(nodes(view.renderer.root).drawn).toHaveLength(1);
  });

  it('gives the notice up for a name that fills the header on its own', async () => {
    // A long name reports the room it was given, which fails every fit test, so
    // the name keeps the whole row and truncates there.
    view = await mount('A name that runs past the header');
    measure(view.renderer.root, {
      slot: BASE_SLOT,
      title: BASE_SLOT,
      notice: NOTICE_WIDTH,
    });

    expect(nodes(view.renderer.root).drawn).toHaveLength(1);
  });

  it('disables rename until the chat has a stored row', async () => {
    view = await renderWithProviders(
      createElement(ChatTitle, {
        title: 'Chat',
        initialValue: 'Chat',
        canRename: false,
        onRename: vi.fn(),
      })
    );

    const { pressable } = nodes(view.renderer.root);
    expect(pressable.props.disabled).toBe(true);
    expect(pressable.props.accessibilityLabel).toBe('Rename chat: Chat');
  });

  it('carries the header title touch target on the pressable itself', async () => {
    // A control-size audit reads the pressable's own view rect, and `hitSlop`
    // does not move it: the floor has to be the class.
    view = await mount();

    const { pressable } = nodes(view.renderer.root);
    expect(pressable.props.className).toContain(HEADER_TITLE_TARGET_CLASS);
    expect(pressable.props.hitSlop).toBeUndefined();
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
