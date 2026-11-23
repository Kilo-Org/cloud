// The new-session repository picker must keep long names distinguishable:
// rows inside a provider section drop the redundant provider cell, and the name
// is middle-ellipsized inside its own box so the head and the distinguishing
// tail both stay visible and the text can never reach the trailing check.
import { act, createElement, type EffectCallback, type ReactNode, useEffect } from 'react';
import { renderWithProviders } from '@/test/render-with-providers';
import { type ReactTestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import RepoPickerScreen from '@/app/(app)/agent-chat/repo-picker';
import { PickerSheet } from '@/components/picker-sheet';
import { Card } from '@/components/ui/card';
import { type RepoOption, type RepoPickerSection } from '@/lib/picker-bridge';
import { repoPickerSlot, UNFENCED_ROUTE_KEY } from '@/lib/route-registry';
import { i18n } from '@/i18n';

vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('react-native', () => ({
  FlatList: 'FlatList',
  I18nManager: { isRTL: false },
  Keyboard: { dismiss: vi.fn() },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  TextInput: 'TextInput',
  View: 'View',
  // EmptyState reads the scheme for its dark disc and glyph ink.
  useColorScheme: () => 'light',
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ back: routerMock.back, push: routerMock.push }),
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
  Plug: 'Plug',
  Search: 'Search',
  SearchX: 'SearchX',
  Unlock: 'Unlock',
  X: 'X',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#111111', mutedForeground: '#777777' }),
}));
// The route's empty state is what this suite drives, not the button's own
// surface: `StateAction` becomes a host pressable carrying the action a person
// would press, so the suite reads the handler the route supplies.
vi.mock('@/components/empty-state', () => ({
  EmptyState: (props: { action?: ReactNode }) => createElement('EmptyState', props, props.action),
  StateAction: (props: { label: string; onPress: () => void }) =>
    createElement('Pressable', {
      accessibilityLabel: props.label,
      onPress: props.onPress,
    }),
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

const slotBridge = vi.hoisted(() => ({ onSelect: vi.fn<(repo: string) => void>() }));

const routerMock = vi.hoisted(() => ({
  back: vi.fn<() => void>(),
  push: vi.fn<(href: string) => void>(),
}));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  slotBridge.onSelect.mockReset();
  routerMock.back.mockReset();
  routerMock.push.mockReset();
  repoPickerSlot.set(UNFENCED_ROUTE_KEY, {
    repositories: rows,
    sections,
    organizationId: 'org-1',
    currentValue: '',
    onSelect: slotBridge.onSelect,
  });
});

async function mount(): Promise<ReactTestRenderer> {
  const mounted = await renderWithProviders(createElement(RepoPickerScreen));
  onTestFinished(mounted.unmount);
  return mounted.renderer;
}

function sheetOf(renderer: ReactTestRenderer) {
  const [sheet] = renderer.root.findAllByType(PickerSheet);
  if (!sheet) {
    throw new Error('The picker sheet did not mount');
  }
  return sheet;
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

describe('repository picker dismissal burst', () => {
  it('a second tap on one repository row inside the dismissal burst selects and pops once', async () => {
    const renderer = await mount();
    const row = rowFor(renderer, SIBLING_NAME);
    const press = row.props.onPress as () => void;

    act(() => {
      press();
      // The sheet is still mounted for the tap that lands on the row it just
      // covered: the selection must not run twice.
      press();
    });

    expect(slotBridge.onSelect).toHaveBeenCalledTimes(1);
    // The row hands the picker its own key, which is what the slot consumes.
    expect(slotBridge.onSelect).toHaveBeenCalledWith(`github:${SIBLING_NAME}`);
    // One pop: the second tap must not close the screen beneath the picker.
    expect(routerMock.back).toHaveBeenCalledTimes(1);
    expect(repoPickerSlot.get(UNFENCED_ROUTE_KEY)).toBeUndefined();
  });
});

describe('repository picker header dismissal', () => {
  it('dismisses from the header Cancel without reporting a pick', async () => {
    const renderer = await mount();
    const cancel = sheetOf(renderer).props.onCancel as (() => void) | undefined;
    expect(typeof cancel).toBe('function');

    act(() => {
      cancel?.();
    });

    expect(routerMock.back).toHaveBeenCalledTimes(1);
    expect(slotBridge.onSelect).not.toHaveBeenCalled();
  });

  it('offers the same header Cancel when the bridge is gone', async () => {
    repoPickerSlot.clear(UNFENCED_ROUTE_KEY);
    const renderer = await mount();
    const cancel = sheetOf(renderer).props.onCancel as (() => void) | undefined;
    expect(typeof cancel).toBe('function');

    act(() => {
      cancel?.();
    });

    expect(routerMock.back).toHaveBeenCalledTimes(1);
    expect(slotBridge.onSelect).not.toHaveBeenCalled();
  });
});

describe('repository picker empty state', () => {
  beforeEach(() => {
    repoPickerSlot.set(UNFENCED_ROUTE_KEY, {
      repositories: [],
      sections: [],
      organizationId: 'org-1',
      currentValue: '',
      onSelect: slotBridge.onSelect,
    });
  });

  function emptyAction(renderer: ReactTestRenderer) {
    const label = i18n.t('integrations.sectionTitle');
    const [action] = renderer.root.findAll(
      node => String(node.type) === 'Pressable' && node.props.accessibilityLabel === label
    );
    if (!action) {
      throw new Error('The empty state did not mount its action');
    }
    return action;
  }

  it('offers the Connected services action and exits to that route once per press', async () => {
    const renderer = await mount();

    const press = emptyAction(renderer).props.onPress as () => void;
    act(() => {
      press();
      // The second tap of a dismissal burst must not pop the composer too.
      press();
    });

    expect(routerMock.back).toHaveBeenCalledTimes(1);
    expect(routerMock.push).toHaveBeenCalledTimes(1);
    expect(routerMock.push).toHaveBeenCalledWith(
      '/(app)/(tabs)/(3_profile)/integrations?org=org-1'
    );
    // The order is the point: the pop leaves this route before the push joins
    // the stack the composer left, so a push first would land under the picker.
    const popOrder = routerMock.back.mock.invocationCallOrder[0] ?? 0;
    const pushOrder = routerMock.push.mock.invocationCallOrder[0] ?? 0;
    expect(popOrder).toBeLessThan(pushOrder);
    expect(slotBridge.onSelect).not.toHaveBeenCalled();
  });
});

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
    // The row control is the host Pressable: `ChoiceRow` hands the name and the
    // press to `RowFrame`, so a bare prop match would also count the frame
    // component above the control. The search field's own clear control is
    // not a row.
    const results = renderer.root.findAll(
      node =>
        String(node.type) === 'Pressable' &&
        typeof node.props.accessibilityLabel === 'string' &&
        node.props.accessibilityLabel !== i18n.t('common.clearSearch') &&
        node.props.onPress
    );
    expect(results).toHaveLength(2);
    for (const result of results) {
      const texts = result.findAll(node => String(node.type) === 'Text');
      expect(texts.map(node => node.props.children)).toContain('GitHub');
      expect(texts).toHaveLength(2);
    }
  });

  it('keeps the provider cell on recently used rows, which mix providers under one header', async () => {
    repoPickerSlot.set(UNFENCED_ROUTE_KEY, {
      repositories: rows,
      sections: [{ key: 'recents', titleKey: 'agentChat.newSession.recentlyUsed', repos: rows }],
      organizationId: 'org-1',
      currentValue: '',
      onSelect: vi.fn<() => void>(),
    });
    const renderer = await mount();

    // The provider trails the name, so a recent row's name starts on the same
    // edge as the names in the sections below it.
    const texts = rowFor(renderer, LONG_NAME).findAll(node => String(node.type) === 'Text');
    expect(texts.map(node => node.props.children)).toEqual([LONG_NAME, 'GitHub']);
  });

  it('names the provider and the full repository in the accessibility label', async () => {
    const renderer = await mount();
    const row = rowFor(renderer, SIBLING_NAME);
    expect(row.props.accessibilityLabel).toBe(`GitHub ${SIBLING_NAME}`);
    // The shared choice row states selection and enablement together.
    expect(row.props.accessibilityState).toMatchObject({ selected: false, disabled: false });
  });
});

