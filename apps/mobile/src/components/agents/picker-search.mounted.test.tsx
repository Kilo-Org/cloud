/* eslint-disable max-lines -- The repository and model pickers' search, alignment and centering contracts share one mount harness. */
import {
  act,
  createElement,
  type EffectCallback,
  Fragment,
  type ReactNode,
  useEffect,
} from 'react';
import { renderWithProviders } from '@/test/render-with-providers';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import RepoPickerScreen from '@/app/(app)/agent-chat/repo-picker';
import { ModelPickerContent } from '@/components/agents/model-picker-content';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';
import { type RepoOption } from '@/lib/picker-bridge';
import { modelPickerSlot, repoPickerSlot, UNFENCED_ROUTE_KEY } from '@/lib/route-registry';
import '@/i18n';

// Live so a test can flip the interface direction before it mounts; the input
// alignment helper reads `I18nManager.isRTL` when it composes the style.
const i18nManager = vi.hoisted(() => ({ isRTL: false }));
// The one token the picker's search input passes inline; the assertions read
// the same value the mock hands the component.
const theme = vi.hoisted(() => ({ foreground: '#111111' }));
// The repository picker clears the uncontrolled field through the ref, so the
// TextInput mock exposes the imperative `clear` the native input has and the
// test can prove the native text is reset, not just the derived query.
const clearSearch = vi.hoisted(() => vi.fn());

vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
// The model picker renders its rows through FlashList v2; this stub renders
// each row through the real `renderItem` so the suite sees the row hosts.
vi.mock('@shopify/flash-list', () => ({
  FlashList: (props: {
    data?: { key: string }[];
    keyExtractor?: (item: { key: string }) => string;
    renderItem: (info: { item: { key: string }; index: number }) => ReactNode;
  }) =>
    createElement(
      'FlashList',
      props,
      (props.data ?? []).map((item, index) =>
        createElement(
          Fragment,
          { key: props.keyExtractor?.(item) ?? index },
          props.renderItem({ item, index })
        )
      )
    ),
}));
vi.mock('react-native', async () => {
  const {
    createElement: createMockElement,
    forwardRef,
    useImperativeHandle,
  } = await import('react');
  const MockTextInput = forwardRef<{ clear: () => void }, Record<string, unknown>>((props, ref) => {
    useImperativeHandle(ref, () => ({ clear: clearSearch }));
    return createMockElement('TextInput', props);
  });
  MockTextInput.displayName = 'MockTextInput';
  return {
    FlatList: 'FlatList',
    I18nManager: i18nManager,
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    TextInput: MockTextInput,
    View: 'View',
  };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ back: vi.fn() }),
  useLocalSearchParams: () => ({}),
  useFocusEffect: (effect: EffectCallback) => {
    useEffect(effect, [effect]);
  },
}));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({
  AlertCircle: 'AlertCircle',
  Check: 'Check',
  Info: 'Info',
  Lock: 'Lock',
  Search: 'Search',
  SearchX: 'SearchX',
  Unlock: 'Unlock',
  X: 'X',
}));
vi.mock('@/components/agents/model-selector', () => ({
  ModelPickerOptionRow: 'ModelPickerOptionRow',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: theme.foreground }),
}));
vi.mock('@/lib/hooks/use-model-preferences', () => ({
  useModelPreferences: () => ({ favorites: [], addFavorite: vi.fn(), removeFavorite: vi.fn() }),
}));

