// The app's one native bottom-sheet surface: it must stay unmounted while
// closed, hand the native sheet the app's surface colour (or a forced dark
// theme still shows a light sheet), and stay mounted through the dismiss
// animation. Consumers assert their own content; this suite pins the wrapper's
// contract with `@expo/ui/community/bottom-sheet`.

import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createElement,
  type ReactElement,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import { act, type ReactTestInstance, type ReactTestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Sheet } from '@/components/ui/sheet';
import { renderWithProviders } from '@/test/render-with-providers';

const theme = vi.hoisted(() => ({ colors: { card: '#1F1F24' } }));

vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => theme.colors }));

// Models the parts of `@expo/ui/community/bottom-sheet` this suite depends on:
// `index` drives a native presentation, a dismissal reports through a guard that
// is only cleared when `index` returns to >= 0, the report turns the native
// presentation off, and the report itself does not re-present. A report landing
// after a reopen therefore leaves the library `presented=false`, and re-asking
// for the index it already has restarts nothing — which is why the wrapper holds
// `index` at -1 until the report and only then asks for 0.
const nativeSheet = vi.hoisted(() => ({
  mounts: 0,
  // Android's BottomSheet fires its close callbacks synchronously from the
  // `index === -1` effect; iOS fires them from the native dismiss event later.
  synchronous: false,
  dismiss: (): void => undefined,
}));

vi.mock('@expo/ui/community/bottom-sheet', () => {
  type NativeSheetProps = {
    index: number;
    onClose?: () => void;
    onDismiss?: () => void;
    children?: ReactNode;
  };

  function NativeSheetStub(props: NativeSheetProps) {
    const { index, onClose, onDismiss } = props;
    const [presented, setPresented] = useState(index >= 0);
    const closedRef = useRef(index < 0);
    const closeRef = useRef(onClose);
    closeRef.current = onClose;
    const dismissRef = useRef(onDismiss);
    dismissRef.current = onDismiss;

    useEffect(() => {
      if (index === -1) {
        setPresented(false);
        // Android's BottomSheet runs `fireCloseCallbacks` from this branch
        // (BottomSheet.android.tsx), i.e. synchronously in a layout effect;
        // iOS reports later from the native dismiss event via nativeSheet.dismiss().
        if (nativeSheet.synchronous) {
          nativeSheet.dismiss();
        }
      } else {
        closedRef.current = false;
        setPresented(true);
      }
    }, [index]);

    useEffect(() => {
      nativeSheet.mounts += 1;
    }, []);

    // Re-registered every commit so a test always drives the live handlers.
    useEffect(() => {
      nativeSheet.dismiss = () => {
        if (closedRef.current) {
          return;
        }
        closedRef.current = true;
        setPresented(false);
        closeRef.current?.();
        dismissRef.current?.();
      };
    });

    // `presented` goes through the host props so the suite can observe the
    // native presentation state without reaching into the stub.
    return createElement('BottomSheet', { ...props, presented });
  }

  return { BottomSheet: NativeSheetStub };
});

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

async function updateSheet(
  renderer: ReactTestRenderer,
  queryClient: QueryClient,
  props: Partial<SheetProps>
): Promise<void> {
  await act(async () => {
    renderer.update(
      createElement(QueryClientProvider, { client: queryClient }, sheetElement(props))
    );
    await Promise.resolve();
  });
}

function sheet(renderer: ReactTestRenderer): ReactTestInstance | undefined {
  return renderer.root.findAll(node => (node.type as string) === 'BottomSheet')[0];
}