describe('repository picker Bitbucket note', () => {
  // A personal scope lists no Bitbucket rows, so the note explains the gap under
  // the provider sections.
  beforeEach(() => {
    repoPickerSlot.set(UNFENCED_ROUTE_KEY, {
      repositories: rows,
      sections,
      organizationId: null,
      currentValue: '',
      onSelect: slotBridge.onSelect,
    });
  });

  function noteTexts(renderer: ReactTestRenderer) {
    return renderer.root
      .findAllByType(Card)
      .flatMap(card => card.findAll(node => String(node.type) === 'Text'))
      .map(node => node.props.children);
  }

  it('states the rule once, in the sentence that already names the product', async () => {
    const renderer = await mount();

    expect(noteTexts(renderer)).toEqual([
      i18n.t('agentChat.newSession.bitbucketOrganizationsOnly'),
    ]);
  });

  it('hands the note to the shared Text, which owns the paragraph direction', async () => {
    await i18n.changeLanguage('ar');
    onTestFinished(() => {
      void i18n.changeLanguage('en');
    });
    // The Arabic sentence starts with the Latin product name, so its own first
    // strong character would set the paragraph left to right inside a
    // right-aligned line. `Text` adds the mark from the child tree it draws
    // (`rtlBaseMarkedChildren`); this suite mounts the screen with that primitive
    // stubbed to a host element, so the mark is proved in
    // `components/ui/text.rtl-base-direction.mounted.test.tsx`, and a call-site
    // mark here would draw a second one.

    const renderer = await mount();

    const sentence = i18n.t('agentChat.newSession.bitbucketOrganizationsOnly');
    expect(sentence.startsWith('Bitbucket')).toBe(true);
    expect(noteTexts(renderer)).toEqual([sentence]);
  });
});
