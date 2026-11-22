import { createElement, Fragment } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';
import { i18n } from '@/i18n';
import { TAB_SCREEN_TRAILING_GAP } from '@/components/tab-screen';

import { ModelDenyList, ProviderAllowList } from './model-access-lists';

// FlashList renders through callbacks, so a host-string mock would drop both the
// rows and the empty state. This mock mirrors the real list: the header always,
// the rows through `renderItem`, and the empty component only when data is empty.
// The two style props are forwarded so a test reads the style and content
// reservations the component sets.
vi.mock('@shopify/flash-list', async () => {
  // `vi.mock` factories hoist above this file's imports, so `react` is loaded
  // from inside the factory; a static import would not be defined yet.
  const React = await import('react');
  return {
    FlashList: (props: {
      data: readonly unknown[];
      renderItem?: (info: { item: unknown; index: number }) => React.ReactNode;
      ListHeaderComponent?: React.ReactNode;
      ListEmptyComponent?: React.ReactNode;
      style?: unknown;
      contentContainerStyle?: unknown;
    }) =>
      React.createElement(
        'FlashList',
        { style: props.style, contentContainerStyle: props.contentContainerStyle },
        props.ListHeaderComponent,
        ...props.data.map((item, index) => props.renderItem?.({ item, index })),
        props.data.length === 0 ? props.ListEmptyComponent : null
      ),
  };
});
vi.mock('react-native', () => ({ View: 'View' }));
// The lists keep only the tab screen's trailing gap. The pinned footer above
// them owns the bottom band, so no tab-bar clearance is involved.
vi.mock('@/components/tab-screen', () => ({ TAB_SCREEN_TRAILING_GAP: 16 }));
// The window's side insets are the platform's, not this suite's subject.
vi.mock('@/lib/screen-insets', () => ({ useSideInsetMarginStyle: () => undefined }));
// The search field is driven through its own `onChangeText`, the query the
// component keeps in state; the field's own layout has its own suite.
vi.mock('@/components/ui/search-field', () => ({ SearchField: 'SearchField' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/filter-chip', () => ({ FilterChip: 'FilterChip' }));
vi.mock('@/components/ui/icons', () => ({ SearchX: 'SearchX' }));
vi.mock('@/components/ui/preference-row', () => ({ PreferenceRow: 'PreferenceRow' }));
vi.mock('@/components/ui/row-group', () => ({
  RowGroupItem: 'RowGroupItem',
  rowGroupPosition: () => 'only',
}));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
// The no-match state nests a surface so it can drop the reserve the screen's
// surface carries; the host string keeps that prop readable in the tree.
vi.mock('@/components/centered-state-surface', () => ({ StateSurface: 'StateSurface' }));

const DRAFT = { providerAllowList: [], modelDenyList: [] };

let renderer: ReactTestRenderer | undefined = undefined;

async function mount(providers: readonly string[], names: Readonly<Record<string, string>> = {}) {
  const view = await renderWithProviders(
    createElement(ProviderAllowList, {
      providers,
      names,
      draft: DRAFT,
      onChange: () => undefined,
      disabled: false,
    })
  );
  renderer = view.renderer;
  return view.renderer.root;
}

const DENY_MODELS = [{ id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4' }];

/** Both lists of the Providers and models tab, as the form renders them. */
async function mountBothLists() {
  const view = await renderWithProviders(
    createElement(
      Fragment,
      null,
      createElement(ProviderAllowList, {
        providers: ['anthropic'],
        names: {},
        draft: DRAFT,
        onChange: () => undefined,
        disabled: false,
      }),
      createElement(ModelDenyList, {
        models: DENY_MODELS,
        draft: DRAFT,
        onChange: () => undefined,
        disabled: false,
      })
    )
  );
  renderer = view.renderer;
  return view.renderer.root;
}

/** The content-container style each list sets on its rows. */
function listContentStyles(root: ReactTestRenderer['root']) {
  return root
    .findAll(node => Object.is(node.type, 'FlashList'))
    .map(node => node.props.contentContainerStyle);
}

function typeQuery(root: ReactTestRenderer['root'], text: string) {
  const [field] = root.findAll(node => Object.is(node.type, 'SearchField'));
  if (!field) {
    throw new Error('missing provider search field');
  }
  act(() => {
    (field.props.onChangeText as (next: string) => void)(text);
  });
}

/** The rendered empty-state title, or `undefined` when the rows show instead. */
function emptyLabel(root: ReactTestRenderer['root']): unknown {
  const [state] = root.findAll(node => Object.is(node.type, 'EmptyState'));
  return state?.props.title;
}

/** Each rendered row's title and subtitle, in order. */
function rows(root: ReactTestRenderer['root']) {
  return root
    .findAll(node => Object.is(node.type, 'PreferenceRow'))
    .map(node => ({
      title: node.props.title as unknown,
      subtitle: node.props.subtitle as unknown,
    }));
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('ProviderAllowList empty state', () => {
  it('shows the intro line and the no-providers state, with nothing to search or act on', async () => {
    const root = await mount([]);
    const copy = root
      .findAll(node => Object.is(node.type, 'Text'))
      .map(node => node.props.children);

    expect(emptyLabel(root)).toBe('No providers are available for this organization.');
    // The intro line stays: it says what the tab's list would be.
    expect(copy).toContain(i18n.t('organizationModelAccess.providersDescription'));
    expect(root.findAll(node => Object.is(node.type, 'SearchField'))).toHaveLength(0);
    expect(copy).not.toContain(i18n.t('organizationModelAccess.allowAllShown'));
    expect(copy).not.toContain(i18n.t('organizationModelAccess.denyAllShown'));
  });

  it('keeps every row for a query of only whitespace', async () => {
    const root = await mount(['anthropic', 'openai']);

    typeQuery(root, '   ');

    expect(emptyLabel(root)).toBeUndefined();
    expect(rows(root)).toHaveLength(2);
  });

  it('says the search matched nothing while keeping the search field and both bulk actions', async () => {
    const root = await mount(['anthropic']);

    typeQuery(root, 'zzz');

    expect(emptyLabel(root)).toBe('No providers match this search.');
    expect(root.findAll(node => Object.is(node.type, 'SearchField'))).toHaveLength(1);
    // The no-match state keeps its way out: clearing the query brings the rows
    // back, and the bulk actions still apply to whatever the query keeps.
    const copy = root
      .findAll(node => Object.is(node.type, 'Text'))
      .map(node => node.props.children);
    expect(copy).toContain(i18n.t('organizationModelAccess.allowAllShown'));
    expect(copy).toContain(i18n.t('organizationModelAccess.denyAllShown'));
  });

  it('brings the rows back when the query is cleared', async () => {
    const root = await mount(['anthropic', 'openai']);
    expect(emptyLabel(root)).toBeUndefined();

    typeQuery(root, 'zzz');
    expect(emptyLabel(root)).toBe('No providers match this search.');

    typeQuery(root, '');
    expect(emptyLabel(root)).toBeUndefined();
    expect(rows(root)).toHaveLength(2);
  });

  it('renders the provider rows, not an empty state, when providers are available', async () => {
    const root = await mount(['anthropic']);

    expect(emptyLabel(root)).toBeUndefined();
    expect(rows(root)).toEqual([{ title: 'anthropic', subtitle: undefined }]);
  });
});

describe('ProviderAllowList rows', () => {
  it('titles a named row with its display name and draws no second line', async () => {
    const root = await mount(['anthropic', 'openrouter'], { openrouter: 'OpenRouter Gateway' });

    expect(rows(root)).toEqual([
      { title: 'anthropic', subtitle: undefined },
      { title: 'OpenRouter Gateway', subtitle: undefined },
    ]);
  });

  it('keeps the slug as the title when the answer carries an empty name', async () => {
    const root = await mount(['anthropic'], { anthropic: '' });

    // A blank title reads as a broken row, so an empty name is treated like a
    // missing one.
    expect(rows(root)).toEqual([{ title: 'anthropic', subtitle: undefined }]);
  });

  it('finds a row by its display name', async () => {
    const root = await mount(['anthropic', 'openrouter'], { openrouter: 'Aggregator' });

    typeQuery(root, 'aggreg');

    expect(rows(root)).toEqual([{ title: 'Aggregator', subtitle: undefined }]);
  });

  it('still finds a row by its slug', async () => {
    const root = await mount(['anthropic', 'openrouter'], { openrouter: 'Aggregator' });

    typeQuery(root, 'router');

    expect(rows(root)).toEqual([{ title: 'Aggregator', subtitle: undefined }]);
  });
});

// The pinned footer above the lists owns the bottom band, so each list's content
// keeps only the trailing gap and grows to the viewport: a centred empty state
// then takes the band the list shows instead of its own height below the header.
describe('Model access list content', () => {
  it('keeps the trailing gap on both lists and grows them to the viewport', async () => {
    const root = await mountBothLists();

    expect(listContentStyles(root)).toEqual([
      { flexGrow: 1, paddingBottom: TAB_SCREEN_TRAILING_GAP },
      { flexGrow: 1, paddingBottom: TAB_SCREEN_TRAILING_GAP },
    ]);
  });
});
