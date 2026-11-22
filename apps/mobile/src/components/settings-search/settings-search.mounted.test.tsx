import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, type ReactTestInstance, type ReactTestRenderer, TestRenderer } from '@/test/renderer';

import { defineSetting, type SettingsSearchSource } from '@/lib/settings-search/definitions';
import { SettingsSearchField, SettingsSearchResults } from './settings-search';
import { useSettingsSearch } from './use-settings-search';

const platform = vi.hoisted(() => ({ OS: 'ios' }));
const lookups = vi.hoisted((): { keyword: Record<string, number> } => ({ keyword: {} }));
const copy = vi.hoisted(() => {
  const values: Record<string, string> = {
    'settingsSearch.placeholder': 'Search settings',
    'settingsSearch.noMatches': 'No matching settings',
    'settingsSearch.emptyDescription': 'Try a different setting name or keyword.',
    'settingsSearch.resultsStatus': 'Settings found: {{resultCount}}',
    'settingsSearch.keywords.appearance': 'theme|color scheme',
    'settingsSearch.keywords.privacy': 'analytics|tracking',
    'preferences.appearance': 'Appearance',
    'preferences.appearanceSystem': 'System',
    'preferences.appearanceDark': 'Dark',
    'common.language': 'Language',
    'consent.helpImprove': 'Help improve Kilo',
    'preferences.hideThinking': 'Hide thinking details',
  };
  return { values };
});
const announce = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Platform: platform,
  Pressable: 'Pressable',
  TextInput: 'TextInput',
  View: 'View',
}));
vi.mock('react-i18next', () => {
  // One stable `t` per language, like the real hook: the index memo must not
  // rebuild on a keystroke because the translator identity changed.
  const t = (key: string, options?: Readonly<{ resultCount?: number }>) => {
    if (key.startsWith('settingsSearch.keywords.')) {
      lookups.keyword[key] = (lookups.keyword[key] ?? 0) + 1;
    }
    const value = copy.values[key] ?? key;
    return options?.resultCount === undefined
      ? value
      : value.replace('{{resultCount}}', String(options.resultCount));
  };
  return {
    useTranslation: () => ({ t, i18n: { resolvedLanguage: 'en', language: 'en' } }),
  };
});
// The real matcher is used here: it is pure, and this suite must prove the
// index contract (label/context/keyword lookup, label-only ranges) against it.
// `cn` only joins class names; importing the real utilities module would pull
// the app's i18n instance and every catalog into this suite.
vi.mock('@/lib/utils', () => ({
  cn: (...classes: string[]) => classes.join(' '),
}));
vi.mock('@/components/ui/search-field', () => ({
  SearchField: (props: Record<string, unknown>) => createElement('SearchField', props),
}));
vi.mock('@/components/ui/row-frame', () => ({
  RowFrame: (props: Record<string, unknown>) => createElement('RowFrame', props),
}));
vi.mock('@/components/ui/row-group', () => ({
  RowGroup: (props: Record<string, unknown>) => createElement('RowGroup', props),
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({ SearchX: 'SearchX' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/lib/a11y/status-announcement', () => ({ useStatusAnnouncement: announce }));
vi.mock('@/lib/font-scale/system-font-scale-context', () => ({
  useIsLargeFontScale: () => false,
}));

const SOURCES: readonly SettingsSearchSource[] = [
  {
    context: ['preferences.appearance'],
    settings: [
      defineSetting('appearance.system', 'preferences.appearanceSystem', 'appearance'),
      defineSetting('appearance.dark', 'preferences.appearanceDark'),
      defineSetting('language', 'common.language'),
    ],
  },
  {
    settings: [
      defineSetting('privacy.analytics', 'consent.helpImprove', 'privacy'),
      { id: 'hidden', label: 'preferences.hideThinking', available: false },
    ],
  },
];

let renderer: ReactTestRenderer | undefined = undefined;

function Harness({
  sources,
  onSelect,
}: Readonly<{ sources: readonly SettingsSearchSource[]; onSelect: (entry: object) => void }>) {
  const search = useSettingsSearch(sources);
  return createElement(
    'View',
    null,
    createElement(SettingsSearchField, {
      query: search.query,
      onChangeText: search.setQuery,
      inputRef: search.inputRef,
    }),
    createElement('Pressable', { testID: 'clear', onPress: search.clear }),
    search.active
      ? createElement(SettingsSearchResults, { results: search.results, onSelect })
      : null
  );
}

function render(onSelect: (entry: object) => void = () => undefined) {
  act(() => {
    renderer = TestRenderer.create(createElement(Harness, { sources: SOURCES, onSelect }));
  });
  if (renderer === undefined) {
    throw new Error('Missing renderer');
  }
  return renderer.root;
}

function typeQuery(root: ReactTestInstance, text: string) {
  const field = root.findByType('SearchField');
  act(() => {
    (field.props.onChangeText as (next: string) => void)(text);
  });
}

function rows(root: ReactTestInstance) {
  return root.findAll(node => Object.is(node.type, 'RowFrame'));
}

beforeEach(() => {
  vi.useFakeTimers();
  platform.OS = 'ios';
  announce.mockReset();
  lookups.keyword = {};
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
});

describe('useSettingsSearch with SettingsSearchField/Results', () => {
  it('starts idle with the shared search field and no result body', () => {
    const root = render();
    const field = root.findByType('SearchField');

    expect(field.props.placeholder).toBe('Search settings');
    expect(field.props.hasText).toBe(false);
    expect(field.props.returnKeyType).toBe('search');
    expect(field.props.autoCorrect).toBe(false);
    expect(field.props.className).toContain('mx-4');
    expect(rows(root)).toEqual([]);
  });

  it('indexes labels through t() and bolds only the matched label range', () => {
    const root = render();
    typeQuery(root, 'dark');

    const [row] = rows(root);
    expect(row?.props.accessibilityLabel).toBe('Dark');
    expect(row?.props.accessibilityHint).toBe('Appearance');
    const bold = row?.findAll(
      node => Object.is(node.type, 'Text') && String(node.props.className).includes('font-semibold')
    );
    expect(bold).toHaveLength(1);
    expect(bold?.[0]?.props.children).toBe('Dark');
    const breadcrumb = row?.findAll(
      node => Object.is(node.type, 'Text') && node.props.children === 'Appearance'
    );
    expect(breadcrumb).toHaveLength(1);
  });

  it('matches a localized keyword and keeps the label plain', () => {
    const root = render();
    typeQuery(root, 'theme');

    const [row] = rows(root);
    expect(row?.props.accessibilityLabel).toBe('System');
    const bold = root.findAll(
      node => Object.is(node.type, 'Text') && String(node.props.className).includes('font-semibold')
    );
    expect(bold).toEqual([]);
  });

  it('resolves each keyword catalog entry once per index, not per keystroke', () => {
    const root = render();
    typeQuery(root, 't');
    typeQuery(root, 'th');

    expect(lookups.keyword['settingsSearch.keywords.appearance']).toBe(1);
    expect(lookups.keyword['settingsSearch.keywords.privacy']).toBe(1);
  });

  it('matches the localized breadcrumb and every row under it', () => {
    const root = render();
    typeQuery(root, 'appearance');

    expect(rows(root)).toHaveLength(3);
  });

  it('drops an unavailable definition from the index', () => {
    const root = render();
    typeQuery(root, 'thinking');

    expect(rows(root)).toEqual([]);
    const empty = root.findByType('EmptyState');
    expect(empty.props.title).toBe('No matching settings');
    expect(empty.props.description).toBe('Try a different setting name or keyword.');
  });

  it('announces one settled result count on iOS', () => {
    const root = render();
    typeQuery(root, 'appearance');
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(announce).toHaveBeenLastCalledWith('Settings found: 3');
    const live = root.findAll(
      node => Object.is(node.type, 'Text') && node.props.children === 'Settings found: 3'
    );
    expect(live[0]?.props.accessibilityLiveRegion).toBeUndefined();
  });

  it('renders the Android polite live region instead', () => {
    platform.OS = 'android';
    const root = render();
    typeQuery(root, 'appearance');
    act(() => {
      vi.advanceTimersByTime(500);
    });

    const live = root.findAll(
      node => Object.is(node.type, 'Text') && node.props.children === 'Settings found: 3'
    );
    expect(live[0]?.props.accessibilityLiveRegion).toBe('polite');
  });

  it('clears the query and the native field together', () => {
    const root = render();
    typeQuery(root, 'dark');
    act(() => {
      (root.findByProps({ testID: 'clear' }).props.onPress as () => void)();
    });

    const field = root.findByType('SearchField');
    expect(field.props.hasText).toBe(false);
    expect(rows(root)).toEqual([]);
  });

  it('selects a result with its localized entry', () => {
    const selected: object[] = [];
    const root = render(entry => {
      selected.push(entry);
    });
    typeQuery(root, 'tracking');
    const [row] = rows(root);
    act(() => {
      (row?.props.onPress as (() => void) | undefined)?.();
    });

    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({ id: 'privacy.analytics', label: 'Help improve Kilo' });
  });
});
