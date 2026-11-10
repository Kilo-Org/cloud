// The account picker's sheet: it owns the themed surface, the row dividers,
// the current-account check, and the selected state a screen reader reads. The
// consumer contracts (selection, palette, missing membership) live in
// `context-control.mounted.test.tsx` and `profile-credits-card.mounted.test.tsx`.

import { createElement, type ElementType } from 'react';
import { act, type ReactTestInstance, type ReactTestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ContextPickerSheet } from '@/components/context-picker-sheet';
import { scrollTo } from '@/test/scroll-view-mock';
import { renderWithProviders } from '@/test/render-with-providers';

const theme = vi.hoisted(() => ({ colors: { primary: '#FFDD00', foreground: '#F2F0EB' } }));
const onSelect = vi.hoisted(() => vi.fn());
const onClose = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
  // `vi.mock` factories are hoisted above the file's static imports, so the
  // shared host-element mock is pulled in here too.
  const { MockScrollView } = await import('@/test/scroll-view-mock');
  return {
    Modal: 'Modal',
    Platform: { OS: 'ios' },
    Pressable: 'Pressable',
    ScrollView: MockScrollView,
    View: 'View',
    useWindowDimensions: () => ({ width: 400, height: 800 }),
  };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 24 }) }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({ Check: 'Check' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => theme.colors }));

const Pressable = 'Pressable' as ElementType;
const Check = 'Check' as ElementType;
const View = 'View' as ElementType;
const ScrollView = 'ScrollView' as ElementType;
const Text = 'Text' as ElementType;
const AXE = ['Personal', 'Acme Corp', 'Cancel'];
const mounted: { unmount: () => void }[] = [];