const model: SessionModelOption = {
  id: 'model-1',
  displayId: 'model-1',
  name: 'Test model',
  variants: [],
  isPreferred: false,
  showGatewayMetadata: false,
};
const repo: RepoOption = { platform: 'github', fullName: 'org/repo', isPrivate: false };
const bitbucketNote = 'Bitbucket is available for organizations only.';

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  i18nManager.isRTL = false;
  clearSearch.mockClear();
  modelPickerSlot.set(UNFENCED_ROUTE_KEY, {
    options: [model],
    currentValue: '',
    currentVariant: '',
    selectionScope: {
      sessionId: UNFENCED_ROUTE_KEY,
      ownerConnectionId: null,
      protocol: 'unknown',
      catalogGenerationIdentity: null,
    },
    isSelectionCurrent: () => true,
    onSelect: vi.fn<() => void>(),
  });
  repoPickerSlot.set(UNFENCED_ROUTE_KEY, {
    repositories: [repo],
    sections: [{ key: 'github', titleKey: 'common.github', repos: [repo] }],
    // The picker keys its Bitbucket note on the scope the ROWS were loaded
    // under, not on the app's global organization selection.
    organizationId: null,
    currentValue: '',
    onSelect: vi.fn<() => void>(),
  });
});

describe('repository picker Bitbucket scope note', () => {
  it('explains the Personal limitation without a retry action', async () => {
    const renderer = await mount(RepoPickerScreen);
    expect(hosts(renderer, 'Text').some(node => node.props.children === bitbucketNote)).toBe(true);
    expect(hosts(renderer, 'Pressable')).toHaveLength(1);
  });

  it.each(['recents', 'no-bitbucket-rows'] as const)(
    'does not claim Bitbucket is unavailable to an organization with %s',
    async kind => {
      const onSelect = vi.fn<() => void>();
      const repositories: RepoOption[] =
        kind === 'recents'
          ? [{ platform: 'bitbucket', fullName: 'workspace/repo', isPrivate: true }]
          : [repo];
      const sections =
        kind === 'recents'
          ? [
              {
                key: 'recents' as const,
                titleKey: 'agentChat.newSession.recentlyUsed',
                repos: repositories,
              },
            ]
          : [{ key: 'github' as const, titleKey: 'common.github', repos: repositories }];
      repoPickerSlot.set(UNFENCED_ROUTE_KEY, {
        repositories,
        sections,
        organizationId: 'org-1',
        currentValue: '',
        onSelect,
      });
      const renderer = await mount(RepoPickerScreen);
      expect(hosts(renderer, 'Text').some(node => node.props.children === bitbucketNote)).toBe(
        false
      );
      expect(hosts(renderer, 'Pressable')).toHaveLength(1);
      if (kind === 'recents') {
        const row = renderer.root.findByProps({ accessibilityLabel: 'Bitbucket workspace/repo' });
        act(() => {
          (row.props.onPress as () => void)();
        });
        expect(onSelect).toHaveBeenCalledWith('bitbucket:workspace/repo');
      }
    }
  );

  it('hides the Personal note while searching, even when repositories match', async () => {
    const renderer = await mount(RepoPickerScreen);
    const input = hosts(renderer, 'TextInput')[0];
    if (!input) {
      throw new Error('Picker search input did not mount');
    }
    const changeSearch = input.props.onChangeText as (text: string) => void;
    act(() => {
      changeSearch('org/repo');
    });
    // The query is non-empty, so the in-field clear control joins the single
    // matching row; the row host count stays one.
    expect(rowHosts(renderer, 'Pressable')).toHaveLength(1);
    expect(clearSearchButtons(renderer)).toHaveLength(1);
    expect(hosts(renderer, 'Text').some(node => node.props.children === bitbucketNote)).toBe(false);
    act(() => {
      changeSearch('');
    });
    expect(hosts(renderer, 'Text').some(node => node.props.children === bitbucketNote)).toBe(true);
  });
});

describe('repository picker search placeholder', () => {
  const copy = 'Search repositories...';

  it('renders a single tail-ellipsized line instead of a wrapping native hint', async () => {
    const renderer = await mount(RepoPickerScreen);
    const input = hosts(renderer, 'TextInput')[0];
    if (!input) {
      throw new Error('Picker search input did not mount');
    }
    // The native hint is what Android lays out at the field width with no line
    // cap, wrapping onto a second line the fixed-height field then clips.
    expect(input.props.placeholder).toBeUndefined();

    const placeholder = hosts(renderer, 'Text').find(node => node.props.children === copy);
    if (!placeholder) {
      throw new Error('Search placeholder overlay did not mount');
    }
    expect(placeholder.props.numberOfLines).toBe(1);
    expect(placeholder.props.ellipsizeMode).toBe('tail');
    expect(placeholder.parent?.props.pointerEvents).toBe('none');

    const changeSearch = input.props.onChangeText as (text: string) => void;
    act(() => {
      changeSearch('org/repo');
    });
    expect(hosts(renderer, 'Text').some(node => node.props.children === copy)).toBe(false);
  });
});

