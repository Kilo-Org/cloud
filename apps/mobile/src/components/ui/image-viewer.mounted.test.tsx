import { type ComponentProps, createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ImageViewer } from './image-viewer';
import { AccessibleStatus } from '@/components/ui/accessible-status';

const safeArea = vi.hoisted(() => ({ top: 0, bottom: 0, left: 0, right: 0 }));

vi.mock('react-native', () => ({
  Platform: { OS: 'android' as const },
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/centered-state-surface', () => ({ StateSurface: 'StateSurface' }));
vi.mock('@/components/ui/icons', () => ({
  Share: 'Share',
  X: 'X',
  AlertCircle: 'AlertCircle',
}));
vi.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: 'GestureHandlerRootView',
}));
vi.mock('react-native-zoom-toolkit', () => ({ ResumableZoom: 'ResumableZoom' }));
// `onSwipe` runs on the UI thread and hands the decision back through
// `scheduleOnRN`; run it inline so the test observes the real handler.
vi.mock('react-native-worklets', () => ({
  scheduleOnRN: (fn: (...args: unknown[]) => void, ...args: unknown[]) => {
    fn(...args);
  },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => safeArea,
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
  props: Partial<ComponentProps<typeof ImageViewer>>
): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(
      createElement(ImageViewer, {
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

describe('ImageViewer mounted', () => {
  beforeEach(() => {
    Object.assign(safeArea, { top: 0, bottom: 0, left: 0, right: 0 });
  });

  it('gives the close and share controls a 44pt minimum touch target', async () => {
    const renderer = await mountViewer({ onShare: () => undefined });

    // Both icon controls must meet the app's 44pt minimum, not the old 40pt
    // box. Native rem is 14pt, so `min-h-11` is only 38.5pt; the px form is
    // what button.tsx uses for its icon size (`h-[44px] w-[44px]`) and these
    // controls have no hitSlop to close the gap.
    const close = pressableByLabel(renderer.root, 'Close photo.png');
    const share = pressableByLabel(renderer.root, 'Share photo.png');
    expect(close?.props.className).toContain('min-h-[44px]');
    expect(close?.props.className).toContain('min-w-[44px]');
    expect(share?.props.className).toContain('min-h-[44px]');
    expect(share?.props.className).toContain('min-w-[44px]');

    renderer.unmount();
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
        createElement(ImageViewer, {
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

  it('presents as a full-window sheet, which the platform rotates with the app', async () => {
    const renderer = await mountViewer({ onShare: () => undefined });

    // e11 viewer-landscape: RN locked a full-screen modal on iPhone to portrait
    // unless the Modal listed the orientations it supports, so the photo clipped
    // at the screen bottom in a landscape window. A native sheet follows the
    // activity's orientation, so the viewer carries no orientation list and
    // owns the whole window with its own header.
    const sheet = findByType(renderer.root, 'BottomSheet')[0];
    if (!sheet) {
      throw new Error('sheet missing');
    }
    expect(sheet.props.snapPoints).toEqual(['100%']);
    expect(sheet.props.handleComponent).toBeNull();

    renderer.unmount();
  });

  it('fits the image inside the zoom surface below the header', async () => {
    const renderer = await mountViewer({ onShare: () => undefined });

    // The image fills the zoom surface and is contained — never cover-scaled
    // or clipped by the black area that starts below the header.
    const image = findByType(renderer.root, 'Image')[0];
    if (!image) {
      throw new Error('viewer Image missing');
    }
    expect(image.props.contentFit).toBe('contain');
    expect(image.props.className).toContain('h-full');
    expect(image.props.className).toContain('w-full');

    const zoomSurface = findByType(renderer.root, 'ResumableZoom')[0];
    const imageArea = zoomSurface?.parent;
    expect(imageArea?.props.className).toContain('flex-1');
    expect(imageArea?.props.className).toContain('overflow-hidden');

    renderer.unmount();
  });

  it('dismisses on a vertical swipe and ignores a horizontal one', async () => {
    const onClose = vi.fn<() => void>();
    const renderer = await mountViewer({ onClose });

    const zoomSurface = findByType(renderer.root, 'ResumableZoom')[0];
    if (!zoomSurface) {
      throw new Error('zoom surface missing');
    }
    const onSwipe = zoomSurface.props.onSwipe as (direction: string) => void;

    await act(async () => {
      await Promise.resolve();
      onSwipe('left');
    });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      await Promise.resolve();
      onSwipe('down');
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it('does not mount the zoom surface while closed', async () => {
    const renderer = await mountViewer({ visible: false });

    expect(findByType(renderer.root, 'ResumableZoom')).toHaveLength(0);

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
