/* eslint-disable max-lines -- The picker's search, empty-state and bottom-inset contracts share one mount harness. */
import { createElement, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';
import { type ModelPickerRow } from '@/lib/model-picker-rows';
import { type ModelPickerBridge } from '@/lib/picker-bridge';

import { ModelPickerContent } from './model-picker-content';

// Every search string that reached the list derivation. Recorded so a test can
// prove a superseded keystroke never drove the list, not merely that the final
// rows look right.
const buildSearchCalls = vi.hoisted(() => ({ values: [] as string[] }));

// The data length of every FlashList commit, in order. A keystroke burst must
// commit the held (pre-typing) list and then the settled list — never an
// intermediate query's rows.
const listCommitLengths = vi.hoisted(() => ({ values: [] as number[] }));

// A stable favorites array (its identity is part of the rows memo's deps) so
// the derivation only runs when the deferred query actually changes.
const preferences = vi.hoisted(() => ({ favorites: [] as string[] }));

const slotState = vi.hoisted(() => ({ bridge: undefined as unknown }));

// The device's safe-area insets. Configurable so a test can prove the list's
// viewport ends above the bottom system bar instead of under it.
const safeAreaInsets = vi.hoisted(() => ({ bottom: 0 }));

const routerBack = vi.hoisted(() => vi.fn());

vi.mock('@/lib/model-picker-rows', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const build = actual.buildModelPickerRows as (input: {
    models: SessionModelOption[];
    search: string;
    favoriteIds: Set<string>;
  }) => ModelPickerRow[];
  return {
    ...actual,
    buildModelPickerRows: (input: Parameters<typeof build>[0]) => {
      buildSearchCalls.values.push(input.search);
      return build(input);
    },
  };
});

vi.mock('@/lib/route-registry', () => ({
  modelPickerSlot: {
    get: () => slotState.bridge,
    clear: vi.fn(),
  },
  UNFENCED_ROUTE_KEY: 'unscoped',
  useRouteRegistry: vi.fn(),
}));

vi.mock('@/lib/hooks/use-model-preferences', () => ({
  useModelPreferences: () => ({
    favorites: preferences.favorites,
    favoritesError: null,
    addFavorite: vi.fn(),
    removeFavorite: vi.fn(),
  }),
}));

// FlashList renders through a callback; this mock mirrors the real list (rows
// via renderItem, key via keyExtractor, item type via getItemType) so row
// assertions see real content, and records each commit's data length.
vi.mock('@shopify/flash-list', async () => {
  const React = await import('react');
  return {
    FlashList: (props: {
      data: readonly ModelPickerRow[];
      renderItem?: (info: { item: ModelPickerRow; index: number }) => ReactNode;
      keyExtractor?: (item: ModelPickerRow) => string;
      getItemType?: (item: ModelPickerRow) => string;
      style?: unknown;
      contentContainerStyle?: unknown;
    }) => {
      listCommitLengths.values.push(props.data.length);
      const rows = props.data.map((item, index) =>
        React.createElement(
          React.Fragment,
          { key: props.keyExtractor ? props.keyExtractor(item) : String(index) },
          props.renderItem ? props.renderItem({ item, index }) : null
        )
      );
      return React.createElement(
        'FlashList',
        {
          data: props.data,
          getItemType: props.getItemType,
          style: props.style,
          contentContainerStyle: props.contentContainerStyle,
        },
        ...rows
      );
    },
  };
});

vi.mock('react-native', () => ({
  // `withRtlInputAlignment` reads I18nManager on every render.
  I18nManager: { isRTL: false },
  Pressable: 'Pressable',
  TextInput: 'TextInput',
  View: 'View',
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ back: routerBack, push: vi.fn() }),
  useLocalSearchParams: () => ({}),
  useFocusEffect: vi.fn(),
}));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: safeAreaInsets.bottom, left: 0, right: 0 }),
}));
vi.mock('@/components/picker-sheet', () => ({
  PickerSheet: (props: { children?: ReactNode; headerContent?: ReactNode }) =>
    createElement('PickerSheet', null, props.headerContent, props.children),
}));
// EmptyState renders its `action` node (as the real component does) so the
// empty state's clear CTA is reachable from the tree; `title` stays a prop for
// the existing assertions.
vi.mock('@/components/empty-state', () => ({
  EmptyState: (props: { title: string; action?: ReactNode }) =>
    createElement('EmptyState', { title: props.title }, props.action),
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({
  AlertCircle: 'AlertCircle',
  Info: 'Info',
  Search: 'Search',
  SearchX: 'SearchX',
  X: 'X',
}));
vi.mock('@/components/agents/model-selector', () => ({
  ModelPickerOptionRow: 'ModelPickerOptionRow',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    mutedForeground: '#6b7280',
    foreground: '#111827',
    destructive: '#ef4444',
  }),
}));

