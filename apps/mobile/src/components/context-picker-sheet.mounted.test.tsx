// The account picker's route body: the account rows, the current-account check,
// and the one-time reveal of a checked row that opens below the fold. The pick
// and the dismissal paths live in `context-picker.back.mounted.test.tsx`, and
// the consumer contracts (selection, palette, missing membership) in
// `context-control.mounted.test.tsx`.

import { createElement, type ElementType } from 'react';
import type * as ReactI18next from 'react-i18next';
import { act, type ReactTestInstance, type ReactTestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ContextPickerSheet } from '@/components/context-picker-sheet';
import { scrollTo } from '@/test/scroll-view-mock';
import { renderWithProviders } from '@/test/render-with-providers';

const theme = vi.hoisted(() => ({ colors: { primary: '#FFDD00', foreground: '#F2F0EB' } }));
const onSelect = vi.hoisted(() => vi.fn());
const onDone = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
  // `vi.mock` factories are hoisted above the file's static imports, so the
  // shared host-element mock is pulled in here too.
  const { MockScrollView } = await import('@/test/scroll-view-mock');
  return {
    BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
    Platform: { OS: 'android' },
    Pressable: 'Pressable',
    ScrollView: MockScrollView,
    View: 'View',
  };
});
vi.mock('expo-router', () => ({ useRouter: () => ({ back: vi.fn() }) }));
vi.mock('react-i18next', async importOriginal => {
  const original = await importOriginal<typeof ReactI18next>();
  return { ...original, useTranslation: () => ({ t: (key: string) => key }) };
});
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({ Check: 'Check', Info: 'Icon' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => theme.colors }));
vi.mock('@/lib/navigation/route-focus', () => ({ useRouteFocused: () => true }));

const Pressable = 'Pressable' as ElementType;
const Check = 'Check' as ElementType;
const View = 'View' as ElementType;
const ScrollView = 'ScrollView' as ElementType;
const Text = 'Text' as ElementType;
const AXE = ['Personal', 'Acme Corp'];
const mounted: { unmount: () => void }[] = [];

async function mount(
  props: Partial<{ currentIndex: number; title: string; options: string[]; expired: boolean }> = {}
) {
  const ui = await renderWithProviders(
    createElement(ContextPickerSheet, {
      title: props.title ?? 'Select account',
      options: props.options ?? AXE,
      currentIndex: props.currentIndex ?? 1,
      onSelect: index => {
        onSelect(index);
      },
      onDone: () => {
        onDone();
      },
      expired: props.expired ?? false,
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

function press(node: ReactTestInstance) {
  return act(() => {
    (node.props.onPress as () => void)();
  });
}

/** The account list: the one scrollable region inside the sheet. */
function list(renderer: ReactTestRenderer) {
  return renderer.root.find(node => node.type === ScrollView);
}

/** The list's own viewport report; the reveal measures the fold from it. */
function layOutViewport(renderer: ReactTestRenderer, height: number) {
  act(() => {
    (list(renderer).props.onLayout as (event: unknown) => void)({
      nativeEvent: { layout: { height } },
    });
  });
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
  return (event: unknown) => {
    act(() => {
      (revealing.props.onLayout as (event: unknown) => void)(event);
    });
  };
}

beforeEach(() => {
  for (const ui of mounted.splice(0)) {
    ui.unmount();
  }
  onSelect.mockReset();
  onDone.mockReset();
  scrollTo.mockClear();
});

describe('ContextPickerSheet', () => {
  it('rules off every account row but the last', async () => {
    const renderer = await mount();

    expect(renderer.root.findByType('SheetHeader' as ElementType).props.title).toBe(
      'Select account'
    );
    expect(rows(renderer)).toEqual([
      { label: 'Personal', selected: false, divider: true, check: false, gutter: true },
      { label: 'Acme Corp', selected: true, divider: false, check: true, gutter: true },
    ]);
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
    // Nothing is checked, so nothing scrolls: no account row carries the
    // reveal handler (the list reports its own viewport regardless).
    expect(
      renderer.root.findAll(accountRow).filter(node => node.props.onLayout !== undefined)
    ).toHaveLength(0);
  });

  it('paints the check with the active palette', async () => {
    const renderer = await mount();

    const check = renderer.root.findAll(node => node.type === Check);
    expect(check).toHaveLength(1);
    expect(check[0]?.props.color).toBe(theme.colors.primary);
  });

  it('leaves the list at its top when the checked row fits inside the fold', async () => {
    const renderer = await mount();
    const layOut = revealHandler(renderer);
    layOutViewport(renderer, 400);

    // The checked row ends at 96, inside the 400 viewport: scrolling it to the
    // top would clip the row above it — the personal account — out of the sheet.
    layOut({ nativeEvent: { layout: { y: 48, height: 48 } } });
    expect(scrollTo).not.toHaveBeenCalled();

    // The reveal is spent even when it changes nothing: a later layout pass
    // must not scroll a list the user has scrolled.
    layOut({ nativeEvent: { layout: { y: 0, height: 48 } } });
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('reveals a checked row below the fold once the viewport is measured', async () => {
    const renderer = await mount();
    const layOut = revealHandler(renderer);

    // The row is measured before the list reports its own height, so the reveal
    // waits for the viewport instead of guessing one.
    layOut({ nativeEvent: { layout: { y: 380, height: 48 } } });
    expect(scrollTo).not.toHaveBeenCalled();

    // 380 + 48 runs 28 past the 400 viewport: the reveal stops at the row's
    // bottom edge instead of pinning it to the top, so the rows above keep
    // their room.
    layOutViewport(renderer, 400);
    expect(scrollTo).toHaveBeenCalledWith({ y: 28, animated: false });

    // A later layout pass must not yank the list the user has scrolled.
    layOut({ nativeEvent: { layout: { y: 0, height: 48 } } });
    layOutViewport(renderer, 300);
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it('reports the pressed row by index', async () => {
    const renderer = await mount();

    await press(renderer.root.findByProps({ accessibilityLabel: AXE[1] }));
    expect(onSelect.mock.calls).toEqual([[1]]);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('keeps every membership selectable when the current account is at the end', async () => {
    const options = [
      'Personal',
      'شركة الخليج للبرمجيات',
      'منظمة أفق المفتوحة',
      'مبادرة النور',
      ...Array.from({ length: 8 }, (_, index) => `Workspace ${index + 1}`),
    ];
    const renderer = await mount({ options, currentIndex: options.length - 1 });
    const accounts = renderer.root.findAll(accountRow);

    expect(accounts.map(row => row.props.accessibilityLabel)).toEqual(options);
    expect(accounts.filter(row => selectedState(row) === true)).toHaveLength(1);
    act(() => {
      for (const row of accounts) {
        (row.props.onPress as () => void)();
      }
    });
    expect(onSelect.mock.calls).toEqual(options.map((_, index) => [index]));
  });

  it('shows the expired shell instead of rows when the caller has no bridge', async () => {
    const renderer = await mount({ expired: true });

    expect(renderer.root.findAll(accountRow)).toHaveLength(0);
    expect(renderer.root.findAll(node => node.type === ('EmptyState' as ElementType))).toHaveLength(
      1
    );
  });
});