import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer, type ReactTestInstance, type ReactTestRenderer } from '@/test/renderer';

import { defineSetting, type SettingsSearchSource } from '@/lib/settings-search/definitions';
import {
  SettingsSearchField,
  SettingsSearchResults,
  useSettingsSearch,
} from './settings-search';

const platform = vi.hoisted(() => ({ OS: 'ios' }));
const copy = vi.hoisted(() => ({
  values: {
    'settingsSearch.placeholder': 'Search settings',
    'settingsSearch.noMatches': 'No matching settings',
    'settingsSearch.emptyDescription': 'Try a different setting name or keyword.',
    'settingsSearch.resultsStatus': 'Settings found: {{resultCount}}',
    'settingsSearch.keywords.appearance': 'theme|color scheme',
    'settingsSearch.keywords.privacy': 'analytics|tracking',
    'profile.appearance': 'Appearance',
    'profile.themeSystem': 'System',
    'profile.themeDark': 'Dark',
    'profile.language': 'Language',
    'profile.privacyAnalytics': 'Share analytics',
    'profile.hidden': 'Hidden setting',
  } as Record<string, string>,
}));
const announce = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Platform: platform,
  Pressable: 'Pressable',
  TextInput: 'TextInput',
  View: 'View',
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Readonly<{ resultCount?: number }>) => {
      const value = copy.values[key] ?? key;
      return options?.resultCount === undefined
        ? value
        : value.replace('{{resultCount}}', String(options.resultCount));
    },
    i18n: { resolvedLanguage: 'en', language: 'en' },
  }),
}));
// The real matcher is owned by another slice; this double keeps the hook's
// index contract (label/context/keyword lookup, label-only ranges).
vi.mock('@/lib/settings-search/match', () => ({
  searchSettings: (
    entries: readonly {
      label: string;
      context?: string;
      keywords?: readonly string[];
    }[],
    query: string
  ) => {
    const needle = query.trim().toLocaleLowerCase('en');
    if (needle === '') {
      return [];
    }
    const found = [];
    for (const entry of entries) {
      const fields = [entry.label, entry.context, ...(entry.keywords ?? [])];
      const matches = fields.some(
        field => typeof field === 'string' && field.toLocaleLowerCase('en').includes(needle)
      );
      if (!matches) {
        continue;
      }
      const at = entry.label.toLocaleLowerCase('en').indexOf(needle);
      found.push({ entry, ranges: at < 0 ? [] : [{ start: at, end: at + needle.length }] });
    }
    return found;
  },
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
    context: ['profile.appearance'],
    settings: [
      defineSetting('appearance.system', 'profile.themeSystem', 'appearance'),
      defineSetting('appearance.dark', 'profile.themeDark'),
      defineSetting('language', 'profile.language'),
    ],
  },
  {
    settings: [
      defineSetting('privacy.analytics', 'profile.privacyAnalytics', 'privacy'),
      { id: 'hidden', label: 'profile.hidden', available: false },
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

  it('matches the localized breadcrumb and every row under it', () => {
    const root = render();
    typeQuery(root, 'appearance');

    expect(rows(root)).toHaveLength(3);
  });

  it('drops an unavailable definition from the index', () => {
    const root = render();
    typeQuery(root, 'hidden');

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
      (row?.props.onPress as () => void)();
    });

    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({ id: 'privacy.analytics', label: 'Share analytics' });
  });
});
