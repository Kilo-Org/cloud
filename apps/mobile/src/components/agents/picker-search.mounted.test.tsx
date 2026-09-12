import { act, createElement, type EffectCallback, type ReactNode, useEffect } from 'react';
import { renderWithProviders } from '@/test/render-with-providers';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import RepoPickerScreen from '@/app/(app)/agent-chat/repo-picker';
import { ModelPickerContent } from '@/components/agents/model-picker-content';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';
import { type RepoOption } from '@/lib/picker-bridge';
import { modelPickerSlot, repoPickerSlot, UNFENCED_ROUTE_KEY } from '@/lib/route-registry';
import '@/i18n';

vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('react-native', () => ({
  FlatList: 'FlatList',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  TextInput: 'TextInput',
  View: 'View',
}));
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
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({
  AlertCircle: 'AlertCircle',
  Check: 'Check',
  Info: 'Info',
  Lock: 'Lock',
  Search: 'Search',
  SearchX: 'SearchX',
  Unlock: 'Unlock',
}));
vi.mock('@/components/agents/model-selector', () => ({
  ModelPickerOptionRow: 'ModelPickerOptionRow',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({}) }));
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
const organization = vi.hoisted(() => ({ organizationId: null as string | null }));
vi.mock('@/lib/organization-context', () => ({ useOrganization: () => organization }));

beforeEach(() => {
  organization.organizationId = null;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
    currentValue: '',
    onSelect: vi.fn<() => void>(),
  });
});

describe('repository picker Bitbucket scope note', () => {
  const note = 'Bitbucket is available for organizations only.';

  it('explains the Personal limitation without a retry action', async () => {
    const renderer = await mount(RepoPickerScreen);
    expect(hosts(renderer, 'Text').some(node => node.props.children === note)).toBe(true);
    expect(hosts(renderer, 'Pressable')).toHaveLength(1);
  });

  it.each(['recents', 'no-bitbucket-rows'] as const)(
    'does not claim Bitbucket is unavailable to an organization with %s',
    async kind => {
      organization.organizationId = 'org-1';
      const onSelect = vi.fn<() => void>();
      if (kind === 'recents') {
        const bitbucket: RepoOption = {
          platform: 'bitbucket',
          fullName: 'workspace/repo',
          isPrivate: true,
        };
        repoPickerSlot.set(UNFENCED_ROUTE_KEY, {
          repositories: [bitbucket],
          sections: [
            { key: 'recents', titleKey: 'agentChat.newSession.recentlyUsed', repos: [bitbucket] },
          ],
          currentValue: '',
          onSelect,
        });
      }
      const renderer = await mount(RepoPickerScreen);
      expect(hosts(renderer, 'Text').some(node => node.props.children === note)).toBe(false);
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
    expect(hosts(renderer, 'Pressable')).toHaveLength(1);
    expect(hosts(renderer, 'Text').some(node => node.props.children === note)).toBe(false);
    act(() => {
      changeSearch('');
    });
    expect(hosts(renderer, 'Text').some(node => node.props.children === note)).toBe(true);
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

// The model picker hosts its rows in a FlatList and manages its own scrolling
// (PickerSheet scrollable=false); the repository picker renders mapped rows
// inside the shell ScrollView and so always keeps that ScrollView mounted.
describe.each([
  { name: 'model', Component: ModelPickerContent, rowHost: 'FlatList', hasShellScrollView: false },
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
    expect(hosts(renderer, rowHost).length).toBeGreaterThan(0);
    expect(hosts(renderer, 'CenteredState')).toHaveLength(0);

    const changeSearch = input.props.onChangeText as (text: string) => void;
    act(() => {
      changeSearch('no matching choice');
    });
    expect(hosts(renderer, rowHost)).toHaveLength(0);
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
    expect(hosts(renderer, rowHost).length).toBeGreaterThan(0);
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
    expect(hosts(renderer, 'FlatList')).toHaveLength(0);
    if (!hasShellScrollView) {
      expect(hosts(renderer, 'ScrollView')).toHaveLength(0);
    }
    expect(hosts(renderer, 'TextInput')).toHaveLength(1);
  });
});
