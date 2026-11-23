import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, type ReactTestInstance, type ReactTestRenderer, TestRenderer } from '@/test/renderer';

import { defineSetting, type SettingsSearchSource } from '@/lib/settings-search/definitions';
import { PREFERENCE_SETTINGS_SOURCES } from '@/lib/settings-search/preference-sources';
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
    'common.preferences': 'Preferences',
    'preferences.appearance': 'Appearance',
    'preferences.appearanceSystem': 'System',
    'preferences.appearanceLight': 'Light',
    'preferences.appearanceDark': 'Dark',
    'common.language': 'Language',
    'consent.helpImprove': 'Help improve Kilo',
    'preferences.hideThinking': 'Hide thinking details',
  };
  // The two keyword concepts this suite indexes; the real catalog holds six.
  const keywords: Record<string, readonly string[]> = {
    'settingsSearch.keywords.appearance': ['theme', 'color scheme'],
    'settingsSearch.keywords.privacy': ['analytics', 'tracking'],
  };
  return { values, keywords };
});
const announce = vi.hoisted(() => vi.fn());

type MockOptions = Readonly<{ resultCount?: number; returnObjects?: boolean }>;

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
  const t = (key: string, options?: MockOptions) => {
    if (key.startsWith('settingsSearch.keywords.')) {
      lookups.keyword[key] = (lookups.keyword[key] ?? 0) + 1;
      return options?.returnObjects === true ? (copy.keywords[key] ?? key) : key;
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
    context: ['common.preferences'],
    settings: [
      defineSetting('appearance', 'preferences.appearance', 'appearance'),
      defineSetting('language', 'common.language'),
    ],
  },
  {
    context: ['common.preferences', 'preferences.appearance'],
    settings: [
      defineSetting('appearance.system', 'preferences.appearanceSystem'),
      defineSetting('appearance.dark', 'preferences.appearanceDark'),
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

function render(
  onSelect: (entry: object) => void = () => undefined,
  sources: readonly SettingsSearchSource[] = SOURCES
) {
  act(() => {
    renderer = TestRenderer.create(createElement(Harness, { sources, onSelect }));
  });
  if (renderer === undefined) {
    throw new Error('Missing renderer');
  }
  return renderer.root;
}

function typeQuery(root: ReactTestInstance, text: string) {
  act(() => {
    (root.findByType('SearchField').props.onChangeText as (next: string) => void)(text);
  });
}

const rows = (root: ReactTestInstance) => root.findAll(node => Object.is(node.type, 'RowFrame'));

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

  it('indexes labels through t() and marks only the matched label range', () => {
    const root = render();
    typeQuery(root, 'dark');

    const [row] = rows(root);
    expect(row?.props.accessibilityLabel).toBe('Dark');
    expect(row?.props.accessibilityHint).toBe('Preferences · Appearance');
    const label = row?.findAll(
      node => Object.is(node.type, 'Text') && String(node.props.className).includes('font-medium')
    )[0];
    expect(label?.props.className).toContain('text-foreground');
    expect(label?.props.className).not.toContain('text-muted-foreground');
    expect(label?.props.numberOfLines).toBe(1);
    const marked = row?.findAll(
      node => Object.is(node.type, 'Text') && String(node.props.className).includes('font-semibold')
    );
    expect(marked).toHaveLength(1);
    expect(marked?.[0]?.props.className).toContain('underline');
    expect(marked?.[0]?.props.className).toContain('text-foreground');
    expect(marked?.[0]?.props.className).not.toContain('text-muted-foreground');
    expect(marked?.[0]?.props.children).toBe('Dark');
    const breadcrumb = row?.findAll(
      node => Object.is(node.type, 'Text') && node.props.children === 'Preferences · Appearance'
    );
    expect(breadcrumb).toHaveLength(1);
  });

  it('underlines only the matched substring while the whole title stays full strength', () => {
    const root = render();
    typeQuery(root, 'sys');

    const [row] = rows(root);
    expect(row?.props.accessibilityLabel).toBe('System');
    const marked = row?.findAll(
      node => Object.is(node.type, 'Text') && String(node.props.className).includes('font-semibold')
    );
    expect(marked).toHaveLength(1);
    expect(marked?.[0]?.props.children).toBe('Sys');
    expect(marked?.[0]?.props.className).toContain('underline');
    const title = marked?.[0]?.parent;
    expect(title?.children).toHaveLength(2);
    expect(title?.children[1]).toBe('tem');
    expect(title?.props.className).toContain('text-foreground');
  });

  it('keeps the theme synonym on the Appearance group only', () => {
    const root = render();
    typeQuery(root, 'theme');

    const themedRows = rows(root);
    expect(themedRows).toHaveLength(1);
    expect(themedRows[0]?.props.accessibilityLabel).toBe('Appearance');
    const marked = root.findAll(
      node => Object.is(node.type, 'Text') && String(node.props.className).includes('font-semibold')
    );
    expect(marked).toEqual([]);
  });

  it('finds one themed result and all three options by name in the real hub index', () => {
    const root = render(() => undefined, PREFERENCE_SETTINGS_SOURCES);
    typeQuery(root, 'theme');
    expect(rows(root).map(row => row.props.accessibilityLabel)).toEqual(['Appearance']);

    typeQuery(root, 'appearance');
    const appearanceRows = rows(root);
    expect(appearanceRows.map(row => row.props.accessibilityLabel)).toEqual([
      'Appearance',
      'System',
      'Light',
      'Dark',
    ]);
    const optionRows = appearanceRows.filter(
      appearanceRow => appearanceRow.props.accessibilityLabel !== 'Appearance'
    );
    expect(optionRows).toHaveLength(3);
    expect(optionRows.map(appearanceRow => appearanceRow.props.accessibilityHint)).toEqual([
      'Preferences · Appearance',
      'Preferences · Appearance',
      'Preferences · Appearance',
    ]);
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
