import { createRef, type ElementType, type ReactElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { compiledLengthDp } from '@/test/native-dimensions';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type TextInput } from 'react-native';

import '@/i18n';
import { FIELD_CLEAR_BOX_CLASS, MIN_TAP_TARGET_DP, TOUCH_TARGET_DP } from '@/lib/a11y/tap-target';
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
        node.props.className.includes('rounded-md')
    )
    .at(0);
  if (!row) {
    throw new Error('search field row was not found');
  }
  return row;
}

/** The un-bordered frame that owns the page gutter and the sensor insets. */
function fieldGutter(renderer: TestRenderer.ReactTestRenderer) {
  const gutter = renderer.root
    .findAll(
      node =>
        node.type === ('View' as ElementType) &&
        typeof node.props.className === 'string' &&
        node.props.className.split(' ').includes('px-4')
    )
    .at(0);
  if (!gutter) {
    throw new Error('search field gutter was not found');
  }
  return gutter;
}

function searchInput(renderer: TestRenderer.ReactTestRenderer) {
  const input = renderer.root.findAll(node => node.type === ('TextInput' as ElementType)).at(0);
  if (!input) {
    throw new Error('search input was not found');
  }
  return input;
}

/**
 * The style RN flattens an input's array to, so a test asserts the property it
 * is about rather than the box's whole enforced style.
 */
function flattenedStyle(style: unknown): Record<string, unknown> {
  return Object.assign({}, ...([style] as Record<string, unknown>[]).flat());
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

  it('keeps the page gutter in portrait where the side insets are 0', async () => {
    state.insets = { top: 59, right: 0, bottom: 34, left: 0 };
    const renderer = await mount(<SessionListSearchHeader {...baseProps} />);
    expect(String(fieldGutter(renderer).props.className).split(' ')).toContain('px-4');
    expect(fieldGutter(renderer).props.style).toBeUndefined();
    // The bordered field keeps its own inset, outside the page gutter.
    expect(String(fieldRow(renderer).props.className).split(' ')).toContain('px-2');
    expect(String(fieldRow(renderer).props.className).split(' ')).not.toContain('px-4');
  });

  it('gains the landscape sensor insets on both sides so the field clears the housing', async () => {
    state.insets = { top: 59, right: 59, bottom: 34, left: 47 };
    const renderer = await mount(<SessionListSearchHeader {...baseProps} />);
    expect(fieldGutter(renderer).props.style).toEqual({ paddingLeft: 47, paddingRight: 59 });
    expect(fieldRow(renderer).props.style).toBeUndefined();
  });

  it('updates the insets on rotation without a remount', async () => {
    state.insets = { top: 59, right: 0, bottom: 34, left: 0 };
    const renderer = await mount(<SessionListSearchHeader {...baseProps} />);
    expect(fieldGutter(renderer).props.style).toBeUndefined();
    state.insets = { top: 59, right: 59, bottom: 34, left: 47 };
    await act(() => {
      renderer.update(<SessionListSearchHeader {...baseProps} />);
    });
    expect(fieldGutter(renderer).props.style).toEqual({ paddingLeft: 47, paddingRight: 59 });
  });

  it('asks the IME for no full-screen editor so the screen keeps the keyboard', async () => {
    // e9-land-ime-up.png: with little room left in a landscape window the IME
    // swapped the app for its own full-screen editor — the capture shows the
    // query, a SEARCH action button and the keyboard where the screen's own
    // no-match body belongs. `disableFullscreenUI` maps to
    // `EditorInfo.IME_FLAG_NO_FULLSCREEN` in ReactEditText.updateImeOptions,
    // the flag the IME's fullscreen decision reads.
    const renderer = await mount(<SessionListSearchHeader {...baseProps} />);
    expect(searchInput(renderer).props.disableFullscreenUI).toBe(true);
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
    expect(flattenedStyle(searchInput(renderer).props.style).textAlign).toBeUndefined();
  });

  it('aligns the typed query to the field start edge in RTL', async () => {
    i18nManager.isRTL = true;
    const renderer = await mount(<SessionListSearchHeader {...baseProps} />);
    // The shared box applies the RTL content alignment in front of the
    // caller's own style (this field passes none), so the field's query follows
    // the interface direction.
    expect(flattenedStyle(searchInput(renderer).props.style).textAlign).toBe('right');
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
    const className = clear.props.className as string;
    const box = {
      height: await compiledLengthDp(className, 'height'),
      width: await compiledLengthDp(className, 'width'),
    };
    return {
      renderer,
      box,
      className,
      rowClassName: fieldRow(renderer).props.className as string,
    };
  }

  it('lays out the shared clear box on the control itself', async () => {
    const { box, className } = await mountWithClear();
    expect(className).toContain(FIELD_CLEAR_BOX_CLASS);
    expect(box.height).toBeGreaterThanOrEqual(MIN_TAP_TARGET_DP);
    expect(box.width).toBeGreaterThanOrEqual(MIN_TAP_TARGET_DP);
    // The box alone now clears the design target, so the frame carries no reach
    // toward the field beside it.
    expect(box.height).toBeGreaterThanOrEqual(TOUCH_TARGET_DP);
    expect(box.width).toBeGreaterThanOrEqual(TOUCH_TARGET_DP);
  });

  it('keeps the clear control inside the shared field floor', async () => {
    const { renderer, box } = await mountWithClear();
    const rowClasses = String(fieldRow(renderer).props.className).split(' ');

    // The row carries no vertical padding or floor of its own: the shared
    // input box's 44pt `min-h` lays it out, and the clear box's `-my-[7px]`
    // leaves 34pt of cross size, so typing cannot shift the list.
    expect(rowClasses.some(name => /^(?:py|p)-/.test(name))).toBe(false);
    expect(rowClasses.some(name => name.startsWith('min-h-'))).toBe(false);
    expect(box.height - 14).toBeLessThanOrEqual(44);
  });
});
