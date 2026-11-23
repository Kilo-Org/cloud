import { createElement, Fragment } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';
import { i18n } from '@/i18n';
import { TAB_SCREEN_TRAILING_GAP } from '@/components/tab-screen';
import { type DenyListModel, denyListRowNote } from '@/lib/organization/model-access';

import { ModelDenyList, ProviderAllowList } from './model-access-lists';

// FlashList renders through callbacks, so a host-string mock would drop both the
// rows and the empty state. This mock mirrors the real list: the header always,
// the rows through `renderItem`, and the empty component only when data is empty.
// The two style props are forwarded so a test reads the frame and content
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
// The lists draw the tab-screen frame, so its own logic runs: only the pieces
// it reads from outside are fixed, the tab bar's height and the keyboard.
const frame = vi.hoisted(() => ({ tabBarHeight: 56, keyboardHeight: 300 }));
const keyboard = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    height: 0,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setHeight: (height: number) => {
      keyboard.height = height;
      for (const listener of listeners) {
        listener();
      }
    },
  };
});
vi.mock('react-native-keyboard-controller', async () => {
  // `vi.mock` factories are hoisted above the file's static imports, so `react`
  // must be pulled in here.
  const React = await import('react');
  const heightOf = () => keyboard.height;
  return {
    useKeyboardState: (selector?: (snapshot: Record<string, unknown>) => unknown) => {
      const height = React.useSyncExternalStore(keyboard.subscribe, heightOf, heightOf);
      const snapshot = { height, isVisible: height > 0, progress: height > 0 ? 1 : 0, duration: 0 };
      return selector ? selector(snapshot) : snapshot;
    },
  };
});
// The tabs layout publishes the rendered bar height; this suite fixes it so the
// frame's reserve is a number a test can name.
vi.mock('@/lib/tab-bar-clearance', () => ({
  useEffectiveTabBarHeight: () => frame.tabBarHeight,
}));
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

/** The props every mount shares: an empty draft, enabled rows, a no-op save. */
const LIST_PROPS = { draft: DRAFT, onChange: () => undefined, disabled: false };

let renderer: ReactTestRenderer | undefined = undefined;

async function mount(providers: readonly string[], names: Readonly<Record<string, string>> = {}) {
  const view = await renderWithProviders(
    createElement(ProviderAllowList, { ...LIST_PROPS, providers, names })
  );
  renderer = view.renderer;
  return view.renderer.root;
}

const DENY_MODELS = [{ id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4' }];

/** The deny list alone, over the rows a case names. */
async function mountDenyList(models: readonly DenyListModel[]) {
  const view = await renderWithProviders(createElement(ModelDenyList, { ...LIST_PROPS, models }));
  renderer = view.renderer;
  return view.renderer.root;
}

/** Both lists of the Providers and models tab, as the form renders them. */
async function mountBothLists() {
  const view = await renderWithProviders(
    createElement(
      Fragment,
      null,
      createElement(ProviderAllowList, { ...LIST_PROPS, providers: ['anthropic'], names: {} }),
      createElement(ModelDenyList, { ...LIST_PROPS, models: DENY_MODELS })
    )
  );
  renderer = view.renderer;
  return view.renderer.root;
}

/**
 * Each list's frame wrapper: the `View` host node the list renders inside, in
 * the order the two lists render. The mocked FlashList component sits between
 * the list node and that host node, so the walk skips it.
 */
function listFrames(root: ReactTestRenderer['root']) {
  return root
    .findAll(node => Object.is(node.type, 'FlashList'))
    .map(list => {
      for (let node = list.parent; node; node = node.parent) {
        if (Object.is(node.type, 'View')) {
          return node;
        }
      }
      throw new Error('the list renders outside its frame');
    });
}

/** The margin each list's frame reserves at the window's bottom edge. */
function frameMargins(root: ReactTestRenderer['root']) {
  return listFrames(root).map(node => {
    const style: unknown = node.props.style;
    if (typeof style !== 'object' || style === null || !('marginBottom' in style)) {
      return undefined;
    }
    const { marginBottom } = style;
    return typeof marginBottom === 'number' ? marginBottom : undefined;
  });
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

/** Each rendered row's note, in order, which `rows` leaves out on purpose. */
function rowNotes(root: ReactTestRenderer['root']) {
  return root
    .findAll(node => Object.is(node.type, 'PreferenceRow'))
    .map(node => node.props.note as unknown);
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  // The keyboard store outlives one mount; every case starts with it down.
  keyboard.setHeight(0);
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

describe('ModelDenyList rows', () => {
  it('titles a model whose name equals its id without repeating it', async () => {
    const root = await mountDenyList([
      { id: 'fixture-anthropic/model', name: 'fixture-anthropic/model' },
    ]);

    expect(rows(root)).toEqual([{ title: 'fixture-anthropic/model', subtitle: undefined }]);
  });

  it('draws the id as the second line when the name says something else', async () => {
    const root = await mountDenyList([{ id: 'fake-deterministic', name: 'Fake Deterministic' }]);

    expect(rows(root)).toEqual([{ title: 'Fake Deterministic', subtitle: 'fake-deterministic' }]);
  });

  it('keeps the retirement note of a row whose name equals its id', async () => {
    const model = {
      id: 'fixture-anthropic/model',
      name: 'fixture-anthropic/model',
      retiresOn: '2026-11-20',
    };
    const root = await mountDenyList([model]);

    // The note is a fact of its own, so dropping the duplicate subtitle must
    // not cost the row its retirement date.
    expect(rows(root)).toEqual([{ title: 'fixture-anthropic/model', subtitle: undefined }]);
    expect(rowNotes(root)).toEqual([denyListRowNote(model, i18n.t)]);
  });
});

// A filtered result's empty state is centred in the list's viewport, so the
// viewport must end above the software keyboard. The frame reserves the IME
// band while the keyboard is up, and the tab-bar band — which hides with the
// keyboard — while it is down.
describe('Model access lists keyboard frame', () => {
  it('reserves the tab-bar band in both list frames while the keyboard is down', async () => {
    const root = await mountBothLists();

    expect(listFrames(root)).toHaveLength(2);
    expect(frameMargins(root)).toEqual([frame.tabBarHeight, frame.tabBarHeight]);
  });

  it('replaces the tab-bar band with the keyboard band in both list frames', async () => {
    await mountBothLists();

    act(() => {
      keyboard.setHeight(frame.keyboardHeight);
    });

    // Re-read the mounted tree after the keyboard landed.
    const live = renderer?.root;
    if (!live) {
      throw new Error('renderer is not mounted');
    }
    expect(frameMargins(live)).toEqual([frame.keyboardHeight, frame.keyboardHeight]);
    // The bar hides with the keyboard, so its band is replaced, never stacked.
    expect(frameMargins(live)).not.toContain(frame.tabBarHeight);
  });

  it('keeps the trailing gap on the list content and grows it to the viewport', async () => {
    const root = await mountBothLists();

    expect(listContentStyles(root)).toEqual([
      { flexGrow: 1, paddingBottom: TAB_SCREEN_TRAILING_GAP },
      { flexGrow: 1, paddingBottom: TAB_SCREEN_TRAILING_GAP },
    ]);
    // The band lives on the frame alone; leaving it on the content as well
    // would double the reserve.
    expect(listContentStyles(root)).not.toContainEqual({
      flexGrow: 1,
      paddingBottom: frame.tabBarHeight + TAB_SCREEN_TRAILING_GAP,
    });
  });
});