beforeEach(() => {
  nativeSheet.mounts = 0;
  nativeSheet.synchronous = false;
  nativeSheet.dismiss = () => undefined;
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

    await updateSheet(renderer, queryClient, { visible: false, onClose, onDismiss });

    // Still mounted: `index` -1 starts the native dismiss, and the native
    // `onDismiss` event ends it. Unmounting here would cut the animation off.
    const closing = sheet(renderer);
    if (!closing) {
      throw new Error('the sheet must stay mounted through the dismiss animation');
    }
    expect(closing.props.index).toBe(-1);
    expect(closing.props.presented).toBe(false);
    expect(onDismiss).not.toHaveBeenCalled();

    await act(async () => {
      nativeSheet.dismiss();
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

  it('dismisses and reopens again when the platform reports the dismissal synchronously (Android)', async () => {
    nativeSheet.synchronous = true;
    const onClose = vi.fn<() => void>();
    const onDismiss = vi.fn<() => void>();
    const { renderer, queryClient } = await mount({ onClose, onDismiss });

    await updateSheet(renderer, queryClient, { visible: false, onClose, onDismiss });

    // Android reports from the host's own effect, so the sheet is already gone in
    // this commit. The host flag has to be cleared with it, or the wrapper's
    // `[visible]` effect (which runs after the host's) re-arms the deferral for a
    // dismissal that already reported.
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(sheet(renderer)).toBeUndefined();

    await updateSheet(renderer, queryClient, { visible: true, onClose, onDismiss });
    expect(sheet(renderer)?.props.index).toBe(0);
    expect(sheet(renderer)?.props.presented).toBe(true);

    // And a later close still dismisses.
    await updateSheet(renderer, queryClient, { visible: false, onClose, onDismiss });
    expect(onDismiss).toHaveBeenCalledTimes(2);
    expect(sheet(renderer)).toBeUndefined();
  });

  it('re-presents a reopened sheet when the superseded dismiss reports late, and the next dismissal still lands', async () => {
    const onClose = vi.fn<() => void>();
    const onDismiss = vi.fn<() => void>();
    const { renderer, queryClient } = await mount({ onClose, onDismiss });
    const mountsAtStart = nativeSheet.mounts;

    // Close, then reopen before the native dismissal reports back.
    await updateSheet(renderer, queryClient, { visible: false, onClose, onDismiss });
    expect(sheet(renderer)?.props.index).toBe(-1);
    expect(sheet(renderer)?.props.presented).toBe(false);

    // The reopen is deferred: handing the library `index` 0 while its dismissal
    // is still in flight is the race that leaves the sheet gone for good, so the
    // index stays -1 until the dismissal reports.
    await updateSheet(renderer, queryClient, { visible: true, onClose, onDismiss });
    expect(sheet(renderer)?.props.index).toBe(-1);
    expect(sheet(renderer)?.props.presented).toBe(false);
    // The host is not remounted to recover: that presentation is what the native
    // sheet refuses mid-dismissal.
    expect(nativeSheet.mounts).toBe(mountsAtStart);

    // The native dismissal lands after the reopen. It must not reach the caller,
    // and it must re-present the sheet the caller still asked for.
    await act(async () => {
      nativeSheet.dismiss();
      await Promise.resolve();
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(sheet(renderer)?.props.index).toBe(0);
    expect(sheet(renderer)?.props.presented).toBe(true);
    expect(renderer.root.findAllByProps({ testID: 'sheet-content' })).toHaveLength(1);

    // A dismissal that follows the reopen is a real one: it ends the sheet and
    // reports exactly once.
    await updateSheet(renderer, queryClient, { visible: false, onClose, onDismiss });
    await act(async () => {
      nativeSheet.dismiss();
      await Promise.resolve();
    });

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(sheet(renderer)).toBeUndefined();
  });

  it('ends the sheet when the native sheet dismisses on its own (swipe, backdrop or Back)', async () => {
    const onClose = vi.fn<() => void>();
    const onDismiss = vi.fn<() => void>();
    const { renderer } = await mount({ onClose, onDismiss });

    // The caller only learns about a self-dismissal from the native event, so
    // `visible` is still true while it reports; it must still end the
    // presentation and tell the caller.
    await act(async () => {
      nativeSheet.dismiss();
      await Promise.resolve();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(sheet(renderer)).toBeUndefined();
  });
});
