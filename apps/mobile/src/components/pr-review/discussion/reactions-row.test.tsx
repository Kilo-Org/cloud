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

vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
  SlideInDown: { duration: () => ({}) },
  SlideOutDown: { duration: () => ({}) },
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0 }),
}));

vi.mock('lucide-react-native', () => ({
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

async function render(element: React.ReactElement): Promise<TestRenderer.ReactTestRenderer> {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    await Promise.resolve();
    renderer = TestRenderer.create(element);
  });
  // Runtime safety: act() could theoretically fail without assigning.
  // eslint-disable-next-line typescript-eslint/no-unnecessary-condition
  if (!renderer) {
    throw new Error('Failed to create test renderer');
  }
  return renderer;
}

function findNode(
  root: TestRenderer.ReactTestInstance,
  type: string,
  match: (props: Record<string, unknown>) => boolean
): TestRenderer.ReactTestInstance | undefined {
  return root.find(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === type &&
      match(node.props as Record<string, unknown>)
  );
}

function pressNode(node: TestRenderer.ReactTestInstance): void {
  act(() => {
    (node.props.onPress as () => void)();
  });
}

function getModalProps(root: TestRenderer.ReactTestInstance): Record<string, unknown> {
  const modal = root.find(
    node => typeof node.type === 'string' && (node.type as string) === 'Modal'
  );
  return modal.props as Record<string, unknown>;
}

describe('ReactionsRow picker dismissal focus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    moveFocus.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('restores focus only after the native Modal dismisses on the backdrop close path', async () => {
    const onToggle = vi.fn<() => void>();
    const renderer = await render(
      createElement(ReactionsRow, { reactions: baseReactions, onToggle })
    );

    const addReaction = findNode(
      renderer.root,
      'Pressable',
      p => p.accessibilityLabel === 'Add reaction'
    );
    if (!addReaction) {
      throw new Error('Add reaction button not found');
    }
    pressNode(addReaction);
    expect(getModalProps(renderer.root).visible).toBe(true);

    const backdrop = findNode(
      renderer.root,
      'Pressable',
      p => p.className === 'flex-1' && p.accessibilityLabel === 'Close reactions'
    );
    if (!backdrop) {
      throw new Error('Backdrop pressable not found');
    }
    pressNode(backdrop);

    // The native Modal is still presented while the exit animation plays, so
    // focus must not move to the trigger yet.
    expect(getModalProps(renderer.root).visible).toBe(true);
    expect(moveFocus).not.toHaveBeenCalled();

    // Native dismissal completes: onDismiss fires and focus returns.
    act(() => {
      (getModalProps(renderer.root).onDismiss as () => void)();
    });
    expect(moveFocus).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(getModalProps(renderer.root).visible).toBe(false);

    renderer.unmount();
  });

  it('restores focus only after the native Modal dismisses when a reaction is picked', async () => {
    const onToggle = vi.fn<() => void>();
    const renderer = await render(
      createElement(ReactionsRow, { reactions: baseReactions, onToggle })
    );

    const addReaction = findNode(
      renderer.root,
      'Pressable',
      p => p.accessibilityLabel === 'Add reaction'
    );
    if (!addReaction) {
      throw new Error('Add reaction button not found');
    }
    pressNode(addReaction);

    const thumbsUp = findNode(
      renderer.root,
      'Pressable',
      p => p.accessibilityLabel === 'Thumbs up'
    );
    if (!thumbsUp) {
      throw new Error('Thumbs up picker button not found');
    }
    pressNode(thumbsUp);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith('THUMBS_UP');
    expect(moveFocus).not.toHaveBeenCalled();

    act(() => {
      (getModalProps(renderer.root).onDismiss as () => void)();
    });
    expect(moveFocus).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(250);
    });

    renderer.unmount();
  });

  it('never moves focus when the row unmounts before the native Modal dismisses', async () => {
    const onToggle = vi.fn<() => void>();
    const renderer = await render(
      createElement(ReactionsRow, { reactions: baseReactions, onToggle })
    );

    const addReaction = findNode(
      renderer.root,
      'Pressable',
      p => p.accessibilityLabel === 'Add reaction'
    );
    if (!addReaction) {
      throw new Error('Add reaction button not found');
    }
    pressNode(addReaction);

    // Android back button answers through onRequestClose (same close path).
    act(() => {
      (getModalProps(renderer.root).onRequestClose as () => void)();
    });
    expect(moveFocus).not.toHaveBeenCalled();

    // The row (and its trigger) unmount before the Modal finishes dismissing;
    // the pending exit timer is cleared and onDismiss never fires.
    renderer.unmount();
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(moveFocus).not.toHaveBeenCalled();
  });
});
