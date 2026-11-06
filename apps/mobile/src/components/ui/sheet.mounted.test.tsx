/* eslint-disable max-lines -- the presentation, dismissal and touch-gate contract with the native sheet stays one suite (same pattern as sheet-header.mounted.test.tsx) */
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Sheet } from '@/components/ui/sheet';
import {
  isSheetTouchHeld,
  SHEET_TOUCH_HOLD_MS,
  SHEET_TOUCH_SETTLE_MS,
} from '@/lib/sheet-touch-guard';
import { renderWithProviders } from '@/test/render-with-providers';

const theme = vi.hoisted(() => ({ colors: { card: '#1F1F24' } }));

vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => theme.colors }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, View: 'View' }));

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
  // The iOS sheet reports a dimmed-area tap through this prop instead of
  // dismissing on its own.
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
  nativeSheet.mounts = 0;
  nativeSheet.synchronous = false;
  nativeSheet.dismiss = () => undefined;
  nativeSheet.backdropTap = () => undefined;
  nativeSheet.dismissGestures = true;
  for (const ui of mounted.splice(0)) {
    ui.unmount();
  }
});

afterEach(() => {
  vi.useRealTimers();
});

/** Runs clock and microtasks inside one act, so React settles around the ticks. */
async function settleTimers(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  });
}

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

  it('turns only the drag gesture off when the content scrolls', async () => {
    const { renderer } = await mount({ dismissGestures: false });
    const node = sheet(renderer);
    if (!node) {
      throw new Error('sheet not rendered');
    }

    expect(node.props.dismissGestures).toBe(false);
    // Back and the Android scrim still ask to dismiss; the form answers them.
    expect(node.props.enablePanDownToClose).toBe(true);
  });

  it('asks the caller before a requested dismissal and honours a refusal', async () => {
    const onRequestDismiss = vi.fn(() => false);
    const onClose = vi.fn<() => void>();
    const { renderer } = await mount({ onRequestDismiss, onClose });
    const node = sheet(renderer);
    if (!node) {
      throw new Error('sheet not rendered');
    }

    // The native sheet asks the JS handler; refusing keeps it presented.
    expect((node.props.onRequestDismiss as () => boolean)()).toBe(false);
    expect(onRequestDismiss).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
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

  // Until the native sheet's own window takes touch, the app window still owns
  // it: the hold is what keeps a tap made while the sheet opens off the screen
  // and the tab bar behind it. Every presentation arms its own hold, because a
  // reopened sheet is a new window with the same opening window.
  it('holds the app window touch while it is presented and re-arms on every presentation', async () => {
    vi.useFakeTimers();
    const onClose = vi.fn<() => void>();
    const onDismiss = vi.fn<() => void>();
    const { renderer, queryClient } = await mount({ onClose, onDismiss });

    expect(isSheetTouchHeld()).toBe(true);

    await updateSheet(renderer, queryClient, { visible: true, onClose, onDismiss });
    expect(isSheetTouchHeld()).toBe(true);

    await updateSheet(renderer, queryClient, { visible: false, onClose, onDismiss });
    await act(async () => {
      nativeSheet.dismiss();
      await Promise.resolve();
    });
    // The report arms the settle hold; the presentation that follows gets its
    // own opening window once the settle is over.
    await settleTimers(SHEET_TOUCH_SETTLE_MS + 1);
    expect(isSheetTouchHeld()).toBe(false);

    await updateSheet(renderer, queryClient, { visible: true, onClose, onDismiss });
    expect(isSheetTouchHeld()).toBe(true);
  });

  // The native sheet lets go of touch when its dismissal starts and reports the
  // finished animation only after it: the second tap of a double press aimed at
  // the sheet's Apply must reach the gate, not the row underneath the button.
  it('keeps the app window touch from the close request through the settle window', async () => {
    vi.useFakeTimers();
    const { renderer, queryClient } = await mount();

    await updateSheet(renderer, queryClient, { visible: false });
    // Still closing: the sheet is mounted and no dismissal has reported.
    expect(sheet(renderer)?.props.index).toBe(-1);
    expect(isSheetTouchHeld()).toBe(true);

    await act(async () => {
      nativeSheet.dismiss();
      await Promise.resolve();
    });
    // The report ended the close-request lease AND armed the settle hold: the
    // sheet's window is gone by now, so the frames right behind the report
    // still belong to the gate.
    expect(isSheetTouchHeld()).toBe(true);

    await settleTimers(SHEET_TOUCH_SETTLE_MS + 1);
    expect(isSheetTouchHeld()).toBe(false);
  });

  it('re-arms the settle hold on every dismissal of the same sheet', async () => {
    vi.useFakeTimers();
    const onClose = vi.fn<() => void>();
    const onDismiss = vi.fn<() => void>();
    const { renderer, queryClient } = await mount({ onClose, onDismiss });

    // First dismissal. The report arms the settle hold here, in `onDismiss`,
    // not in a state step that could only flip once.
    await updateSheet(renderer, queryClient, { visible: false, onClose, onDismiss });
    expect(isSheetTouchHeld()).toBe(true);
    await act(async () => {
      nativeSheet.dismiss();
      await Promise.resolve();
    });
    expect(isSheetTouchHeld()).toBe(true);
    await settleTimers(SHEET_TOUCH_SETTLE_MS + 1);
    expect(isSheetTouchHeld()).toBe(false);

    // Reopen; the sheet is the same instance, so the second dismissal proves
    // the first report's hold did not leave a shape that swallows the second.
    await updateSheet(renderer, queryClient, { visible: true, onClose, onDismiss });
    await updateSheet(renderer, queryClient, { visible: false, onClose, onDismiss });
    expect(isSheetTouchHeld()).toBe(true);
    await act(async () => {
      nativeSheet.dismiss();
      await Promise.resolve();
    });
    expect(isSheetTouchHeld()).toBe(true);
    await settleTimers(SHEET_TOUCH_SETTLE_MS + 1);
    expect(isSheetTouchHeld()).toBe(false);
  });

  it('releases the dismissal hold on its bound when the native sheet never reports', async () => {
    vi.useFakeTimers();
    const { renderer, queryClient } = await mount();

    await updateSheet(renderer, queryClient, { visible: false });
    expect(isSheetTouchHeld()).toBe(true);

    // No `nativeSheet.dismiss()` here: a dismissal the platform never reports
    // must not keep the screen behind the sheet dead.
    await settleTimers(SHEET_TOUCH_HOLD_MS + 1);
    expect(isSheetTouchHeld()).toBe(false);
  });

  it('arms the dismissal hold when the sheet dismisses itself (swipe, backdrop or Back)', async () => {
    vi.useFakeTimers();
    const onClose = vi.fn<() => void>();
    const onDismiss = vi.fn<() => void>();
    const { renderer } = await mount({ onClose, onDismiss });

    // Let the opening hold lapse: the sheet is presented and its own window
    // takes touch.
    await settleTimers(SHEET_TOUCH_HOLD_MS + 1);
    expect(isSheetTouchHeld()).toBe(false);

    const node = sheet(renderer);
    if (!node) {
      throw new Error('sheet not rendered');
    }
    // The user drags the sheet down: the request is granted, the sheet starts
    // going away and the gate is armed for its settle window.
    await act(async () => {
      (node.props.onRequestDismiss as () => boolean)();
      await Promise.resolve();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(isSheetTouchHeld()).toBe(true);

    // The report keeps the gate shut through the settle window and tells the
    // caller the dismissal is over.
    await act(async () => {
      nativeSheet.dismiss();
      await Promise.resolve();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(isSheetTouchHeld()).toBe(true);

    await settleTimers(SHEET_TOUCH_SETTLE_MS + 1);
    expect(isSheetTouchHeld()).toBe(false);
  });

  it('does not arm the dismissal hold when the caller refuses the dismissal request', async () => {
    vi.useFakeTimers();
    const onRequestDismiss = vi.fn(() => false);
    const { renderer } = await mount({ onRequestDismiss });

    await settleTimers(SHEET_TOUCH_HOLD_MS + 1);
    expect(isSheetTouchHeld()).toBe(false);

    const node = sheet(renderer);
    if (!node) {
      throw new Error('sheet not rendered');
    }
    await act(async () => {
      (node.props.onRequestDismiss as () => boolean)();
      await Promise.resolve();
    });
    expect(onRequestDismiss).toHaveBeenCalledTimes(1);
    // Refused: the sheet stays up with no dismissal in flight.
    expect(sheet(renderer)?.props.presented).toBe(true);
    expect(isSheetTouchHeld()).toBe(false);
  });

  it('takes no app window touch while it is closed', async () => {
    await mount({ visible: false });

    expect(isSheetTouchHeld()).toBe(false);
  });

  // iOS only: the native sheet there reports a dimmed-area tap instead of
  // dismissing. Its cases live in `sheet.backdrop-tap.mounted.test.tsx`.
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
