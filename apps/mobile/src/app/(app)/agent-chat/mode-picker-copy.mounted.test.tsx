// The mode picker's copy for a selected custom mode that no loaded option
// names. The screen appends that slug itself (`ensureSelectedCustomOption`)
// with an empty label and description, so a regression prints the raw slug as
// the row title and builds an accessible name whose separator has nothing
// after it. These tests read the app's real English catalog instead of mocking
// `react-i18next`, so they assert the copy a person actually sees.
import { createElement, Fragment, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import ModePickerScreen from './mode-picker';
import { NavigationContext } from '@/lib/navigation/navigation-context';

// `reviewer` is a custom profile-agent slug the loaded options do not name, so
// the screen appends `{ value: 'reviewer', label: '', description: '' }`.
const bridge = vi.hoisted(() => ({
  currentValue: 'reviewer',
  onSelect: vi.fn(),
  customOptions: [],
}));
const modePickerSlotClear = vi.hoisted(() => vi.fn());
const router = vi.hoisted(() => ({ back: vi.fn() }));
const navigation = vi.hoisted(() => ({ isFocused: () => true }));

const flashListMock = vi.hoisted(
  () =>
    (props: {
      data: readonly { value: string }[];
      renderItem?: (info: { item: { value: string }; index: number }) => ReactNode;
    }) =>
      createElement(
        'FlashList',
        null,
        props.data.map((item, index) =>
          createElement(
            Fragment,
            { key: item.value },
            props.renderItem ? props.renderItem({ item, index }) : null
          )
        )
      )
);

vi.mock('@shopify/flash-list', () => ({ FlashList: flashListMock }));
vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
  // The sheet shell arms hardware Back; nothing here presses it.
  BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
}));
vi.mock('expo-router', () => ({
  useRouter: () => router,
  useLocalSearchParams: () => ({}),
}));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/ui/icons', () => ({
  Bot: 'Icon',
  Bug: 'Icon',
  Check: 'Icon',
  Code: 'Icon',
  HelpCircle: 'Icon',
  Info: 'Icon',
  NotebookPen: 'Icon',
  Workflow: 'Icon',
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ background: '#fff', foreground: '#000', primary: '#f00' }),
}));
vi.mock('@/lib/route-registry', () => ({
  modePickerSlot: {
    get: () => bridge,
    clear: modePickerSlotClear,
  },
  UNFENCED_ROUTE_KEY: 'unscoped',
  useRouteRegistry: vi.fn(),
}));

async function mount(): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(
      createElement(
        NavigationContext.Provider,
        { value: navigation as never },
        createElement(ModePickerScreen)
      )
    );
    await Promise.resolve();
  });
  if (!ref.current) {
    throw new Error('route did not render');
  }
  return ref.current;
}

/** The copy a rendered `Text` prints: its string child, and nothing else. */
function nodeText(node: TestRenderer.ReactTestInstance): string | null {
  const children: unknown = node.props.children;
  return typeof children === 'string' ? children : null;
}

/** Every string `node`'s `Text` elements print, in render order. */
function textsUnder(node: TestRenderer.ReactTestInstance): string[] {
  return node
    .findAll(child => String(child.type) === 'Text')
    .flatMap(child => {
      const text = nodeText(child);
      return text === null ? [] : [text];
    });
}

/** The rows the picker renders, found by the accessible name they announce. */
function rowsLabelled(
  renderer: TestRenderer.ReactTestRenderer,
  label: string
): TestRenderer.ReactTestInstance[] {
  return renderer.root.findAll(
    node => String(node.type) === 'Pressable' && node.props.accessibilityLabel === label
  );
}

function unmount(renderer: TestRenderer.ReactTestRenderer) {
  act(() => {
    renderer.unmount();
  });
}

describe('ModePickerScreen copy for an unnamed custom mode', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    bridge.onSelect.mockClear();
    router.back.mockClear();
    modePickerSlotClear.mockClear();
  });

  it('names the appended custom row with the generic mode label, not the slug', async () => {
    const renderer = await mount();

    // The shipped catalog holds this copy; the row must render it as its title.
    expect(i18n.t('agentChat.modeSelector.customMode')).toBe('Custom mode');
    const rendered = textsUnder(renderer.root);
    expect(rendered).toContain('Custom mode');
    expect(rendered.filter(text => text.includes('reviewer'))).toEqual([]);

    unmount(renderer);
  });

  it('leaves no empty description line and no separator before nothing on that row', async () => {
    const renderer = await mount();

    expect(i18n.t('agentChat.modeSelector.accessibility', { label: 'Custom mode' })).toBe(
      'Mode: Custom mode'
    );
    const customRows = rowsLabelled(renderer, 'Mode: Custom mode');
    expect(customRows).toHaveLength(1);
    const customRow = customRows[0];
    if (!customRow) {
      throw new Error('The appended custom mode row did not mount');
    }

    // One line only: the empty description renders no second `Text`, so the
    // row never prints a separator with nothing after it.
    const customTexts = textsUnder(customRow);
    expect(customTexts).toEqual(['Custom mode']);
    for (const text of customTexts) {
      expect(text.endsWith(': ')).toBe(false);
    }
    expect(textsUnder(renderer.root)).not.toContain('reviewer: ');

    // The built-in rows are untouched: Code keeps its title and description.
    const codeRows = rowsLabelled(renderer, 'Code: Write and modify code');
    expect(codeRows).toHaveLength(1);
    const codeRow = codeRows[0];
    if (!codeRow) {
      throw new Error('The built-in Code row did not mount');
    }
    expect(textsUnder(codeRow)).toEqual(['Code', 'Write and modify code']);

    unmount(renderer);
  });
});
