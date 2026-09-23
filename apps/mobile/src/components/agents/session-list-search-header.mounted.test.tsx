import { createRef, type ElementType, type ReactElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { compiledDimensions, compiledLengthDp } from '@/test/native-dimensions';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type TextInput } from 'react-native';

import '@/i18n';
import { MIN_TAP_TARGET_DP, TOUCH_TARGET_DP } from '@/lib/a11y/tap-target';
import { SessionListSearchHeader } from './session-list-search-header';

const state = vi.hoisted(() => ({
  insets: { top: 59, right: 0, bottom: 34, left: 0 },
}));
const i18nManager = vi.hoisted(() => ({ isRTL: false }));

vi.mock('react-native', () => ({
  I18nManager: i18nManager,
  Pressable: 'Pressable',
  TextInput: 'TextInput',
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => state.insets,
}));
vi.mock('@/components/ui/icons', () => ({ Search: 'Search', X: 'X' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#000000', foreground: '#111111' }),
}));

const baseProps = {
  inputRef: createRef<TextInput | null>(),
  hasText: false,
  showSearchBusy: false,
  onChangeText: () => undefined,
  onClearSearch: () => undefined,
};

const renderers: TestRenderer.ReactTestRenderer[] = [];

async function mount(element: ReactElement) {
  await act(() => {
    renderers.push(TestRenderer.create(element));
  });
  const renderer = renderers.at(-1);
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function fieldRow(renderer: TestRenderer.ReactTestRenderer) {
  const row = renderer.root
    .findAll(
      node =>
        node.type === ('View' as ElementType) &&
        typeof node.props.className === 'string' &&
        node.props.className.includes('rounded-[10px]')
    )
    .at(0);
  if (!row) {
    throw new Error('search field row was not found');
  }
  return row;
}

function searchInput(renderer: TestRenderer.ReactTestRenderer) {
  const input = renderer.root.findAll(node => node.type === ('TextInput' as ElementType)).at(0);
  if (!input) {
    throw new Error('search input was not found');
  }
  return input;
}

describe('SessionListSearchHeader landscape sensor insets', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(() => {
    act(() => {
      for (const renderer of renderers.splice(0)) {
        renderer.unmount();
      }
    });
  });

  it('keeps the fixed 22px margins in portrait where the side insets are 0', async () => {
    state.insets = { top: 59, right: 0, bottom: 34, left: 0 };
    const renderer = await mount(<SessionListSearchHeader {...baseProps} />);
    expect(fieldRow(renderer).props.style).toEqual({ marginLeft: 22, marginRight: 22 });
  });

  it('gains the landscape sensor insets on both sides so the field clears the housing', async () => {
    state.insets = { top: 59, right: 59, bottom: 34, left: 47 };
    const renderer = await mount(<SessionListSearchHeader {...baseProps} />);
    expect(fieldRow(renderer).props.style).toEqual({ marginLeft: 69, marginRight: 81 });
  });

  it('updates the margins on rotation without a remount', async () => {
    state.insets = { top: 59, right: 0, bottom: 34, left: 0 };
    const renderer = await mount(<SessionListSearchHeader {...baseProps} />);
    expect(fieldRow(renderer).props.style).toEqual({ marginLeft: 22, marginRight: 22 });
    state.insets = { top: 59, right: 59, bottom: 34, left: 47 };
    await act(() => {
      renderer.update(<SessionListSearchHeader {...baseProps} />);
    });
    expect(fieldRow(renderer).props.style).toEqual({ marginLeft: 69, marginRight: 81 });
  });

  it('sizes the single-line input with min-height, never vertical padding', async () => {
    const renderer = await mount(<SessionListSearchHeader {...baseProps} />);
    const classes = searchInput(renderer).props.className as string;
    expect(classes).toContain('min-h-');
    expect(classes).not.toMatch(/(?:^|\s)py-/);
  });

  it('keeps the placeholder on one line at any width', async () => {
    // A narrow window with a large font scale made the placeholder wrap inside
    // the field and the field grow with it (e1-list-bottom.png).
    const renderer = await mount(<SessionListSearchHeader {...baseProps} />);
    expect(searchInput(renderer).props.numberOfLines).toBe(1);
  });
});

describe('SessionListSearchHeader typed query alignment', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    i18nManager.isRTL = false;
  });
  afterEach(() => {
    act(() => {
      for (const renderer of renderers.splice(0)) {
        renderer.unmount();
      }
    });
  });

  it('passes no alignment style in LTR so English is unchanged', async () => {
    i18nManager.isRTL = false;
    const renderer = await mount(<SessionListSearchHeader {...baseProps} />);
    expect(searchInput(renderer).props.style).toBeUndefined();
  });

  it('aligns the typed query to the field start edge in RTL', async () => {
    i18nManager.isRTL = true;
    const renderer = await mount(<SessionListSearchHeader {...baseProps} />);
    // The shared box applies the RTL content alignment in front of the
    // caller's own style (this field passes none), so the field's query follows
    // the interface direction.
    expect(searchInput(renderer).props.style).toEqual([{ textAlign: 'right' }, undefined]);
  });
});

