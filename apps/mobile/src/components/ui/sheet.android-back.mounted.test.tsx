// Android Back reaches the app before the native sheet's own window takes
// focus, so the wrapper answers that press itself. This suite pins that answer:
// it closes the sheet, it still asks a caller that wants to confirm first, and
// it never registers on iOS or after the sheet closes.

import { QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act } from '@/test/renderer';
import { Sheet } from '@/components/ui/sheet';
import { renderWithProviders } from '@/test/render-with-providers';

const platform = vi.hoisted(() => ({
  os: 'android' as string,
  backListeners: [] as (() => boolean)[],
}));

vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({ card: '#1F1F24' }) }));
vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return platform.os;
    },
  },
  View: 'View',
  BackHandler: {
    addEventListener: (_event: string, listener: () => boolean) => {
      platform.backListeners.push(listener);
      return {
        remove: () => {
          const index = platform.backListeners.indexOf(listener);
          if (index !== -1) {
            platform.backListeners.splice(index, 1);
          }
        },
      };
    },
  },
}));

vi.mock('@expo/ui/community/bottom-sheet', () => ({
  BottomSheet: (props: { children?: ReactElement }) =>
    createElement('BottomSheet', props, props.children),
}));

const mounted: { unmount: () => void }[] = [];

function sheetIndex(renderer: { root: { findAllByType: (type: never) => { props: { index?: number } }[] } }) {
  const node = renderer.root.findAllByType('BottomSheet' as never).at(0);
  if (!node) {
    throw new Error('sheet not rendered');
  }
  return node.props.index;
}

async function mount(onClose: () => void, onRequestDismiss?: () => boolean) {
  const ui = await renderWithProviders(
    <Sheet visible onClose={onClose} onRequestDismiss={onRequestDismiss}>
      {createElement('View', { testID: 'sheet-content' })}
    </Sheet>
  );
  mounted.push(ui);
  return ui;
}

async function pressBack(): Promise<boolean> {
  const listener = platform.backListeners.at(-1);
  if (!listener) {
    throw new Error('no app-level back listener registered');
  }
  let handled = false;
  await act(async () => {
    handled = listener();
    await Promise.resolve();
  });
  return handled;
}

beforeEach(() => {
  platform.os = 'android';
  platform.backListeners.length = 0;
  for (const ui of mounted.splice(0)) {
    ui.unmount();
  }
});

describe('Sheet Android back before the sheet window owns it', () => {
  it('closes the sheet when the press reaches the app instead of the sheet', async () => {
    const onClose = vi.fn<() => void>();
    await mount(onClose);

    expect(await pressBack()).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the sheet open when the caller refuses the dismissal', async () => {
    const onRequestDismiss = vi.fn(() => false);
    const onClose = vi.fn<() => void>();
    const { renderer } = await mount(onClose, onRequestDismiss);

    expect(await pressBack()).toBe(true);
    expect(onRequestDismiss).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(renderer.root.findAllByProps({ testID: 'sheet-content' })).toHaveLength(1);
  });

  it('stops listening once the sheet is closed', async () => {
    const { renderer } = await mount(() => undefined);
    expect(platform.backListeners).toHaveLength(1);

    await act(async () => {
      renderer.update(
        <Sheet visible={false} onClose={() => undefined}>
          {createElement('View', { testID: 'sheet-content' })}
        </Sheet>
      );
      await Promise.resolve();
    });

    expect(platform.backListeners).toHaveLength(0);
  });

  it('leaves Back to the native sheet on iOS', async () => {
    platform.os = 'ios';
    await mount(() => undefined);

    expect(platform.backListeners).toHaveLength(0);
  });

  it('does not ask the caller again for a dismissal already in flight', async () => {
    const onRequestDismiss = vi.fn(() => true);
    const onClose = vi.fn<() => void>();
    const { renderer, queryClient } = await mount(onClose, onRequestDismiss);

    const update = async (visible: boolean) => {
      await act(async () => {
        renderer.update(
          createElement(
            QueryClientProvider,
            { client: queryClient },
            <Sheet visible={visible} onClose={onClose} onRequestDismiss={onRequestDismiss}>
              {createElement('View', { testID: 'sheet-content' })}
            </Sheet>
          )
        );
        await Promise.resolve();
      });
    };

    // Close and reopen before the native dismissal reports: the wrapper keeps
    // the presentation on its way out and holds the reopen back.
    await update(false);
    await update(true);
    expect(sheetIndex(renderer)).toBe(-1);

    expect(await pressBack()).toBe(true);
    expect(onRequestDismiss).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