describe('repository picker search clear', () => {
  it('resets the query and the native text when the in-field control is pressed', async () => {
    const renderer = await mount(RepoPickerScreen);
    const input = hosts(renderer, 'TextInput')[0];
    if (!input) {
      throw new Error('Picker search input did not mount');
    }
    // Opening the picker focuses the field and clears it once already; the
    // press must add exactly one more native clear.
    const nativeClearsOnMount = clearSearch.mock.calls.length;
    const changeSearch = input.props.onChangeText as (text: string) => void;
    act(() => {
      changeSearch('org/repo');
    });
    expect(clearSearchButtons(renderer)).toHaveLength(1);

    const [clear] = clearSearchButtons(renderer);
    if (!clear) {
      throw new Error('Clear affordance did not mount');
    }
    act(() => {
      (clear.props.onPress as () => void)();
    });

    // The test-level ref stands in for the native field, so this proves the
    // imperative clear ran; the emptied `search` drops the affordance and the
    // matching row, and brings the Personal note back.
    expect(clearSearch).toHaveBeenCalledTimes(nativeClearsOnMount + 1);
    expect(clearSearchButtons(renderer)).toHaveLength(0);
    expect(hosts(renderer, 'Pressable')).toHaveLength(1);
    expect(hosts(renderer, 'Text').some(node => node.props.children === bitbucketNote)).toBe(true);
  });
});

describe('repository picker query alignment', () => {
  function searchInput(renderer: Awaited<ReturnType<typeof mount>>) {
    const input = hosts(renderer, 'TextInput')[0];
    if (!input) {
      throw new Error('Picker search input did not mount');
    }
    return input;
  }

  it('aligns the typed query to the field start edge in RTL', async () => {
    // `textAlign: 'auto'` resolves against the first strong character, so a
    // Latin query stays at the left edge while the clear and search controls
    // sit at the right, leaving a dead gap between them.
    i18nManager.isRTL = true;
    const renderer = await mount(RepoPickerScreen);
    expect(searchInput(renderer).props.style).toEqual([
      { textAlign: 'right' },
      { color: theme.foreground },
    ]);
  });

  it('leaves the input style to the caller in LTR so English is unchanged', async () => {
    i18nManager.isRTL = false;
    const renderer = await mount(RepoPickerScreen);
    expect(searchInput(renderer).props.style).toEqual({ color: theme.foreground });
  });
});

describe('model picker query alignment', () => {
  function searchInput(renderer: Awaited<ReturnType<typeof mount>>) {
    const input = hosts(renderer, 'TextInput')[0];
    if (!input) {
      throw new Error('Picker search input did not mount');
    }
    return input;
  }

  it('aligns the query and its native placeholder to the field start edge in RTL', async () => {
    // `textAlign: 'auto'` resolves against the first strong character, so a
    // Latin query and the Arabic placeholder stay at the left edge while the
    // clear and search controls sit at the right, leaving a dead gap between
    // them. The model picker had no alignment at all before this.
    i18nManager.isRTL = true;
    const renderer = await mount(ModelPickerContent);
    expect(searchInput(renderer).props.style).toEqual([{ textAlign: 'right' }, undefined]);
  });

  it('leaves the input style to the caller in LTR so English is unchanged', async () => {
    i18nManager.isRTL = false;
    const renderer = await mount(ModelPickerContent);
    expect(searchInput(renderer).props.style).toBeUndefined();
  });
});

async function mount(Component: () => ReactNode) {
  const mounted = await renderWithProviders(createElement(Component));
  onTestFinished(mounted.unmount);
  return mounted.renderer;
}