describe('SessionListSearchHeader clear control', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    i18nManager.isRTL = false;
  });
  afterEach(() => {
    act(() => {
      for (const renderer of renderers.splice(0)) {
        renderer.unmount();
      }
    });
  });

  // The on-device accessibility explorer measures a control's laid-out bounds and
  // `hitSlop` never widens them: the clear X with no box of its own reads as its
  // 16pt glyph and is reported too small to tap. Pin the compiled box.
  async function mountWithClear() {
    const renderer = await mount(<SessionListSearchHeader {...baseProps} hasText />);
    const clear = renderer.root.find(
      node =>
        node.type === ('Pressable' as ElementType) &&
        node.props.accessibilityLabel === 'Clear search'
    );
    const declarations = (await compiledDimensions(clear.props.className as string)) as {
      height?: number;
      width?: number;
    }[];
    return {
      renderer,
      box: Object.assign({}, ...declarations) as { height: number; width: number },
      slop: clear.props.hitSlop as { top: number; right: number; bottom: number; left: number },
      rowClassName: fieldRow(renderer).props.className as string,
    };
  }

  it('lays out a box at least 28dp on a side', async () => {
    const { box } = await mountWithClear();
    expect(box.height).toBeGreaterThanOrEqual(MIN_TAP_TARGET_DP);
    expect(box.width).toBeGreaterThanOrEqual(MIN_TAP_TARGET_DP);
  });

  it('carries the reach past the 44pt minimum target, not onto it', async () => {
    const { box, slop } = await mountWithClear();
    expect(box.height + slop.top + slop.bottom).toBeGreaterThan(TOUCH_TARGET_DP);
    expect(box.width + slop.left + slop.right).toBeGreaterThan(TOUCH_TARGET_DP);
  });

  it('stops the clear control left of the row gap, so it cannot cover the input', async () => {
    const { slop, rowClassName } = await mountWithClear();
    // The row's `gap-2` compiles to 7pt at the app's 14pt rem; the control's
    // left slop meets the input at that gap instead of reaching into it.
    expect(await compiledLengthDp(rowClassName, 'gap')).toBe(7);
    expect(slop.left).toBeLessThanOrEqual(7);
  });

  it('reserves the box height on the field, so typing cannot shift the list', async () => {
    const { renderer, box } = await mountWithClear();
    const rowClassName = fieldRow(renderer).props.className as string;
    const declarations = (await compiledDimensions(rowClassName)) as { minHeight?: number }[];
    const field = Object.assign({}, ...declarations) as { minHeight?: number };

    // The row's `py-1.5` compiles to a 5.25pt `paddingBlock` per side at the
    // app's 14pt rem — 10.5pt, not the 12pt a 16pt rem would give — and its
    // `border` adds 1pt per side, 2pt vertically. React Native lays the row out
    // as a border box, so the field's floor must already hold the control's box
    // plus both. Read the padding and the border from the compiled row rather
    // than a hand-written rem figure.
    const rowVerticalPaddingDp = 2 * (await compiledLengthDp(rowClassName, 'paddingBlock'));
    const rowVerticalBorderDp = 2 * (await compiledLengthDp(rowClassName, 'borderWidth'));
    expect(rowVerticalPaddingDp).toBe(10.5);
    expect(rowVerticalBorderDp).toBe(2);
    expect(field.minHeight).toBeGreaterThanOrEqual(
      box.height + rowVerticalPaddingDp + rowVerticalBorderDp
    );
  });

  it('takes the row height from the shared field floor, not the row floor', async () => {
    const renderer = await mount(<SessionListSearchHeader {...baseProps} hasText />);
    const rowClassName = fieldRow(renderer).props.className as string;
    const rowDeclarations = (await compiledDimensions(rowClassName)) as { minHeight?: number }[];
    const row = Object.assign({}, ...rowDeclarations) as { minHeight?: number };
    const inputDeclarations = (await compiledDimensions(
      searchInput(renderer).props.className as string
    )) as { minHeight?: number }[];
    const input = Object.assign({}, ...inputDeclarations) as { minHeight?: number };

    const rowVerticalPaddingDp = 2 * (await compiledLengthDp(rowClassName, 'paddingBlock'));
    const rowVerticalBorderDp = 2 * (await compiledLengthDp(rowClassName, 'borderWidth'));

    // The shared field's 44pt floor is taller than the 38pt clear control, so
    // the field's floor lays the row out: 44 + 10.5 + 2 = 56.5pt. The row's own
    // `min-h-[51px]` is a lower bound the field dominates, not the height the
    // row takes.
    const fieldFloorDp = input.minHeight ?? 0;
    expect(fieldFloorDp).toBe(44);
    const laidOutHeightDp = fieldFloorDp + rowVerticalPaddingDp + rowVerticalBorderDp;
    expect(laidOutHeightDp).toBe(56.5);
    expect(row.minHeight).toBeLessThan(laidOutHeightDp);
  });
});
