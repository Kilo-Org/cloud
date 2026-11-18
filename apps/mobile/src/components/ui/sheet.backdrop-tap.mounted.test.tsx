// iOS only: the native sheet there reports a dimmed-area tap instead of
// dismissing on its own (repo-local `BottomSheet.ios`), and the wrapper answers
// it the way Android Back is answered. This suite pins that answer: the report
// closes the sheet, a caller that wants to confirm first can refuse it, a sheet
// with the gestures off never gets the report, and one tap answers the caller
// exactly once.

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
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, View: 'View' }));

// The same native-sheet model `sheet.mounted.test.tsx` pins, so the report paths
// behave like the real library: the wrapper's close is driven by `nativeSheet`.
const nativeSheet = vi.hoisted(() => ({
  synchronous: false,
  dismiss: (): void => undefined,
  backdropTap: (): void => undefined,
  // What the wrapper last asked the native sheet to gate its report with.
  dismissGestures: true,
}));

vi.mock('@expo/ui/community/bottom-sheet', () => {
  type NativeSheetProps = {
    index: number;
    dismissGestures?: boolean;
    onClose?: () => void;
    onDismiss?: () => void;
    onBackdropTap?: () => void;
    children?: ReactNode;
  };

  function NativeSheetStub(props: NativeSheetProps) {
    const { index, dismissGestures = true, onClose, onDismiss, onBackdropTap } = props;
    const [presented, setPresented] = useState(index >= 0);
    const closedRef = useRef(index < 0);
    const closeRef = useRef(onClose);
    closeRef.current = onClose;
    const dismissRef = useRef(onDismiss);
    dismissRef.current = onDismiss;

    useEffect(() => {
      if (index === -1) {
        setPresented(false);
        if (nativeSheet.synchronous) {
          nativeSheet.dismiss();
        }
      } else {
        closedRef.current = false;
        setPresented(true);
      }
    }, [index]);

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
      // The iOS sheet reports a dimmed-area tap only while the gesture is on
      // (repo-local `BottomSheet.ios` passes `dismissOnBackdropTap: dismissGestures`).
      nativeSheet.backdropTap = () => {
        if (!dismissGestures) {
          return;
        }
        onBackdropTap?.();
      };
      nativeSheet.dismissGestures = dismissGestures;
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
  nativeSheet.synchronous = false;
  nativeSheet.dismiss = () => undefined;
  nativeSheet.backdropTap = () => undefined;
  nativeSheet.dismissGestures = true;
  for (const ui of mounted.splice(0)) {
    ui.unmount();
  }
});

describe('Sheet iOS backdrop tap', () => {
  it('closes the sheet when the iOS backdrop tap is reported', async () => {
    const onClose = vi.fn<() => void>();
    const onDismiss = vi.fn<() => void>();
    const { renderer } = await mount({ onClose, onDismiss });

    await act(async () => {
      nativeSheet.backdropTap();
      await Promise.resolve();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    // The caller's own `visible` flip is what unmounts; the wrapper only closes.
    expect(sheet(renderer)).toBeDefined();
  });

  it('asks the caller before an iOS backdrop tap dismisses and honours a refusal', async () => {
    const onRequestDismiss = vi.fn(() => false);
    const onClose = vi.fn<() => void>();
    const { renderer } = await mount({ onRequestDismiss, onClose });

    await act(async () => {
      nativeSheet.backdropTap();
      await Promise.resolve();
    });

    expect(onRequestDismiss).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(renderer.root.findAllByProps({ testID: 'sheet-content' })).toHaveLength(1);
  });

  // A gestures-off sheet (a draft's form) never gets the report at all: the
  // wrapper keeps the native report off, and the stub models that gate.
  it('never reports a backdrop tap for a sheet whose gestures are off', async () => {
    const onClose = vi.fn<() => void>();
    const onRequestDismiss = vi.fn(() => false);
    const { renderer } = await mount({ dismissGestures: false, onRequestDismiss, onClose });

    expect(nativeSheet.dismissGestures).toBe(false);

    await act(async () => {
      nativeSheet.backdropTap();
      await Promise.resolve();
    });

    expect(onRequestDismiss).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(renderer.root.findAllByProps({ testID: 'sheet-content' })).toHaveLength(1);
  });

  // One tap answers once: the wrapper calls the caller's close, the caller
  // drops `visible`, and the dismissal the native sheet then reports must not
  // forward the caller's close a second time.
  it('forwards a reported self-dismissal to the caller exactly once', async () => {
    const onClose = vi.fn<() => void>();
    const { renderer, queryClient } = await mount({ onClose });

    await act(async () => {
      nativeSheet.backdropTap();
      await Promise.resolve();
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    // The caller flipped `visible` off; the wrapper hands the native sheet its
    // dismissal and the stub reports it back through the close callback.
    await updateSheet(renderer, queryClient, { visible: false, onClose });
    await act(async () => {
      nativeSheet.dismiss();
      await Promise.resolve();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(sheet(renderer)).toBeUndefined();
  });
});