function hosts(renderer: Awaited<ReturnType<typeof mount>>, type: string) {
  return renderer.root.findAll(node => node.type === type);
}

/** The in-field clear affordance, found by the label the Agents search field uses. */
function clearSearchButtons(renderer: Awaited<ReturnType<typeof mount>>) {
  return hosts(renderer, 'Pressable').filter(
    node => node.props.accessibilityLabel === 'Clear search'
  );
}

/**
 * The repository picker's row host is `Pressable`, the same type as its in-field
 * clear control, so a row assertion counts only the pressables that are not the
 * clear affordance. The model picker's row host is the list itself, so every
 * match is a row.
 */
function rowHosts(renderer: Awaited<ReturnType<typeof mount>>, rowHost: string) {
  const candidates = hosts(renderer, rowHost);
  if (rowHost !== 'Pressable') {
    return candidates;
  }
  return candidates.filter(node => node.props.accessibilityLabel !== 'Clear search');
}

// The model picker hosts its rows in a FlashList and manages its own scrolling
// (PickerSheet scrollable=false); the repository picker renders mapped rows
// inside the shell ScrollView and so always keeps that ScrollView mounted.
describe.each([
  { name: 'model', Component: ModelPickerContent, rowHost: 'FlashList', hasShellScrollView: false },
  {
    name: 'repository',
    Component: RepoPickerScreen,
    rowHost: 'Pressable',
    hasShellScrollView: true,
  },
])('$name picker centering', ({ Component, rowHost, hasShellScrollView }) => {
  it('keeps the search input and native header mounted when replacing the list', async () => {
    const renderer = await mount(Component);
    const input = hosts(renderer, 'TextInput')[0];
    const header = hosts(renderer, 'SheetHeader')[0];
    if (!input || !header) {
      throw new Error('Picker controls did not mount');
    }
    const group = header.parent;
    expect(group?.props.collapsable).toBe(false);
    expect(group?.findAll(node => node === input)).toHaveLength(1);
    expect(rowHosts(renderer, rowHost).length).toBeGreaterThan(0);
    expect(hosts(renderer, 'CenteredState')).toHaveLength(0);

    const changeSearch = input.props.onChangeText as (text: string) => void;
    act(() => {
      changeSearch('no matching choice');
    });
    expect(rowHosts(renderer, rowHost)).toHaveLength(0);
    if (!hasShellScrollView) {
      expect(hosts(renderer, 'ScrollView')).toHaveLength(0);
    }
    expect(hosts(renderer, 'CenteredState')).toHaveLength(1);
    expect(hosts(renderer, 'TextInput')[0]).toBe(input);
    expect(hosts(renderer, 'SheetHeader')[0]).toBe(header);
    expect(header.parent).toBe(group);

    act(() => {
      changeSearch('');
    });
    expect(rowHosts(renderer, rowHost).length).toBeGreaterThan(0);
    expect(hosts(renderer, 'CenteredState')).toHaveLength(0);
    expect(hosts(renderer, 'TextInput')[0]).toBe(input);
    expect(header.parent).toBe(group);
  });

  it('centers an empty catalog without nesting a list', async () => {
    const modelBridge = modelPickerSlot.get(UNFENCED_ROUTE_KEY);
    const repoBridge = repoPickerSlot.get(UNFENCED_ROUTE_KEY);
    if (!modelBridge || !repoBridge) {
      throw new Error('Picker bridge is missing');
    }
    modelPickerSlot.set(UNFENCED_ROUTE_KEY, { ...modelBridge, options: [] });
    repoPickerSlot.set(UNFENCED_ROUTE_KEY, { ...repoBridge, repositories: [], sections: [] });
    const renderer = await mount(Component);
    expect(hosts(renderer, 'CenteredState')).toHaveLength(1);
    expect(hosts(renderer, 'FlashList')).toHaveLength(0);
    if (!hasShellScrollView) {
      expect(hosts(renderer, 'ScrollView')).toHaveLength(0);
    }
    expect(hosts(renderer, 'TextInput')).toHaveLength(1);
  });
});
