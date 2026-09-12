/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (node env, no jsdom). */
import { createElement, Fragment, type ReactNode } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';
import { type ModelPickerRow } from '@/lib/model-picker-rows';
import { type ModelPickerBridge } from '@/lib/picker-bridge';

import { ModelPickerContent } from './model-picker-content';

// Every search string that reached the list derivation. Recorded so a test can
// prove a superseded keystroke never drove the list, not merely that the final
// rows look right.
const buildSearchCalls = vi.hoisted(() => ({ values: [] as string[] }));

// The data length of every FlatList commit, in order. A keystroke burst must
// commit the held (pre-typing) list and then the settled list — never an
// intermediate query's rows.
const listCommitLengths = vi.hoisted(() => ({ values: [] as number[] }));

// A stable favorites array (its identity is part of the rows memo's deps) so
// the derivation only runs when the deferred query actually changes.
const preferences = vi.hoisted(() => ({ favorites: [] as string[] }));

const slotState = vi.hoisted(() => ({ bridge: undefined as unknown }));

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

// FlatList renders through a callback; this mock mirrors the real list (rows
// via renderItem, key via keyExtractor) so row assertions see real content,
// and records each commit's data length.
const flatListMock = vi.hoisted(
  () =>
    (props: {
      data: readonly ModelPickerRow[];
      renderItem?: (info: { item: ModelPickerRow; index: number }) => ReactNode;
      keyExtractor?: (item: ModelPickerRow) => string;
    }) => {
      listCommitLengths.values.push(props.data.length);
      const rows = props.data.map((item, index) =>
        createElement(
          Fragment,
          { key: props.keyExtractor ? props.keyExtractor(item) : String(index) },
          props.renderItem ? props.renderItem({ item, index }) : null
        )
      );
      return createElement('FlatList', { data: props.data }, ...rows);
    }
);

vi.mock('react-native', () => ({
  FlatList: flatListMock,
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
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@/components/picker-sheet', () => ({
  PickerSheet: (props: { children?: ReactNode; headerContent?: ReactNode }) =>
    createElement('PickerSheet', null, props.headerContent, props.children),
}));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({
  AlertCircle: 'AlertCircle',
  Info: 'Info',
  Search: 'Search',
  SearchX: 'SearchX',
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

function listRows(renderer: TestRenderer.ReactTestRenderer): ModelPickerRow[] {
  const list = findByType(renderer.root, 'FlatList')[0];
  if (!list) {
    throw new Error('FlatList not found');
  }
  /* eslint-disable typescript-eslint/no-unsafe-member-access -- react-test-renderer props are an index signature */
  return list.props.data as ModelPickerRow[];
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
    routerBack.mockClear();
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

    expect(findByType(renderer.root, 'FlatList')).toHaveLength(0);
    const emptyState = findByType(renderer.root, 'EmptyState');
    expect(emptyState).toHaveLength(1);
    /* eslint-disable typescript-eslint/no-unsafe-member-access -- react-test-renderer props are an index signature */
    expect(emptyState[0]?.props.title).toBe('No matches');
    /* eslint-enable typescript-eslint/no-unsafe-member-access */

    act(() => {
      renderer.unmount();
    });
  });
});
