import { type ComponentProps, createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ImageViewerModal } from './image-viewer-modal';
import { AccessibleStatus } from '@/components/ui/accessible-status';

const safeArea = vi.hoisted(() => ({ top: 0, bottom: 0, left: 0, right: 0 }));

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
  Platform: { OS: 'android' as const },
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/centered-state-surface', () => ({ StateSurface: 'StateSurface' }));
vi.mock('@/lib/a11y/announce', () => ({
  announceForA11y: vi.fn(),
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
  useSafeAreaInsets: () => safeArea,
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

/**
 * The outer header container: it keeps the border, background, and the fixed
 * vertical geometry (`paddingTop`/`height`); the controls row lives in an inner
 * wrapper that carries only the landscape side insets.
 */
function findHeaderContainer(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance {
  return root.find(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'View' &&
      typeof node.props.className === 'string' &&
      node.props.className.includes('border-b')
  );
}

function pressableByLabel(
  node: TestRenderer.ReactTestInstance,
  label: string
): TestRenderer.ReactTestInstance | undefined {
  return node.find(
    child =>
      typeof child.type === 'string' &&
      (child.type as string) === 'Pressable' &&
      child.props.accessibilityLabel === label
  );
}

function findRowWrapper(header: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance {
  const wrapper = header.children.find(
    (child): child is TestRenderer.ReactTestInstance =>
      typeof child !== 'string' &&
      typeof child.type === 'string' &&
      (child.type as string) === 'View'
  );
  if (!wrapper) {
    throw new Error('header row wrapper missing');
  }
  return wrapper;
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
  beforeEach(() => {
    Object.assign(safeArea, { top: 0, bottom: 0, left: 0, right: 0 });
  });

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
    expect(findByType(renderer.root, 'StateSurface')).toHaveLength(1);
    expect(findByType(renderer.root, 'CenteredState')).toHaveLength(1);
    const alert = findByType(renderer.root, 'AlertCircle');
    expect(alert).toHaveLength(1);
    expect(alert[0]?.props.color).toBe('#ffffff');
    const unavailable = findByType(renderer.root, 'Text').filter(
      node => node.props.children === 'Image unavailable'
    );
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]?.props.className).toContain('text-white');

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

  it('shows the unavailable row immediately on decode error and clears it in the same commit a renewed uri lands', async () => {
    const renderer = await mountViewer({});

    const image = findByType(renderer.root, 'Image')[0];
    if (!image) {
      throw new Error('viewer Image missing');
    }
    await act(async () => {
      await Promise.resolve();
      (image.props.onError as () => void)();
    });

    // The error replaces the image with the unavailable row at once, and the
    // row persists while the URL is unchanged.
    expect(findByType(renderer.root, 'Image')).toHaveLength(0);
    expect(
      findByType(renderer.root, 'Text').filter(node => node.props.children === 'Image unavailable')
    ).toHaveLength(1);

    // A renewed uri clears the recorded error in the same commit, so the
    // refreshed image shows with no "Image unavailable" flash.
    await act(async () => {
      await Promise.resolve();
      renderer.update(
        createElement(ImageViewerModal, {
          visible: true,
          uri: 'file:///cache/renewed.png',
          filename: 'photo.png',
          onClose: () => undefined,
        })
      );
    });

    expect(findByType(renderer.root, 'Image')).toHaveLength(1);
    expect(findByType(renderer.root, 'Image')[0]?.props.source).toEqual({
      uri: 'file:///cache/renewed.png',
    });
    expect(
      findByType(renderer.root, 'Text').filter(node => node.props.children === 'Image unavailable')
    ).toHaveLength(0);

    renderer.unmount();
  });

  it('renders the share error through AccessibleStatus with white pill text', async () => {
    const renderer = await mountViewer({
      shareError: 'Failed to share file. Please try again.',
    });

    const statuses = renderer.root.findAll(node => node.type === AccessibleStatus);
    expect(statuses).toHaveLength(1);
    const status = statuses[0];
    if (!status) {
      throw new Error('AccessibleStatus not found');
    }
    expect(status.props.message).toBe('Failed to share file. Please try again.');
    expect(status.props.className).toBe('text-center text-sm text-white dark:text-neutral-900');

    const text = findByType(status, 'Text');
    expect(text).toHaveLength(1);
    expect(text[0]?.props.className).toContain('text-white');
    expect(text[0]?.props.className).not.toContain('text-destructive');

    renderer.unmount();
  });

  it('keeps the header geometry keys and a styleless row wrapper at zero side insets', async () => {
    const renderer = await mountViewer({ onShare: () => undefined });

    // Portrait no-op: the outer container keeps its fixed vertical geometry and
    // the row wrapper's style collapses to undefined (an inline 0 would
    // override the wrapper's `px-4` className gutter).
    const header = findHeaderContainer(renderer.root);
    expect(header.props.style).toEqual({ paddingTop: 0, height: 56 });
    const wrapper = findRowWrapper(header);
    expect(wrapper.props.style).toBeUndefined();
    expect(wrapper.props.className).toContain('px-4');
    expect(wrapper.props.className).toContain('flex-row');
    expect(wrapper.props.className).toContain('justify-between');

    renderer.unmount();
  });

  it('supports landscape so a full-screen modal is never portrait-locked', async () => {
    const renderer = await mountViewer({ onShare: () => undefined });

    // e11 viewer-landscape: RN locks a full-screen modal on iPhone to portrait
    // unless the Modal lists the orientations it supports. With rotation
    // enabled app-wide, an unset prop kept the viewer's content at portrait
    // bounds in a landscape window and clipped the photo at the screen bottom.
    const modal = findByType(renderer.root, 'Modal')[0];
    if (!modal) {
      throw new Error('Modal missing');
    }
    expect(modal.props.supportedOrientations).toEqual(['portrait', 'landscape']);

    renderer.unmount();
  });

  it('fits the image inside the flex area below the header', async () => {
    const renderer = await mountViewer({ onShare: () => undefined });

    // The image fills its zoomable wrapper and is contained — never
    // cover-scaled or clipped by the black area that starts below the header.
    const image = findByType(renderer.root, 'Image')[0];
    if (!image) {
      throw new Error('viewer Image missing');
    }
    expect(image.props.contentFit).toBe('contain');
    expect(image.props.className).toContain('h-full');
    expect(image.props.className).toContain('w-full');

    const zoomWrapper = image.parent;
    const gestureArea = zoomWrapper?.parent;
    const imageArea = gestureArea?.parent;
    expect(imageArea?.props.className).toContain('flex-1');
    expect(imageArea?.props.className).toContain('overflow-hidden');

    renderer.unmount();
  });

  it('pads the header row by the landscape side insets and keeps the controls inside it', async () => {
    safeArea.left = 47;
    safeArea.right = 59;
    const renderer = await mountViewer({ onShare: () => undefined });

    // The side insets land on the row wrapper so they ADD to its `px-4`
    // gutter (an inline padding on the container would override the class);
    // the fixed vertical geometry stays on the outer container, so a rotation
    // never shifts the header height.
    const header = findHeaderContainer(renderer.root);
    expect(header.props.style).toEqual({ paddingTop: 0, height: 56 });
    const wrapper = findRowWrapper(header);
    expect(wrapper.props.style).toEqual({ paddingLeft: 47, paddingRight: 59 });
    expect(wrapper.props.className).toContain('px-4');
    const close = pressableByLabel(wrapper, 'Close photo.png');
    const share = pressableByLabel(wrapper, 'Share photo.png');
    expect(close?.parent).toBe(wrapper);
    expect(share?.parent).toBe(wrapper);

    renderer.unmount();
  });
});
