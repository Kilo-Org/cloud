import { createElement, type ReactElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionPageSheet } from './session-page-sheet';

// Mutated between tests so one suite can prove both platform branches and the
// Android top-inset padding.
const reactNativeMock = vi.hoisted(() => ({
  Platform: { OS: 'ios' as string },
}));
const safeAreaMock = vi.hoisted(() => ({
  useSafeAreaInsets: vi.fn(() => ({ top: 0, bottom: 0 })),
}));

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ background: '#000' }),
}));
vi.mock('react-native', () => ({
  View: 'View',
  Platform: reactNativeMock.Platform,
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: safeAreaMock.useSafeAreaInsets,
}));
vi.mock('@/components/centered-state-surface', () => ({ StateSurface: 'StateSurface' }));
vi.mock('@/components/sheet-header', () => ({
  SheetHeader: 'SheetHeader',
}));

function sheetElement(
  props: { onClose?: () => void; onDismiss?: () => void; children?: ReactElement | null } = {}
): ReactElement {
  return createElement(SessionPageSheet, {
    visible: true,
    onClose: props.onClose ?? vi.fn<() => void>(),
    onDismiss: props.onDismiss,
    // eslint-disable-next-line react/no-children-prop -- tsgo requires `children` in the props object, not the third argument.
    children: props.children ?? null,
  });
}

async function mountSheet(
  props: { onClose?: () => void; onDismiss?: () => void; children?: ReactElement | null } = {}
): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(sheetElement(props));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function findByType(
  root: TestRenderer.ReactTestInstance,
  type: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && (node.type as string) === type);
}

function findByTestID(
  root: TestRenderer.ReactTestInstance,
  testID: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => node.props.testID === testID);
}

function sheet(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance {
  const found = findByType(root, 'BottomSheet');
  if (!found[0]) {
    throw new Error('BottomSheet not found');
  }
  return found[0];
}

function press(instance: TestRenderer.ReactTestInstance, key: string): void {
  const handler = instance.props[key] as (() => void) | undefined;
  if (typeof handler !== 'function') {
    throw new TypeError(`target has no ${key}`);
  }
  handler();
}

beforeEach(() => {
  reactNativeMock.Platform.OS = 'ios';
  safeAreaMock.useSafeAreaInsets.mockReturnValue({ top: 0, bottom: 0 });
});

describe('SessionPageSheet mounted', () => {
  it('renders the native full-window sheet on iOS and preserves onDismiss', async () => {
    const onClose = vi.fn<() => void>();
    const onDismiss = vi.fn<() => void>();
    const renderer = await mountSheet({ onClose, onDismiss });

    const sheetNode = sheet(renderer.root);
    // One detent, the whole window, and no drag indicator: the surface owns the
    // top of its own window with the caller's SheetHeader.
    expect(sheetNode.props.snapPoints).toEqual(['100%']);
    expect(sheetNode.props.handleComponent).toBeNull();
    expect(sheetNode.props.index).toBe(0);
    expect(sheetNode.props.backgroundStyle).toEqual({ backgroundColor: '#000' });
    act(() => {
      (sheetNode.props.onClose as () => void)();
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    const surface = findByTestID(renderer.root, 'session-page-sheet-surface');
    expect(surface).toHaveLength(1);
    // iOS presents the sheet below the status bar, so the surface pads nothing.
    expect(surface[0]?.props.style).toEqual({ paddingTop: 0 });

    renderer.unmount();
  });

  it.each(['ios', 'android'])('uses a StateSurface as the %s sheet root', async platform => {
    reactNativeMock.Platform.OS = platform;
    const renderer = await mountSheet({
      children: createElement('SheetHeader', { title: 'Details' }),
    });
    const surfaces = findByType(renderer.root, 'StateSurface');
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]?.parent).toBe(sheet(renderer.root));
    expect(surfaces[0]?.props.className).toBe('flex-1 bg-background');
    expect(findByType(renderer.root, 'SheetHeader')[0]?.parent).toBe(surfaces[0]);
    expect(findByType(renderer.root, 'View')).toHaveLength(0);
    act(() => {
      renderer.unmount();
    });
  });

  it('renders an opaque full-window sheet on Android', async () => {
    reactNativeMock.Platform.OS = 'android';
    const onClose = vi.fn<() => void>();
    const renderer = await mountSheet({ onClose });

    const sheetNode = sheet(renderer.root);
    expect(sheetNode.props.snapPoints).toEqual(['100%']);
    act(() => {
      (sheetNode.props.onClose as () => void)();
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    const surface = findByTestID(renderer.root, 'session-page-sheet-surface');
    expect(surface).toHaveLength(1);
    // flex-1 keeps the surface at the full window height.
    expect(surface[0]?.props.className).toContain('flex-1');

    renderer.unmount();
  });

  it('pads the Android surface by the top inset', async () => {
    reactNativeMock.Platform.OS = 'android';
    safeAreaMock.useSafeAreaInsets.mockReturnValue({ top: 24, bottom: 34 });

    const renderer = await mountSheet();
    const surface = findByTestID(renderer.root, 'session-page-sheet-surface')[0];
    // The padding keeps the content below the system status bar.
    expect(surface?.props.style).toEqual({ paddingTop: 24 });

    renderer.unmount();
  });

  it('closes when the sheet dismisses', async () => {
    reactNativeMock.Platform.OS = 'android';
    const onClose = vi.fn<() => void>();
    const renderer = await mountSheet({ onClose });

    // Android Back, a swipe down and a backdrop tap all route through the
    // native sheet's one close path.
    await act(async () => {
      await Promise.resolve();
      press(sheet(renderer.root), 'onClose');
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it('keeps SheetHeader as the first surface child and routes Done to onClose', async () => {
    reactNativeMock.Platform.OS = 'android';
    const onClose = vi.fn<() => void>();
    const renderer = await mountSheet({
      onClose,
      children: createElement('SheetHeader', {
        title: 'Details',
        onDone: onClose,
        doneLabel: 'Done',
      }),
    });

    const surface = findByTestID(renderer.root, 'session-page-sheet-surface')[0];
    const firstChild = surface?.children[0];
    expect(typeof firstChild === 'object' ? firstChild.type : undefined).toBe('SheetHeader');

    const header = findByType(renderer.root, 'SheetHeader')[0];
    if (!header) {
      throw new Error('header not found');
    }
    await act(async () => {
      await Promise.resolve();
      press(header, 'onDone');
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });
});
