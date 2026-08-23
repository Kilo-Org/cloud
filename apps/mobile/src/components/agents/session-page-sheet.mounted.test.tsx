/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx) */
import { createElement, type ReactElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
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

vi.mock('react-native', () => ({
  Modal: 'Modal',
  View: 'View',
  Platform: reactNativeMock.Platform,
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: safeAreaMock.useSafeAreaInsets,
}));
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

function modal(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance {
  const found = findByType(root, 'Modal');
  if (!found[0]) {
    throw new Error('Modal not found');
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
  it('renders the native pageSheet Modal on iOS and preserves onDismiss', async () => {
    const onClose = vi.fn<() => void>();
    const onDismiss = vi.fn<() => void>();
    const renderer = await mountSheet({ onClose, onDismiss });

    const modalNode = modal(renderer.root);
    expect(modalNode.props.animationType).toBe('slide');
    expect(modalNode.props.presentationStyle).toBe('pageSheet');
    expect(modalNode.props.transparent).toBeUndefined();
    expect(modalNode.props.onRequestClose).toBe(onClose);
    expect(modalNode.props.onDismiss).toBe(onDismiss);

    // No Android surface on iOS.
    expect(findByTestID(renderer.root, 'session-page-sheet-surface')).toHaveLength(0);

    renderer.unmount();
  });

  it('renders children inside the iOS surface View', async () => {
    const renderer = await mountSheet({
      children: createElement('SheetHeader', { title: 'Details' }),
    });

    expect(findByType(renderer.root, 'SheetHeader')).toHaveLength(1);

    renderer.unmount();
  });

  it('renders an opaque full-window Modal on Android', async () => {
    reactNativeMock.Platform.OS = 'android';
    const onClose = vi.fn<() => void>();
    const renderer = await mountSheet({ onClose });

    const modalNode = modal(renderer.root);
    expect(modalNode.props.transparent).toBeUndefined();
    expect(modalNode.props.animationType).toBe('slide');
    expect(modalNode.props.onRequestClose).toBe(onClose);

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

  it('closes when Android Back fires onRequestClose', async () => {
    reactNativeMock.Platform.OS = 'android';
    const onClose = vi.fn<() => void>();
    const renderer = await mountSheet({ onClose });

    await act(async () => {
      await Promise.resolve();
      press(modal(renderer.root), 'onRequestClose');
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
