// The account picker's sheet: it owns the themed surface, the row dividers,
// the current-account check, and the selected state a screen reader reads. The
// consumer contracts (selection, palette, missing membership) live in
// `context-control.mounted.test.tsx` and `profile-credits-card.mounted.test.tsx`.

import { createElement, type ElementType } from 'react';
import { act, type ReactTestInstance, type ReactTestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ContextPickerSheet } from '@/components/context-picker-sheet';
import { renderWithProviders } from '@/test/render-with-providers';

const theme = vi.hoisted(() => ({ colors: { primary: '#FFDD00', foreground: '#F2F0EB' } }));
const onSelect = vi.hoisted(() => vi.fn());
const onClose = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  Modal: 'Modal',
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 24 }) }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({ Check: 'Check' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => theme.colors }));

const Pressable = 'Pressable' as ElementType;
const Check = 'Check' as ElementType;
const View = 'View' as ElementType;
const AXE = ['Personal', 'Acme Corp', 'Cancel'];
const mounted: { unmount: () => void }[] = [];

async function mount(
  props: Partial<{
    visible: boolean;
    currentIndex: number;
    title: string;
  }> = {}
) {
  const ui = await renderWithProviders(
    createElement(ContextPickerSheet, {
      visible: props.visible ?? true,
      title: props.title ?? 'Select account',
      options: AXE,
      cancelButtonIndex: 2,
      currentIndex: props.currentIndex ?? 1,
      onSelect: index => {
        onSelect(index);
      },
      onClose: () => {
        onClose();
      },
    })
  );
  mounted.push(ui);
  return ui.renderer;
}

/** The selected state an account action button carries, if it carries one. */
function selectedState(node: ReactTestInstance): boolean | undefined {
  const state: unknown = node.props.accessibilityState;
  if (typeof state !== 'object' || state === null || !('selected' in state)) {
    return undefined;
  }
  return typeof state.selected === 'boolean' ? state.selected : undefined;
}

/** An account action button: the sheet marks every row's selection. */
function accountRow(node: ReactTestInstance) {
  return (
    node.type === Pressable &&
    node.props.accessibilityRole === 'button' &&
    selectedState(node) !== undefined
  );
}

function rows(renderer: ReactTestRenderer) {
  return renderer.root.findAll(accountRow).map(node => ({
    label: node.props.accessibilityLabel as string,
    selected: selectedState(node) === true,
    divider:
      typeof node.props.className === 'string' && node.props.className.includes('border-hair-soft'),
    check: node.findAll(child => child.type === Check).length > 0,
    // Every account row reserves one blank gutter View so the labels line up.
    gutter: node.findAll(child => child.type === View).length === 1,
  }));
}

/** The native sheet wrapper; its `onClose` is the dismiss path the sheet owns. */
function sheet(renderer: ReactTestRenderer) {
  return renderer.root.find(node => (node.type as string) === 'BottomSheet');
}

function press(node: ReactTestInstance) {
  return act(() => {
    (node.props.onPress as () => void)();
  });
}

beforeEach(() => {
  for (const ui of mounted.splice(0)) {
    ui.unmount();
  }
  onSelect.mockReset();
  onClose.mockReset();
});

describe('ContextPickerSheet', () => {
  it('renders nothing while it is closed', async () => {
    const renderer = await mount({ visible: false });

    expect(renderer.root.findAllByProps({ accessibilityRole: 'header' })).toHaveLength(0);
    expect(renderer.root.findAll(accountRow)).toHaveLength(0);
  });

  it('draws a divider on every account row and the check on the current one', async () => {
    const renderer = await mount();

    expect(renderer.root.findByProps({ accessibilityRole: 'header' }).children).toContain(
      'Select account'
    );
    expect(rows(renderer)).toEqual([
      { label: 'Personal', selected: false, divider: true, check: false, gutter: true },
      { label: 'Acme Corp', selected: true, divider: true, check: true, gutter: true },
    ]);
    // Cancel is the ordinary button below them: no selected state, no check.
    const cancel = renderer.root.find(
      node => node.type === Pressable && node.props.accessibilityLabel === 'Cancel'
    );
    expect(cancel.props.accessibilityRole).toBe('button');
    expect(cancel.props.accessibilityState).toBeUndefined();
  });

  it('checks nothing when the stored account is not in the list', async () => {
    const renderer = await mount({ currentIndex: -1 });

    expect(rows(renderer).map(row => row.selected)).toEqual([false, false]);
    expect(rows(renderer).map(row => row.check)).toEqual([false, false]);
  });

  it('paints the check with the active palette', async () => {
    const renderer = await mount();

    const check = renderer.root.findAll(node => node.type === Check);
    expect(check).toHaveLength(1);
    expect(check[0]?.props.color).toBe(theme.colors.primary);
  });

  it('reports the pressed row by index and dismisses through the sheet', async () => {
    const renderer = await mount();

    await press(renderer.root.findByProps({ accessibilityLabel: AXE[1] }));
    await press(renderer.root.findByProps({ accessibilityLabel: 'Cancel' }));
    expect(onSelect.mock.calls).toEqual([[1], [2]]);
    expect(onClose).not.toHaveBeenCalled();

    // The native sheet owns the backdrop and the swipe; both route through the
    // sheet's `onClose`.
    await act(() => {
      (sheet(renderer).props.onClose as () => void)();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
