import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReactionsRow } from './reactions-row';

const { moveFocus } = vi.hoisted(() => ({
  moveFocus: vi.fn<(ref: { current: unknown }) => boolean>(() => true),
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  View: 'View',
  // The shared SheetHeader reads the status bar height and the native
  // direction the same way every sheet does.
  StatusBar: { currentHeight: 0 },
  I18nManager: { isRTL: false },
  useWindowDimensions: () => ({ fontScale: 1, width: 390, height: 844, scale: 3 }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/components/ui/icons', () => ({
  SmilePlus: 'SmilePlus',
  X: 'X',
}));

vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000000', mutedForeground: '#6F6A61' }),
}));

vi.mock('@/lib/a11y/announce', () => ({
  requestA11yFocus: moveFocus,
}));

vi.mock('expo-haptics', () => ({
  selectionAsync: vi.fn(),
}));

const baseReactions = [{ content: 'THUMBS_UP', count: 2, viewerHasReacted: false }];

// ── Helpers ──────────────────────────────────────────────────────────

type Props = Record<string, unknown>;

function press(renderer: TestRenderer.ReactTestRenderer, match: (props: Props) => boolean): void {
  const node = renderer.root.find(
    n => typeof n.type === 'string' && (n.type as string) === 'Pressable' && match(n.props as Props)
  );
  act(() => {
    (node.props.onPress as () => void)();
  });
}

/** The native sheet wrapper the picker renders; absent while the picker is shut. */
function sheetProps(renderer: TestRenderer.ReactTestRenderer): Props | undefined {
  const sheet = renderer.root.findAll(
    node => typeof node.type === 'string' && (node.type as string) === 'BottomSheet'
  )[0];
  return sheet?.props as Props | undefined;
}

/**
 * The picker is shutting down when the sheet reports detent -1; the native
 * sheet then unmounts. Both halves are asserted where a test cares which one it
 * is looking at.
 */
function isPickerOpen(renderer: TestRenderer.ReactTestRenderer): boolean {
  return sheetProps(renderer)?.index === 0;
}

/** Runs the native dismiss the sheet reports once its animation finishes. */
function finishDismiss(renderer: TestRenderer.ReactTestRenderer): void {
  const onDismiss = sheetProps(renderer)?.onDismiss as (() => void) | undefined;
  act(() => {
    onDismiss?.();
  });
}

/**
 * The native layout pass that runs once the presented picker exists; the
 * picker moves accessibility focus to its title from it. The header is the
 * shared `SheetHeader`, whose title node is a plain `Text` with no layout
 * handler of its own, so the signal is the modal body's layout.
 */
function layoutPickerTitle(renderer: TestRenderer.ReactTestRenderer): void {
  // The modal wrapper isolates the whole picker (header included); the node
  // that reports the presented sheet's layout is the body inside it. The
  // header reports its own layout too — it samples where the sheet settled —
  // and it sits above the body, so the body is the last one.
  const modal = renderer.root.findByProps({ accessibilityViewIsModal: true });
  const bodies = modal.findAll(node => typeof node.props.onLayout === 'function');
  const body = bodies.at(-1);
  if (!body) {
    throw new Error('picker body not found');
  }
  act(() => {
    (body.props.onLayout as () => void)();
  });
}

/** Mounts a row and taps "Add reaction" so the picker is open. */
async function openPicker(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    await Promise.resolve();
    renderer = TestRenderer.create(
      createElement(ReactionsRow, { reactions: baseReactions, onToggle: vi.fn<() => void>() })
    );
  });
  // Runtime safety: act() could theoretically fail without assigning.
  // eslint-disable-next-line typescript-eslint/no-unnecessary-condition
  if (!renderer) {
    throw new Error('Failed to create test renderer');
  }
  press(renderer, p => p.accessibilityLabel === 'Add reaction');
  // Opening moves the screen reader into the picker's title once the presented
  // sheet lays it out; the picker performs that itself. Clear it so each test's
  // timer assertions see only the restore-to-trigger move.
  expect(moveFocus).not.toHaveBeenCalled();
  layoutPickerTitle(renderer);
  expect(moveFocus).toHaveBeenCalledTimes(1);
  // A move to a ref that is still empty would focus nothing.
  expect(moveFocus.mock.calls[0]?.[0]?.current).toBeTruthy();
  moveFocus.mockClear();
  return renderer;
}

