/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to test React/RN structure under vitest */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReactionsRow } from './reactions-row';

const { moveFocus } = vi.hoisted(() => ({ moveFocus: vi.fn() }));

vi.mock('react-native', () => ({
  Modal: 'Modal',
  Pressable: 'Pressable',
  View: 'View',
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0 }),
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
  moveA11yFocus: moveFocus,
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

function modalProps(renderer: TestRenderer.ReactTestRenderer): Props {
  const modal = renderer.root.find(
    node => typeof node.type === 'string' && (node.type as string) === 'Modal'
  );
  return modal.props as Props;
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
    expect(modalProps(renderer).visible).toBe(true);

    // The backdrop is the labelled pressable without a button role.
    press(
      renderer,
      p => p.accessibilityLabel === 'Close reactions' && p.accessibilityRole === undefined
    );
    expect(modalProps(renderer).visible).toBe(false);

    expectDelayedFocusRestore();
    renderer.unmount();
  });

  it('restores focus to the trigger after a reaction is picked', async () => {
    const renderer = await openPicker();

    press(renderer, p => p.accessibilityLabel === 'Thumbs up');
    expect(modalProps(renderer).visible).toBe(false);

    expectDelayedFocusRestore();
    renderer.unmount();
  });

  it('cancels a pending focus restore when the picker reopens inside the window', async () => {
    const renderer = await openPicker();

    press(
      renderer,
      p => p.accessibilityLabel === 'Close reactions' && p.accessibilityRole === undefined
    );
    press(renderer, p => p.accessibilityLabel === 'Add reaction');
    expect(modalProps(renderer).visible).toBe(true);

    // The stale timer must not pull focus to the trigger behind the sheet.
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(moveFocus).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('restores focus to the trigger after the Android back button closes the picker', async () => {
    const renderer = await openPicker();

    act(() => {
      (modalProps(renderer).onRequestClose as () => void)();
    });
    expect(modalProps(renderer).visible).toBe(false);

    expectDelayedFocusRestore();
    renderer.unmount();
  });
});
