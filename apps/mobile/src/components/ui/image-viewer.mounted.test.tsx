import { type ComponentProps, createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ImageViewer } from './image-viewer';
import { AccessibleStatus } from '@/components/ui/accessible-status';

const safeArea = vi.hoisted(() => ({ top: 0, bottom: 0, left: 0, right: 0 }));

vi.mock('react-native', () => ({
  // Sheet registers the app-level Android Back listener while it is visible.
  BackHandler: { addEventListener: vi.fn(() => ({ remove: () => undefined })) },
  I18nManager: { isRTL: false, doLeftAndRightSwapInRTL: true },
  Platform: { OS: 'android' as const },
  // The real Sheet reads theme colours for its handle and backdrop.
  useColorScheme: () => 'light',
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/centered-state-surface', () => ({ StateSurface: 'StateSurface' }));
vi.mock('@/components/ui/icons', () => ({
  Share: 'Share',
  X: 'X',
  AlertCircle: 'AlertCircle',
  RotateCcw: 'RotateCcw',
}));
// The real action is a `Button`; a bare Pressable keeps the press observable
// without loading the button layer into this suite. `loading` rides through so
// a test can see the action's busy state.
vi.mock('@/components/empty-state', () => ({
  StateAction: (props: { label: string; onPress?: () => void; loading?: boolean }) =>
    createElement('Pressable', { ...props, accessibilityLabel: props.label }),
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

const REMOTE_URI = 'https://example.invalid/photo.png';

function findByType(
  root: TestRenderer.ReactTestInstance,
  type: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && (node.type as string) === type);
}

/** The one node an assertion needs; a missing node fails the test by name. */
function first(
  nodes: TestRenderer.ReactTestInstance[],
  what: string
): TestRenderer.ReactTestInstance {
  const node = nodes[0];
  if (!node) {
    throw new Error(`${what} missing`);
  }
  return node;
}

/**
 * The outer header container: it carries the viewer surface and the fixed
 * vertical geometry (`paddingTop`/`height`); the controls row lives in an inner
 * wrapper that carries only the landscape side insets. The canvas `View` also
 * paints `bg-black`, but inside a longer class list and without a `style`.
 */
function findHeaderContainer(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance {
  return root.find(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'View' &&
      node.props.className === 'bg-black' &&
      typeof node.props.style === 'object' &&
      node.props.style !== null &&
      'height' in node.props.style
  );
}

function pressableByLabel(
  node: TestRenderer.ReactTestInstance,
  label: string
): TestRenderer.ReactTestInstance | undefined {
  return findByType(node, 'Pressable').find(child => child.props.accessibilityLabel === label);
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

/** Runs one state change inside the renderer's async act, the suite's one flush. */
async function flush(action: () => void): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    action();
  });
}

async function mountViewer(
  props: Partial<ComponentProps<typeof ImageViewer>>
): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await flush(() => {
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

/** Fires the mounted `Image`'s decode outcome, the one event the viewer acts on. */
async function fireDecode(
  renderer: TestRenderer.ReactTestRenderer,
  handler: 'onError' | 'onLoad'
): Promise<void> {
  const image = first(findByType(renderer.root, 'Image'), 'viewer Image');
  await flush(image.props[handler] as () => void);
}

function retryActions(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance[] {
  return findByType(root, 'Pressable').filter(node => node.props.accessibilityLabel === 'Retry');
}

function unavailableText(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance[] {
  return findByType(root, 'Text').filter(node => node.props.children === 'Image unavailable');
}

/** The unavailable state's parts: the layer it covers the canvas from, its glyph
 *  and its disc. The layer is a sibling of the zoom surface, not a flex peer. */
function unavailableState(root: TestRenderer.ReactTestInstance) {
  const layer = findByType(root, 'CenteredState')[0]?.parent;
  const alert = findByType(root, 'AlertCircle')[0];
  const disc = findByType(root, 'View').find(
    node => typeof node.props.className === 'string' && node.props.className.includes('h-14 w-14')
  );
  if (!layer || !alert || !disc) {
    throw new Error('unavailable state missing');
  }
  return { layer, alert, disc };
}

describe('ImageViewer mounted', () => {
  beforeEach(() => {
    Object.assign(safeArea, { top: 0, bottom: 0, left: 0, right: 0 });
  });

  it('shows the Image unavailable state on a remote decode failure, retries it, and keeps Share enabled', async () => {
    const onShare = vi.fn<() => void>();
    const renderer = await mountViewer({ uri: REMOTE_URI, onShare });

    expect(findByType(renderer.root, 'Image')).toHaveLength(1);
    await fireDecode(renderer, 'onError');

    expect(findByType(renderer.root, 'Image')).toHaveLength(0);
    expect(findByType(renderer.root, 'StateSurface')).toHaveLength(1);

    // The state is a layer covering the canvas, so a retried image can mount
    // full size underneath it instead of splitting the canvas's flex line.
    const { layer, alert, disc } = unavailableState(renderer.root);
    expect(layer.props.className).toBe('absolute inset-0 bg-black');
    expect(layer.parent?.props.className).toContain('flex-1 items-center justify-center');

    // The glyph is the fixed light ink on the neutral disc, not theme ink.
    expect(alert.props.size).toBe(24);
    expect(alert.props.color).toBe('#FFFFFF');
    expect(disc.props.className).toContain('bg-neutral-800');

    // The copy announces through AccessibleStatus: one polite live region on
    // Android carrying the muted body ink, not the destructive error tone.
    const statuses = renderer.root.findAll(node => node.type === AccessibleStatus);
    expect(statuses).toHaveLength(1);
    const unavailableStatus = first(statuses, 'unavailable AccessibleStatus');
    expect(unavailableStatus.props.message).toBe('Image unavailable');
    const announced = findByType(unavailableStatus, 'Text');
    expect(announced).toHaveLength(1);
    expect(announced[0]?.props.accessibilityLiveRegion).toBe('polite');
    expect(announced[0]?.props.className).toContain('text-base');
    expect(announced[0]?.props.className).toContain('text-neutral-300');
    expect(announced[0]?.props.className).not.toContain('text-destructive');

    const share = pressableByLabel(renderer.root, 'Share photo.png');
    expect(share?.props.disabled).toBe(false);
    expect(share?.props.accessibilityState).toEqual({ disabled: false, busy: false });

    // Retry remounts the zoom surface for the same remote URI while the
    // unavailable state stays in place: the disc, the copy and the action do
    // not blank, and the action reports itself busy instead of vanishing.
    const retryButtons = retryActions(renderer.root);
    expect(retryButtons).toHaveLength(1);
    const retry = first(retryButtons, 'retry action');
    await flush(retry.props.onPress as () => void);

    // While the retry runs the image is mounted underneath and the state still
    // covers it from its own full-canvas layer, so nothing blanks or shifts.
    const remounted = findByType(renderer.root, 'Image');
    expect(remounted).toHaveLength(1);
    expect(remounted[0]?.props.source).toEqual({ uri: REMOTE_URI });
    expect(findByType(renderer.root, 'ResumableZoom')).toHaveLength(1);
    const retrying = unavailableState(renderer.root);
    expect(retrying.layer.props.className).toBe('absolute inset-0 bg-black');
    expect(retrying.disc.props.className).toContain('bg-neutral-800');
    expect(unavailableText(renderer.root)).toHaveLength(1);
    expect(renderer.root.findAll(node => node.type === AccessibleStatus)).toHaveLength(1);
    const busyActions = retryActions(renderer.root);
    expect(busyActions).toHaveLength(1);
    expect(busyActions[0]?.props.loading).toBe(true);

    // The retry lands: the decode clears the state and leaves only the image.
    await fireDecode(renderer, 'onLoad');
    expect(findByType(renderer.root, 'Image')).toHaveLength(1);
    expect(findByType(renderer.root, 'AlertCircle')).toHaveLength(0);
    expect(unavailableText(renderer.root)).toHaveLength(0);
    expect(retryActions(renderer.root)).toHaveLength(0);
    expect(renderer.root.findAll(node => node.type === AccessibleStatus)).toHaveLength(0);

    // A retry that fails again returns to the same action, no longer busy.
    await fireDecode(renderer, 'onError');
    expect(findByType(renderer.root, 'Image')).toHaveLength(0);
    expect(unavailableText(renderer.root)).toHaveLength(1);
    const failedActions = retryActions(renderer.root);
    expect(failedActions).toHaveLength(1);
    expect(failedActions[0]?.props.loading).toBe(false);

    renderer.unmount();
  });

  it('shows the unavailable row immediately on decode error and clears it in the same commit a renewed uri lands', async () => {
    const renderer = await mountViewer({});

    await fireDecode(renderer, 'onError');

    expect(findByType(renderer.root, 'Image')).toHaveLength(0);
    expect(unavailableText(renderer.root)).toHaveLength(1);

    await flush(() => {
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
    expect(unavailableText(renderer.root)).toHaveLength(0);

    renderer.unmount();
  });

  it('offers no retry for a local file uri, which would re-read the same bytes', async () => {
    const renderer = await mountViewer({ uri: 'file:///cache/photo.png' });

    await fireDecode(renderer, 'onError');

    expect(findByType(renderer.root, 'Image')).toHaveLength(0);
    expect(findByType(renderer.root, 'AlertCircle')).toHaveLength(1);
    expect(retryActions(renderer.root)).toHaveLength(0);

    renderer.unmount();
  });

  it('renders the share error through AccessibleStatus with white pill text', async () => {
    const renderer = await mountViewer({
      shareError: 'Failed to share file. Please try again.',
    });

    const statuses = renderer.root.findAll(node => node.type === AccessibleStatus);
    expect(statuses).toHaveLength(1);
    const status = first(statuses, 'AccessibleStatus');
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
    // The header band and the canvas are one surface, so the container paints
    // only the viewer black — no divider and no theme background.
    expect(header.props.className).toBe('bg-black');
    const wrapper = findRowWrapper(header);
    expect(wrapper.props.style).toBeUndefined();
    expect(wrapper.props.className).toContain('px-4');
    expect(wrapper.props.className).toContain('flex-row');
    expect(wrapper.props.className).toContain('justify-between');

    // Both chips are the fixed neutral step, and both glyphs the fixed light
    // ink, in either colour scheme.
    const close = pressableByLabel(wrapper, 'Close photo.png');
    const share = pressableByLabel(wrapper, 'Share photo.png');
    expect(close?.props.className).toContain('bg-neutral-800');
    expect(close?.props.className).not.toContain('bg-secondary');
    expect(share?.props.className).toContain('bg-neutral-800');
    expect(share?.props.className).not.toContain('bg-secondary');
    expect(findByType(wrapper, 'X')[0]?.props.color).toBe('#FFFFFF');
    expect(findByType(wrapper, 'Share')[0]?.props.color).toBe('#FFFFFF');

    renderer.unmount();
  });

  it('dismisses on a vertical swipe and ignores a horizontal one', async () => {
    const onClose = vi.fn<() => void>();
    const renderer = await mountViewer({ onClose });

    // The zoom surface runs `onSwipe` on the UI thread and hands the direction
    // back through `scheduleOnRN`, mocked to run inline.
    const zoomSurface = first(findByType(renderer.root, 'ResumableZoom'), 'zoom surface');
    const onSwipe = zoomSurface.props.onSwipe as (direction: string) => void;

    await flush(() => {
      onSwipe('left');
    });
    expect(onClose).not.toHaveBeenCalled();

    await flush(() => {
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
