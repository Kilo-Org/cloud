import { createRef, type ElementType, type ReactElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type TextInput } from 'react-native';

import '@/i18n';
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
    expect(searchInput(renderer).props.style).toEqual({ textAlign: 'right' });
  });
});