async function mount(
  props: Partial<{
    visible: boolean;
    currentIndex: number;
    title: string;
    options: string[];
  }> = {}
) {
  const options = props.options ?? AXE;
  const ui = await renderWithProviders(
    createElement(ContextPickerSheet, {
      visible: props.visible ?? true,
      title: props.title ?? 'Select account',
      options,
      cancelButtonIndex: options.length - 1,
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
  scrollTo.mockClear();
});

/** The account list: the one scrollable region inside the sheet. */
function list(renderer: ReactTestRenderer) {
  return renderer.root.find(node => node.type === ScrollView);
}

/** The checked row's one-time reveal: it is the only row carrying `onLayout`. */
function revealHandler(renderer: ReactTestRenderer) {
  const [revealing, ...others] = renderer.root
    .findAll(accountRow)
    .filter(node => node.props.onLayout !== undefined);
  expect(others).toHaveLength(0);
  if (revealing === undefined) {
    throw new Error('the checked account row must reveal itself');
  }
  expect(selectedState(revealing)).toBe(true);
  return revealing.props.onLayout as (event: unknown) => void;
}

describe('ContextPickerSheet', () => {
  it('renders nothing while it is closed', async () => {
    const renderer = await mount({ visible: false });

    expect(renderer.root.findAllByProps({ accessibilityRole: 'header' })).toHaveLength(0);
    expect(renderer.root.findAll(accountRow)).toHaveLength(0);
  });

  it('rules off the action row instead of the last account row', async () => {
    const renderer = await mount();

    expect(renderer.root.findByProps({ accessibilityRole: 'header' }).children).toContain(
      'Select account'
    );
    expect(rows(renderer)).toEqual([
      { label: 'Personal', selected: false, divider: true, check: false, gutter: true },
      { label: 'Acme Corp', selected: true, divider: false, check: true, gutter: true },
    ]);
    // Cancel is the ordinary button below them: no selected state, no check. A
    // full rule closes the list above it, so it reads as an action rather than
    // the next account, and the sheet's content stops at the safe area.
    const cancel = renderer.root.find(
      node => node.type === Pressable && node.props.accessibilityLabel === 'Cancel'
    );
    expect(cancel.props.accessibilityRole).toBe('button');
    expect(cancel.props.accessibilityState).toBeUndefined();
    expect(String(cancel.parent?.props.className)).toContain('border-t');
    expect(cancel.parent?.parent?.props.style).toEqual({ paddingBottom: 24 });
  });

  it('keeps the end of a label that does not fit its row', async () => {
    const renderer = await mount();

    // Sibling memberships share their leading words, so a row that cuts its
    // label cuts the middle: the tail is the only part naming the account.
    const labels = renderer.root.findAll(
      node => node.type === Text && node.props.numberOfLines === 1
    );
    expect(labels).toHaveLength(2);
    for (const label of labels) {
      expect(label.props.ellipsizeMode).toBe('middle');
    }
  });

  it('checks nothing when the stored account is not in the list', async () => {
    const renderer = await mount({ currentIndex: -1 });

    expect(rows(renderer).map(row => row.selected)).toEqual([false, false]);
    expect(rows(renderer).map(row => row.check)).toEqual([false, false]);
    // Nothing is checked, so nothing scrolls: the list opens at its first row.
    expect(renderer.root.findAll(node => node.props.onLayout !== undefined)).toHaveLength(0);
  });

  it('paints the check with the active palette', async () => {
    const renderer = await mount();

    const check = renderer.root.findAll(node => node.type === Check);
    expect(check).toHaveLength(1);
    expect(check[0]?.props.color).toBe(theme.colors.primary);
  });

  it('leaves the list at its top when the checked row fits inside the cap', async () => {
    const renderer = await mount();
    const layOut = revealHandler(renderer);

    // Mocked window height 800 caps the list at 400. The checked row ends at
    // 96, so it is already visible: scrolling it to the top would clip the row
    // above it — the personal account — out of the sheet.
    act(() => {
      layOut({ nativeEvent: { layout: { y: 48, height: 48 } } });
    });
    expect(scrollTo).not.toHaveBeenCalled();

    // The reveal is spent even when it changes nothing: a later layout pass
    // must not scroll a list the user has scrolled.
    act(() => {
      layOut({ nativeEvent: { layout: { y: 0, height: 48 } } });
    });
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('reveals a checked row below the cap, and never scrolls the list again', async () => {
    const renderer = await mount();
    const layOut = revealHandler(renderer);

    // 380 + 48 runs 28 past the 400 cap: the reveal stops at the row's bottom
    // edge instead of pinning it to the top, so the rows above keep their room.
    act(() => {
      layOut({ nativeEvent: { layout: { y: 380, height: 48 } } });
    });
    expect(scrollTo).toHaveBeenCalledWith({ y: 28, animated: false });

    // A later layout pass must not yank the list the user has scrolled.
    act(() => {
      layOut({ nativeEvent: { layout: { y: 0, height: 48 } } });
    });
    expect(scrollTo).toHaveBeenCalledTimes(1);
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

  it('keeps Cancel outside the scrolling list, so no account count can scroll it away', async () => {
    const renderer = await mount();

    const scroll = list(renderer);
    const cancel = renderer.root.find(
      node => node.type === Pressable && node.props.accessibilityLabel === 'Cancel'
    );
    expect(scroll.findAll(node => node === cancel)).toHaveLength(0);
    // Every account row is inside the list; the heading sits above it.
    expect(scroll.findAll(accountRow)).toHaveLength(AXE.length - 1);
  });

  it('keeps every membership selectable when the current account is at the end', async () => {
    const options = [
      'Personal',
      'شركة الخليج للبرمجيات',
      'منظمة أفق المفتوحة',
      'مبادرة النور',
      ...Array.from({ length: 8 }, (_, index) => `Workspace ${index + 1}`),
      'Cancel',
    ];
    const renderer = await mount({ options, currentIndex: options.length - 2 });
    const accounts = renderer.root.findAll(accountRow);

    expect(accounts.map(row => row.props.accessibilityLabel)).toEqual(options.slice(0, -1));
    expect(accounts.filter(row => selectedState(row) === true)).toHaveLength(1);
    await act(() => {
      for (const row of accounts) {
        (row.props.onPress as () => void)();
      }
      (renderer.root.findByProps({ accessibilityLabel: 'Cancel' }).props.onPress as () => void)();
    });
    expect(onSelect.mock.calls).toEqual(options.map((_, index) => [index]));
  });

  it('bounds the list to half the window and lets the sheet size to its content', async () => {
    const renderer = await mount();
    const style: unknown = list(renderer).props.style;
    if (typeof style !== 'object' || style === null || !('maxHeight' in style)) {
      throw new Error('the account list must carry its own height bound');
    }

    // A detent sheet hands its content the window height on Android, so the list
    // carries the bound that keeps the sheet sized to its content (mocked window
    // height 800).
    expect(style.maxHeight).toBe(400);
    expect(sheet(renderer).props.snapPoints).toBeUndefined();
  });
});
