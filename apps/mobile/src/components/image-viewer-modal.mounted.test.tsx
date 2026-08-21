/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as animated-splash-overlay.mounted.test.tsx) */
import { type ComponentProps, createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { ImageViewerModal } from './image-viewer-modal';

// A chainable gesture stub: each builder method returns the same object so the
// modal's Pinch/Pan/Tap/Race/Simultaneous chains resolve without RNGH.
function makeGesture(): Record<string, unknown> {
  const gesture: Record<string, unknown> = {};
  gesture.onUpdate = () => gesture;
  gesture.onEnd = () => gesture;
  gesture.numberOfTaps = () => gesture;
  return gesture;
}

vi.mock('react-native', () => ({
  Modal: 'Modal',
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('@/components/ui/icons', () => ({
  Share: 'Share',
  X: 'X',
  AlertCircle: 'AlertCircle',
}));
vi.mock('react-native-gesture-handler', () => ({
  Gesture: {
    Pinch: makeGesture,
    Pan: makeGesture,
    Tap: makeGesture,
    Race: makeGesture,
    Simultaneous: makeGesture,
  },
  GestureDetector: 'GestureDetector',
  GestureHandlerRootView: 'GestureHandlerRootView',
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  useSharedValue: (value: unknown) => ({ value }),
  useAnimatedStyle: () => ({}),
  withTiming: (value: unknown) => value,
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock('react-native-worklets', () => ({
  scheduleOnRN: vi.fn(),
}));
vi.mock('@/components/ui/image', () => ({ Image: 'Image' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#111827', mutedForeground: '#6b7280' }),
}));

function findByType(
  root: TestRenderer.ReactTestInstance,
  type: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && (node.type as string) === type);
}

async function mountViewer(
  props: Partial<ComponentProps<typeof ImageViewerModal>>
): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(
      createElement(ImageViewerModal, {
        visible: true,
        uri: 'file:///cache/photo.png',
        filename: 'photo.png',
        onClose: () => undefined,
        ...props,
      })
    );
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

describe('ImageViewerModal mounted', () => {
  it('shows the Image unavailable fallback and keeps Share enabled on decode failure', async () => {
    const onShare = vi.fn<() => void>();
    const renderer = await mountViewer({ onShare });

    const images = findByType(renderer.root, 'Image');
    expect(images).toHaveLength(1);

    const image = images[0];
    if (!image) {
      throw new Error('viewer Image missing');
    }
    await act(async () => {
      await Promise.resolve();
      (image.props.onError as () => void)();
    });

    // The zoomable image is replaced by the fallback.
    expect(findByType(renderer.root, 'Image')).toHaveLength(0);
    expect(findByType(renderer.root, 'AlertCircle')).toHaveLength(1);
    const unavailable = findByType(renderer.root, 'Text').filter(
      node => node.props.children === 'Image unavailable'
    );
    expect(unavailable).toHaveLength(1);

    // The Share header pressable stays enabled when onShare exists.
    const share = findByType(renderer.root, 'Pressable').find(
      node =>
        typeof node.props.accessibilityLabel === 'string' &&
        node.props.accessibilityLabel.startsWith('Share ')
    );
    expect(share).toBeDefined();
    expect(share?.props.disabled).toBe(false);
    expect(share?.props.accessibilityState).toEqual({ disabled: false, busy: false });

    renderer.unmount();
  });
});
