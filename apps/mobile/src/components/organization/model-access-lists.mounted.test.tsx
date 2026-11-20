import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';
import { i18n } from '@/i18n';

import { ProviderAllowList } from './model-access-lists';

// FlashList renders through callbacks, so a host-string mock would drop both the
// rows and the empty state. This mock mirrors the real list: the header always,
// the rows through `renderItem`, and the empty component only when data is empty.
vi.mock('@shopify/flash-list', async () => {
  // `vi.mock` factories hoist above this file's imports, so `react` is loaded
  // from inside the factory; a static import would not be defined yet.
  const React = await import('react');
  return {
    FlashList: (props: {
      data: readonly string[];
      renderItem?: (info: { item: string; index: number }) => React.ReactNode;
      ListHeaderComponent?: React.ReactNode;
      ListEmptyComponent?: React.ReactNode;
    }) =>
      React.createElement(
        'FlashList',
        null,
        props.ListHeaderComponent,
        ...props.data.map((item, index) => props.renderItem?.({ item, index })),
        props.data.length === 0 ? props.ListEmptyComponent : null
      ),
  };
});
vi.mock('react-native', () => ({ View: 'View' }));
// The frame's tab-bar clearance needs the tabs layout; these lists only use it
// as bottom padding, which no assertion here reads.
vi.mock('@/components/tab-screen', () => ({ useTabBarBottomPadding: () => 0 }));
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

const DRAFT = { providerAllowList: [], modelDenyList: [] };

let renderer: ReactTestRenderer | undefined = undefined;

async function mount(providers: readonly string[]) {
  const view = await renderWithProviders(
    createElement(ProviderAllowList, {
      providers,
      draft: DRAFT,
      onChange: () => undefined,
      disabled: false,
    })
  );
  renderer = view.renderer;
  return view.renderer.root;
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

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('ProviderAllowList empty state', () => {
  it('says the organization has no providers when the catalog is empty', async () => {
    const root = await mount([]);

    expect(emptyLabel(root)).toBe('No providers are available for this organization.');
  });

  it('keeps the no-providers copy for a query of only whitespace', async () => {
    const root = await mount([]);

    typeQuery(root, '   ');

    expect(emptyLabel(root)).toBe('No providers are available for this organization.');
  });

  it('says the search matched nothing when a query filters the catalog out', async () => {
    const root = await mount([]);

    typeQuery(root, 'zzz');

    expect(emptyLabel(root)).toBe('No providers match this search.');
  });

  it('says the search matched nothing when a query filters every row out', async () => {
    const root = await mount(['anthropic']);

    typeQuery(root, 'zzz');

    expect(emptyLabel(root)).toBe('No providers match this search.');
  });

  it('renders the provider rows, not an empty state, when providers are available', async () => {
    const root = await mount(['anthropic']);

    expect(emptyLabel(root)).toBeUndefined();
    expect(
      root.findAll(node => Object.is(node.type, 'PreferenceRow')).map(node => node.props.title)
    ).toEqual(['anthropic']);
  });

  it('renders the catalog copy, then the search copy once a query is typed', async () => {
    const root = await mount([]);
    expect(emptyLabel(root)).toBe(i18n.t('organizationModelAccess.providersNone'));

    typeQuery(root, 'zzz');
    expect(emptyLabel(root)).toBe('No providers match this search.');

    typeQuery(root, '');
    expect(emptyLabel(root)).toBe('No providers are available for this organization.');
  });
});