const TOTAL_OPTIONS = 300;
const FINAL_QUERY = 'model-17';
// `model-17` is a substring of `model-17` and `model-170`..`model-179`.
const FINAL_MATCH_COUNT = 11;

function makeOption(index: number): SessionModelOption {
  return {
    id: `remote-model-${index}`,
    name: `Model ${index}`,
    displayId: `model-${index}`,
    variants: [],
    isPreferred: false,
    provider: { id: 'test', name: 'Test Provider' },
    showGatewayMetadata: false,
  };
}

function makeBridge(): ModelPickerBridge {
  return {
    options: Array.from({ length: TOTAL_OPTIONS }, (_, index) => makeOption(index)),
    currentValue: '',
    currentVariant: '',
    selectionScope: {
      sessionId: 'unscoped',
      ownerConnectionId: null,
      protocol: 'unknown',
      catalogGenerationIdentity: null,
    },
    isSelectionCurrent: () => true,
    onSelect: vi.fn<() => void>(),
  };
}

function findByType(
  root: TestRenderer.ReactTestInstance,
  type: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && (node.type as string) === type);
}

function listHost(renderer: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance {
  const list = findByType(renderer.root, 'FlashList')[0];
  if (!list) {
    throw new Error('FlashList not found');
  }
  return list;
}

function listRows(renderer: TestRenderer.ReactTestRenderer): ModelPickerRow[] {
  /* eslint-disable typescript-eslint/no-unsafe-member-access -- react-test-renderer props are an index signature */
  return listHost(renderer).props.data as ModelPickerRow[];
  /* eslint-enable typescript-eslint/no-unsafe-member-access */
}

/** The item-type selector FlashList uses to recycle headers apart from rows. */
function getItemType(renderer: TestRenderer.ReactTestRenderer): (item: ModelPickerRow) => string {
  /* eslint-disable typescript-eslint/no-unsafe-member-access -- react-test-renderer props are an index signature */
  return listHost(renderer).props.getItemType as (item: ModelPickerRow) => string;
  /* eslint-enable typescript-eslint/no-unsafe-member-access */
}

function listedDisplayIds(renderer: TestRenderer.ReactTestRenderer): string[] {
  return listRows(renderer)
    .filter((row): row is Extract<ModelPickerRow, { type: 'model' }> => row.type === 'model')
    .map(row => row.model.displayId);
}

function searchInput(renderer: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance {
  const input = findByType(renderer.root, 'TextInput')[0];
  if (!input) {
    throw new Error('search input not found');
  }
  return input;
}

/**
 * The in-field clear affordance, found by the label the Agents search field
 * also uses. It must exist on both platforms: `clearButtonMode` is iOS-only,
 * so Android previously rendered the query with no way to clear it.
 */
function clearSearchButtons(
  renderer: TestRenderer.ReactTestRenderer
): TestRenderer.ReactTestInstance[] {
  return renderer.root.findAll(node => node.props.accessibilityLabel === 'Clear search');
}

/** Drive the uncontrolled TextInput's handler the way a keystroke would. */
function typeSearch(renderer: TestRenderer.ReactTestRenderer, next: string): void {
  const { onChangeText } = searchInput(renderer).props as {
    onChangeText: (text: string) => void;
  };
  onChangeText(next);
}

async function mount(): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(createElement(ModelPickerContent));
    await Promise.resolve();
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('model picker did not render');
  }
  return renderer;
}

