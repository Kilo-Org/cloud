// The new-session repository picker must keep long names distinguishable:
// rows inside a provider section drop the redundant provider cell, and the name
// is middle-ellipsized inside its own box so the head and the distinguishing
// tail both stay visible and the text can never reach the trailing check.
import { act, createElement, type EffectCallback, useEffect } from 'react';
import { renderWithProviders } from '@/test/render-with-providers';
import { type ReactTestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import RepoPickerScreen from '@/app/(app)/agent-chat/repo-picker';
import { type RepoOption, type RepoPickerSection } from '@/lib/picker-bridge';
import { repoPickerSlot, UNFENCED_ROUTE_KEY } from '@/lib/route-registry';
import '@/i18n';

vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('react-native', () => ({
  FlatList: 'FlatList',
  I18nManager: { isRTL: false },
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
  Check: 'Check',
  Info: 'Info',
  Lock: 'Lock',
  Search: 'Search',
  SearchX: 'SearchX',
  Unlock: 'Unlock',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#111111', mutedForeground: '#777777' }),
}));

// Two rows that only differ in their last three characters: a tail cut hides
// exactly what tells them apart, a middle ellipsis keeps it.
const LONG_NAME =
  'xmvfbazn533-org/xmvfbazn533-open-source-kubernetes-dashboard-engine-sandbox-الذكية-لإدارة-001';
const SIBLING_NAME =
  'xmvfbazn533-org/xmvfbazn533-open-source-kubernetes-dashboard-engine-sandbox-الذكية-لإدارة-002';

const rows: RepoOption[] = [
  { platform: 'github', fullName: LONG_NAME, isPrivate: false },
  { platform: 'github', fullName: SIBLING_NAME, isPrivate: true },
];

const sections: RepoPickerSection[] = [{ key: 'github', titleKey: 'common.github', repos: rows }];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  repoPickerSlot.set(UNFENCED_ROUTE_KEY, {
    repositories: rows,
    sections,
    organizationId: 'org-1',
    currentValue: '',
    onSelect: vi.fn<() => void>(),
  });
});

async function mount(): Promise<ReactTestRenderer> {
  const mounted = await renderWithProviders(createElement(RepoPickerScreen));
  onTestFinished(mounted.unmount);
  return mounted.renderer;
}

function rowFor(renderer: ReactTestRenderer, fullName: string) {
  const label = `GitHub ${fullName}`;
  const row = renderer.root.findAll(node => node.props.accessibilityLabel === label)[0];
  if (!row) {
    throw new Error(`Repository row "${label}" did not mount`);
  }
  return row;
}

async function search(renderer: ReactTestRenderer, query: string) {
  const input = renderer.root.findAll(node => String(node.type) === 'TextInput')[0];
  if (!input) {
    throw new Error('Picker search input did not mount');
  }
  const changeSearch = input.props.onChangeText as (text: string) => void;
  // The filtered list trails the input through `useDeferredValue`, so the
  // assertion has to wait for that low-priority render to commit.
  await act(async () => {
    changeSearch(query);
    await Promise.resolve();
  });
}

describe('repository picker row layout', () => {
  it('keeps the whole name in a middle-ellipsized box inside a provider section', async () => {
    const renderer = await mount();
    const row = rowFor(renderer, LONG_NAME);

    const name = row.findAll(node => String(node.type) === 'Text')[0];
    if (name?.props.children !== LONG_NAME) {
      throw new Error('The repository name did not mount as one text node');
    }
    expect(name.props.numberOfLines).toBe(1);
    expect(name.props.ellipsizeMode).toBe('middle');

    // The name sits in a min-w-0 flex-1 box, so it truncates within the space
    // left of the trailing check instead of overflowing into it.
    expect(String(name.parent?.props.className)).toContain('min-w-0');
    expect(String(name.parent?.props.className)).toContain('flex-1');
  });

  it('drops the redundant provider cell inside a section but keeps it in search results', async () => {
    const renderer = await mount();
    expect(rowFor(renderer, LONG_NAME).findAll(node => String(node.type) === 'Text')).toHaveLength(
      1
    );

    await search(renderer, 'kubernetes');
    const results = renderer.root.findAll(
      node => typeof node.props.accessibilityLabel === 'string' && node.props.onPress
    );
    expect(results).toHaveLength(2);
    for (const result of results) {
      const texts = result.findAll(node => String(node.type) === 'Text');
      expect(texts.map(node => node.props.children)).toContain('GitHub');
      expect(texts).toHaveLength(2);
    }
  });

  it('names the provider and the full repository in the accessibility label', async () => {
    const renderer = await mount();
    const row = rowFor(renderer, SIBLING_NAME);
    expect(row.props.accessibilityLabel).toBe(`GitHub ${SIBLING_NAME}`);
    expect(row.props.accessibilityState).toEqual({ selected: false });
  });
});
