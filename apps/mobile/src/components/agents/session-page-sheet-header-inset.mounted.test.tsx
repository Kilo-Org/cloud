import { createElement, type ReactElement } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

import { SessionPageSheet } from './session-page-sheet';
import { SheetHeader } from '@/components/sheet-header';

// Mutated between tests so one suite proves the pageSheet drop under the same
// window insets on both platforms.
const reactNativeMock = vi.hoisted(() => ({
  os: 'ios',
  statusHeight: 0,
}));
const safeAreaMock = vi.hoisted(() => ({
  insets: { top: 0, bottom: 0, left: 0, right: 0 },
}));

vi.mock('react-native', () => ({
  Modal: 'Modal',
  View: 'View',
  Pressable: 'Pressable',
  // `StatusBar.currentHeight` is Android-only; the header falls back to it when
  // the top inset is unresolved, so keep it 0 in the node harness.
  StatusBar: {
    get currentHeight() {
      return reactNativeMock.statusHeight;
    },
  },
  Platform: {
    get OS() {
      return reactNativeMock.os;
    },
  },
}));
// The real library reports the window insets unchanged inside the sheet Modal;
// the fix must not rewrite that context, only the header's own top clearance.
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => safeAreaMock.insets,
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({ Share: 'Share' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#111827', background: '#000000' }),
}));
vi.mock('@/components/centered-state-surface', () => ({ StateSurface: 'StateSurface' }));

/** Reports the window insets the sheet's subtree still sees, untouched. */
function WindowInsetsProbe(): ReactElement {
  const insets = useSafeAreaInsets();
  return createElement('WindowInsetsProbe', insets);
}

async function mountHeaderInSheet(): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  const element: ReactElement = createElement(SessionPageSheet, {
    visible: true,
    onClose: vi.fn<() => void>(),
    // eslint-disable-next-line react/no-children-prop -- tsgo requires `children` in the props object, not the third argument.
    children: [
      createElement(SheetHeader, {
        key: 'header',
        title: 'bash: Search projects and config for the mint secret',
        onDone: vi.fn<() => void>(),
        topInset: 'ios-page-sheet',
      }),
      createElement(WindowInsetsProbe, { key: 'probe' }),
    ],
  });
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(element);
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

/**
 * The header row sits in an inner wrapper that carries the top inset, so its
 * style is where the dead band would appear. Derive it from the row it wraps,
 * not from the className-less shell.
 */
function findSafeAreaWrapper(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance {
  const row = root.find(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'View' &&
      typeof node.props.className === 'string' &&
      node.props.className.includes('flex-row')
  );
  const wrapper = row.parent;
  if (!wrapper || typeof wrapper.type !== 'string') {
    throw new Error('safe-area wrapper not found');
  }
  return wrapper;
}

function findByType(
  root: TestRenderer.ReactTestInstance,
  type: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && (node.type as string) === type);
}

describe('SessionPageSheet header top inset', () => {
  beforeEach(() => {
    reactNativeMock.os = 'ios';
    reactNativeMock.statusHeight = 0;
    safeAreaMock.insets = { top: 0, bottom: 0, left: 0, right: 0 };
  });

  it('drops the window top inset on iOS so the title row sits under the grabber', async () => {
    safeAreaMock.insets = { top: 59, bottom: 34, left: 0, right: 0 };

    const renderer = await mountHeaderInSheet();
    // Without the opt-out the header reads the window's top inset and reserves
    // it, producing the ~59pt empty band above the title.
    expect(findSafeAreaWrapper(renderer.root).props.style).toBeUndefined();

    renderer.unmount();
  });

  it('drops the window top inset on Android too, where the surface pads it', async () => {
    reactNativeMock.os = 'android';
    safeAreaMock.insets = { top: 24, bottom: 34, left: 0, right: 0 };

    const renderer = await mountHeaderInSheet();
    // Android's Modal fills the window, so SessionPageSheet pads the top inset
    // on its own surface; the header must not reserve the window inset as well
    // or the clearance above the title would double.
    expect(findSafeAreaWrapper(renderer.root).props.style).toBeUndefined();

    renderer.unmount();
  });

  it('leaves the window insets untouched for the rest of the sheet subtree', async () => {
    // A nested full-screen Modal opened from sheet content keeps the window's
    // top inset: the fix must not rewrite the safe-area context.
    safeAreaMock.insets = { top: 59, bottom: 34, left: 0, right: 0 };

    const renderer = await mountHeaderInSheet();
    const probe = findByType(renderer.root, 'WindowInsetsProbe')[0];
    expect(probe?.props.top).toBe(59);
    expect(probe?.props.bottom).toBe(34);

    renderer.unmount();
  });
});