describe('ModelPickerContent deferred search', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    buildSearchCalls.values.length = 0;
    listCommitLengths.values.length = 0;
    slotState.bridge = makeBridge();
    safeAreaInsets.bottom = 0;
    routerBack.mockClear();
  });

  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('finds an auto model by the translated name its row renders', async () => {
    // The row shows the catalog's name for a Kilo auto model, so the query a
    // user types is the translated one. The picker must match it, not answer
    // "No matches" for the name it drew.
    const autoModel: SessionModelOption = {
      id: 'kilo-auto/efficient',
      name: 'Auto Efficient',
      displayId: 'kilo-auto/efficient',
      variants: [],
      isPreferred: true,
      showGatewayMetadata: true,
    };
    slotState.bridge = { ...makeBridge(), options: [autoModel] };
    await i18n.changeLanguage('it');
    const renderer = await mount();

    await act(async () => {
      typeSearch(renderer, 'Efficiente');
      await Promise.resolve();
    });

    expect(listedDisplayIds(renderer)).toEqual(['kilo-auto/efficient']);

    act(() => {
      renderer.unmount();
    });
  });

  it('holds the rows while typing and commits only the settled query', async () => {
    const renderer = await mount();

    // The catalog starts fully listed: the empty query matches every option.
    expect(listedDisplayIds(renderer)).toHaveLength(TOTAL_OPTIONS);

    const commitsBefore = listCommitLengths.values.length;
    const callsBefore = buildSearchCalls.values.length;
    const heldRowCount = listRows(renderer).length;

    // One burst: several urgent keystrokes before React runs the deferred
    // render. Yielding between them lets React commit the urgent input render
    // while the list update stays pending, which is what a fast typist does.
    await act(async () => {
      typeSearch(renderer, 'm');
      await Promise.resolve();
      typeSearch(renderer, 'mo');
      await Promise.resolve();
      typeSearch(renderer, 'mod');
      await Promise.resolve();
      typeSearch(renderer, 'model-1');
      await Promise.resolve();
      typeSearch(renderer, FINAL_QUERY);
      await Promise.resolve();
    });

    // (a) Once the deferred value flushes, the rows are the final query's.
    const displayIds = listedDisplayIds(renderer);
    expect(displayIds).toHaveLength(FINAL_MATCH_COUNT);
    expect(displayIds.every(id => id.includes(FINAL_QUERY))).toBe(true);
    const settledRowCount = listRows(renderer).length;

    // (b) The urgent keystrokes did not commit filtered rows: the first list
    // commit of the burst still held the pre-typing catalog, and the only
    // other commit is the settled query. No superseded query's rows appear.
    const burstCommits = listCommitLengths.values.slice(commitsBefore);
    expect(burstCommits[0]).toBe(heldRowCount);
    expect(burstCommits.at(-1)).toBe(settledRowCount);
    expect(
      burstCommits.filter(length => length !== heldRowCount && length !== settledRowCount)
    ).toEqual([]);

    // The list derivation never saw a superseded keystroke: the memoized rows
    // were reused while the deferred query was still empty.
    const burstCalls = buildSearchCalls.values.slice(callsBefore);
    expect(burstCalls).not.toContain('m');
    expect(burstCalls).not.toContain('mo');
    expect(burstCalls).not.toContain('mod');
    expect(burstCalls).not.toContain('model-1');
    expect(burstCalls.at(-1)).toBe(FINAL_QUERY);

    act(() => {
      renderer.unmount();
    });
  });

  it('shows the existing no-matches empty state for a non-matching query', async () => {
    const renderer = await mount();

    await act(async () => {
      typeSearch(renderer, 'no-such-model-xyz');
      await Promise.resolve();
    });

    expect(findByType(renderer.root, 'FlashList')).toHaveLength(0);
    const emptyState = findByType(renderer.root, 'EmptyState');
    expect(emptyState).toHaveLength(1);
    /* eslint-disable typescript-eslint/no-unsafe-member-access -- react-test-renderer props are an index signature */
    expect(emptyState[0]?.props.title).toBe('No matches');
    /* eslint-enable typescript-eslint/no-unsafe-member-access */

    act(() => {
      renderer.unmount();
    });
  });

  it('offers a Clear search action in the No matches empty state that returns the full list', async () => {
    const renderer = await mount();

    await act(async () => {
      typeSearch(renderer, 'no-such-model-xyz');
      await Promise.resolve();
    });

    // The "No matches" body offers exactly one clear CTA, carrying the same
    // copy the Agents search empty state uses, so both searches recover the
    // same way.
    const clearActions = findByType(renderer.root, 'Button');
    expect(clearActions).toHaveLength(1);
    const clearAction = clearActions[0];
    if (!clearAction) {
      throw new Error('clear search action not found');
    }
    const buttonProps = clearAction.props as unknown as {
      children?: { props?: { children?: ReactNode } };
      onPress?: unknown;
    };
    expect(buttonProps.children?.props?.children).toBe('Clear search');
    const onPress = buttonProps.onPress;
    if (typeof onPress !== 'function') {
      throw new TypeError('clear search action is not pressable');
    }

    await act(async () => {
      (onPress as () => void)();
      await Promise.resolve();
    });

    // The empty state is gone and the unfiltered catalog is listed again.
    expect(findByType(renderer.root, 'EmptyState')).toHaveLength(0);
    expect(listedDisplayIds(renderer)).toHaveLength(TOTAL_OPTIONS);

    act(() => {
      renderer.unmount();
    });
  });

  it('does not offer a clear action when the catalog itself is empty', async () => {
    slotState.bridge = { ...makeBridge(), options: [] };
    const renderer = await mount();

    const emptyState = findByType(renderer.root, 'EmptyState');
    expect(emptyState).toHaveLength(1);
    // The mock renders `action` as a child (as the real EmptyState does), so
    // assert on the rendered children: no action node reaches the empty state.
    expect(emptyState[0]?.children).toHaveLength(0);
    expect(findByType(renderer.root, 'Button')).toHaveLength(0);

    act(() => {
      renderer.unmount();
    });
  });

  it('offers an in-field clear affordance that resets the query', async () => {
    const renderer = await mount();

    // Nothing typed: no clear affordance, matching the Agents search field.
    expect(clearSearchButtons(renderer)).toHaveLength(0);

    await act(async () => {
      typeSearch(renderer, FINAL_QUERY);
      await Promise.resolve();
    });

    expect(listedDisplayIds(renderer)).toHaveLength(FINAL_MATCH_COUNT);
    const [clear] = clearSearchButtons(renderer);
    if (!clear) {
      throw new Error('clear affordance not found');
    }

    await act(async () => {
      (clear.props.onPress as () => void)();
      await Promise.resolve();
    });

    // Clearing drops the query the rows derive from and hides the affordance.
    expect(listedDisplayIds(renderer)).toHaveLength(TOTAL_OPTIONS);
    expect(clearSearchButtons(renderer)).toHaveLength(0);

    act(() => {
      renderer.unmount();
    });
  });

  it('gives a group header and a model row different item types', async () => {
    const renderer = await mount();

    const rows = listRows(renderer);
    const header = rows.find(row => row.type === 'header');
    const model = rows.find(row => row.type === 'model');
    if (!header || !model) {
      throw new Error('expected both a header and a model row in the catalog');
    }

    // The two rows differ in height, so recycling them under one item type
    // would measure one as the other. Pin the split.
    expect(getItemType(renderer)(header)).toBe('header');
    expect(getItemType(renderer)(model)).toBe('model');

    act(() => {
      renderer.unmount();
    });
  });

  it('ends the list viewport above the bottom system bar', async () => {
    // A device with a navigation bar: the viewport must end above it, or the
    // last row is drawn under the opaque bar (a content inset only cleared the
    // end of the list, so a row at the viewport bottom stayed covered).
    safeAreaInsets.bottom = 24;
    const renderer = await mount();

    const [list] = findByType(renderer.root, 'FlashList');
    if (!list) {
      throw new Error('FlashList not found');
    }
    /* eslint-disable typescript-eslint/no-unsafe-member-access -- react-test-renderer props are an index signature */
    const frameStyle = (
      Array.isArray(list.props.style)
        ? Object.assign({}, ...(list.props.style as Record<string, unknown>[]))
        : list.props.style
    ) as { marginBottom?: number };
    expect(frameStyle.marginBottom).toBe(24);
    // The inset lives on the frame alone; leaving it on the content as well
    // would double the reserved space.
    expect(list.props.contentContainerStyle).toBeUndefined();
    /* eslint-enable typescript-eslint/no-unsafe-member-access */

    act(() => {
      renderer.unmount();
    });
  });
});

// The composer's current model arrives as the bridge's `currentValue`. The row
// for that id must carry `selected`, or the picker shows no visible selected
// state for the model the composer is editing (model-selected finding: the
// DeepSeek V4.1 Flash row read as star-only). `selected` is what renders the
// trailing Check (see model-selector.mounted.test.tsx).
describe('ModelPickerContent selected row', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    buildSearchCalls.values.length = 0;
    listCommitLengths.values.length = 0;
    slotState.bridge = { ...makeBridge(), currentValue: 'remote-model-17' };
  });

  it('marks exactly the bridge current model as the selected row', async () => {
    const renderer = await mount();

    /* eslint-disable typescript-eslint/no-unsafe-member-access -- react-test-renderer props are an index signature */
    const selectedIds = findByType(renderer.root, 'ModelPickerOptionRow')
      .filter(node => node.props.selected === true)
      .map(node => (node.props.option as SessionModelOption).id);
    /* eslint-enable typescript-eslint/no-unsafe-member-access */

    expect(selectedIds).toEqual(['remote-model-17']);

    act(() => {
      renderer.unmount();
    });
  });
});
