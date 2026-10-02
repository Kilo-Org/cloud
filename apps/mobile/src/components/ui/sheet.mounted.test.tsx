// The app's one native bottom-sheet surface: it must stay unmounted while
// closed, hand the native sheet the app's surface colour (or a forced dark
// theme still shows a light sheet), and stay mounted through the dismiss
// animation. Consumers assert their own content; this suite pins the wrapper's
// contract with `@expo/ui/community/bottom-sheet`.

import { QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactElement } from 'react';
import { act, type ReactTestInstance, type ReactTestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Sheet } from '@/components/ui/sheet';
import { renderWithProviders } from '@/test/render-with-providers';

const theme = vi.hoisted(() => ({ colors: { card: '#1F1F24' } }));

vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => theme.colors }));

type SheetProps = Parameters<typeof Sheet>[0];

const mounted: { unmount: () => void }[] = [];

function sheetElement(props: Partial<SheetProps>): ReactElement {
  const { children = createElement('View', { testID: 'sheet-content' }), ...rest } = props;
  // `createElement`'s typings require `children` inside the props object for a
  // component that declares it required, so the JSX rule's preference does not
  // apply to this call shape.
  // eslint-disable-next-line react/no-children-prop -- createElement, not JSX
  return createElement(Sheet, { visible: true, onClose: () => undefined, children, ...rest });
}

async function mount(props: Partial<SheetProps> = {}) {
  const ui = await renderWithProviders(sheetElement(props));
  mounted.push(ui);
  return ui;
}

function sheet(renderer: ReactTestRenderer): ReactTestInstance | undefined {
  return renderer.root.findAll(node => (node.type as string) === 'BottomSheet')[0];
}

beforeEach(() => {
  for (const ui of mounted.splice(0)) {
    ui.unmount();
  }
});

describe('Sheet', () => {
  it('renders no native sheet while closed', async () => {
    const { renderer } = await mount({ visible: false });

    expect(sheet(renderer)).toBeUndefined();
    expect(renderer.root.findAllByProps({ testID: 'sheet-content' })).toHaveLength(0);
  });

  it('presents at the first detent with the app surface colour and a dismissible backdrop', async () => {
    const { renderer } = await mount({ snapPoints: ['50%', '90%'] });
    const node = sheet(renderer);
    if (!node) {
      throw new Error('sheet not rendered');
    }

    expect(node.props.index).toBe(0);
    expect(node.props.snapPoints).toEqual(['50%', '90%']);
    // Without the app's card colour the native sheet paints the platform
    // surface, which contradicts a forced in-app dark theme.
    expect(node.props.backgroundStyle).toEqual({ backgroundColor: '#1F1F24' });
    // Android Back only dismisses when the sheet allows it.
    expect(node.props.enablePanDownToClose).toBe(true);
    // The default drag indicator is shown; null hides it.
    expect(node.props.handleComponent).toBeUndefined();
    expect(renderer.root.findAllByProps({ testID: 'sheet-content' })).toHaveLength(1);
  });

  it('hides the drag indicator when asked', async () => {
    const { renderer } = await mount({ showHandle: false });
    const node = sheet(renderer);
    if (!node) {
      throw new Error('sheet not rendered');
    }

    expect(node.props.handleComponent).toBeNull();
  });

  it('starts the dismiss animation and unmounts only once the native sheet reports it', async () => {
    const onClose = vi.fn<() => void>();
    const onDismiss = vi.fn<() => void>();
    const { renderer, queryClient } = await mount({ onClose, onDismiss });

    await act(async () => {
      renderer.update(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          sheetElement({ visible: false, onClose, onDismiss })
        )
      );
      await Promise.resolve();
    });

    // Still mounted: `index` -1 starts the native dismiss, and the native
    // `onDismiss` event ends it. Unmounting here would cut the animation off.
    const closing = sheet(renderer);
    if (!closing) {
      throw new Error('the sheet must stay mounted through the dismiss animation');
    }
    expect(closing.props.index).toBe(-1);
    expect(onDismiss).not.toHaveBeenCalled();

    await act(async () => {
      (closing.props.onDismiss as () => void)();
      await Promise.resolve();
    });

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(sheet(renderer)).toBeUndefined();
  });

  it('forwards a native close', async () => {
    const onClose = vi.fn<() => void>();
    const { renderer } = await mount({ onClose });
    const node = sheet(renderer);
    if (!node) {
      throw new Error('sheet not rendered');
    }

    await act(async () => {
      (node.props.onClose as () => void)();
      await Promise.resolve();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(renderer.root.findAllByProps({ testID: 'sheet-content' })).toHaveLength(1);
  });
});