/** Focus must wait out the slide-out, then land on the trigger exactly once. */
function expectDelayedFocusRestore(): void {
  expect(moveFocus).not.toHaveBeenCalled();
  act(() => {
    vi.advanceTimersByTime(400);
  });
  expect(moveFocus).toHaveBeenCalledTimes(1);
}

describe('ReactionsRow picker dismissal focus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    moveFocus.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('restores focus to the trigger after the backdrop closes the picker', async () => {
    const renderer = await openPicker();
    expect(isPickerOpen(renderer)).toBe(true);
    // The picker's content is the modal surface inside the native sheet.
    const surface = renderer.root.findByProps({ accessibilityViewIsModal: true });
    expect(String(surface.type)).toBe('View');
    expect(sheetProps(renderer)).toBeDefined();

    // The picker's close control routes through the sheet's `onClose`; the
    // native sheet owns the backdrop and the swipe, which do the same.
    press(renderer, p => p.accessibilityLabel === 'Close reactions');
    expect(sheetProps(renderer)?.index).toBe(-1);
    finishDismiss(renderer);
    expect(sheetProps(renderer)).toBeUndefined();

    expectDelayedFocusRestore();
    renderer.unmount();
  });

  it('restores focus to the trigger after a reaction is picked', async () => {
    const renderer = await openPicker();

    press(renderer, p => p.accessibilityLabel === 'Thumbs up');
    expect(sheetProps(renderer)?.index).toBe(-1);

    expectDelayedFocusRestore();
    renderer.unmount();
  });

  it('retries the picker title request until one is dispatched, then holds the latch', async () => {
    // A missing host must not latch the once-per-presentation guard.
    moveFocus.mockReturnValueOnce(false).mockReturnValue(true);
    const renderer = await openPicker();
    expect(moveFocus).not.toHaveBeenCalled();

    layoutPickerTitle(renderer);
    expect(moveFocus).toHaveBeenCalledTimes(1);

    // The dispatched request seals the presentation: further layout signals
    // must not ask the platform again.
    layoutPickerTitle(renderer);
    expect(moveFocus).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it('cancels a pending focus restore when the picker reopens inside the window', async () => {
    const renderer = await openPicker();

    press(renderer, p => p.accessibilityLabel === 'Close reactions');
    press(renderer, p => p.accessibilityLabel === 'Add reaction');
    // The reopen is deferred until the native dismissal reports, so the sheet
    // still sits at detent -1 here; it is still a reopen for the restore timer.
    expect(sheetProps(renderer)?.index).toBe(-1);
    // The reopen moves focus into the still-mounted picker title again; only the
    // restore matters here.
    moveFocus.mockClear();

    // The stale timer must not pull focus to the trigger behind the sheet.
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(moveFocus).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('keeps a reopened picker open when the superseded dismiss reports late', async () => {
    const renderer = await openPicker();

    press(renderer, p => p.accessibilityLabel === 'Close reactions');
    expect(sheetProps(renderer)?.index).toBe(-1);

    // Reopened before the dismissal reported: the reopen is deferred (the sheet
    // stays at detent -1 until the native transition finishes), but the title
    // never unmounted, so focus still moves back into it.
    press(renderer, p => p.accessibilityLabel === 'Add reaction');
    expect(isPickerOpen(renderer)).toBe(false);
    expect(moveFocus).toHaveBeenCalledTimes(1);
    moveFocus.mockClear();

    // The late native dismissal belongs to the closed presentation: it must
    // re-present the picker instead of closing it, and must not pull focus back
    // to the trigger. The native event reaches the live handlers, as the
    // library's own dispatcher does.
    act(() => {
      const live = sheetProps(renderer);
      (live?.onClose as (() => void) | undefined)?.();
      (live?.onDismiss as (() => void) | undefined)?.();
    });

    expect(isPickerOpen(renderer)).toBe(true);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(moveFocus).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('restores focus to the trigger after the Android back button closes the picker', async () => {
    const renderer = await openPicker();

    const sheet = sheetProps(renderer);
    if (!sheet) {
      throw new Error('the picker sheet must be mounted while it is open');
    }
    act(() => {
      (sheet.onClose as () => void)();
    });
    expect(sheetProps(renderer)?.index).toBe(-1);

    expectDelayedFocusRestore();
    renderer.unmount();
  });
});
