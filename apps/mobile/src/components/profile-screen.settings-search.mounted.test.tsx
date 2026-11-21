import { beforeEach, describe, expect, it, vi } from 'vitest';

// The mock harness registers every product-module mock before the screen loads.
import {
  findConfigureRows,
  mountProfile,
  providersQueryFn,
  routerPush,
  signOutFn,
} from '@/components/profile-screen.test-helpers';
import { SettingsTarget } from '@/components/settings-search/settings-target';
import { i18n } from '@/i18n';
import { act, type ReactTestInstance } from '@/test/renderer';

// Root search runs through the real hook (index, folding, ranking), the real
// target reveal wiring and the real route build; the two presentational pieces
// are the surface's own contract and are covered by its suite. Keeping them as
// markers lets this spec compare what the screen renders with what the index
// answers.
vi.mock('@/components/settings-search/settings-search', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '@/components/settings-search/settings-search'
  );
  return {
    ...actual,
    SettingsSearchField: 'SettingsSearchField',
    SettingsSearchResults: 'SettingsSearchResults',
  };
});

type SearchResult = {
  entry: { id: string; label: string; path?: string; params?: Readonly<Record<string, string>> };
};

function byType(root: ReactTestInstance, type: string): ReactTestInstance[] {
  return root.findAll(node => node.type === type);
}

function renderedRowTitles(root: ReactTestInstance): string[] {
  return byType(root, 'ConfigureRow').map(row => String(row.props.title));
}

function query(root: ReactTestInstance, text: string) {
  const [node] = byType(root, 'SettingsSearchField');
  if (!node) {
    throw new Error('search field is not rendered');
  }
  act(() => {
    node.props.onChangeText(text);
  });
}

function results(root: ReactTestInstance): readonly SearchResult[] {
  const [node] = byType(root, 'SettingsSearchResults');
  if (!node) {
    return [];
  }
  const value: readonly SearchResult[] = node.props.results;
  return value;
}

/** The stationary highlight each active target paints over its row. */
function targetHighlights(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAll(
    node => node.type === 'View' && String(node.props.className ?? '').includes('border-primary')
  );
}

/**
 * The Settings search index has to describe the rows the screen really renders:
 * every permanent row is searchable, the index never offers a row that is not on
 * screen, and a root result only ever highlights its control.
 */
describe('ProfileScreen settings search', () => {
  beforeEach(() => {
    routerPush.mockClear();
    signOutFn.mockClear();
    // Linked providers are account data, not settings: the section stays hidden
    // so the coverage assertion can speak about permanent rows alone.
    providersQueryFn.mockResolvedValue([]);
  });

  it('finds every rendered root row and no row that is not rendered', async () => {
    const view = await mountProfile();
    const root = view.renderer.root;
    const titles = renderedRowTitles(root);
    expect(titles.length).toBeGreaterThan(0);

    for (const title of titles) {
      query(root, title);
      const rootResults = results(root).filter(result => result.entry.path === undefined);
      expect(
        rootResults.some(result => result.entry.label === title),
        `"${title}" renders but the index does not find it`
      ).toBe(true);
    }

    // Every root index entry is backed by a rendered row: an indexed row that
    // is not on the screen would offer a dead control.
    query(root, '');
    expect(results(root)).toEqual([]);
    const targetItems = root
      .findAll(node => node.type === SettingsTarget)
      .map(node => {
        const item: { id: string; label: string } = node.props.item;
        return item;
      });
    expect(new Set(targetItems.map(item => item.id)).size).toBe(new Set(titles).size);
    for (const item of targetItems) {
      expect(titles).toContain(i18n.t(item.label));
    }
    expect(renderedRowTitles(root)).toEqual(titles);
  });

  it('highlights the sign-out row without signing out', async () => {
    const view = await mountProfile();
    const root = view.renderer.root;
    const signOutLabel = i18n.t('common.signOut');
    expect(findConfigureRows(root, signOutLabel)).toHaveLength(1);
    expect(targetHighlights(root)).toEqual([]);

    query(root, signOutLabel);
    const entry = results(root).find(result => result.entry.id === 'profile.signOut');
    expect(entry).toBeDefined();
    const [resultNode] = byType(root, 'SettingsSearchResults');
    act(() => {
      resultNode!.props.onSelect(entry!.entry);
    });

    expect(signOutFn).not.toHaveBeenCalled();
    expect(routerPush).not.toHaveBeenCalled();

    // The highlight is painted over the control the row renders, not a copy of
    // the result: exactly the sign-out row's target is active.
    const [highlight] = targetHighlights(root);
    expect(highlight).toBeDefined();
    const highlightBox = highlight!.parent;
    expect(
      highlightBox!.findAll(
        node => node.type === 'ConfigureRow' && node.props.title === signOutLabel
      )
    ).toHaveLength(1);

    // Clearing the query restores the full settings list with the target kept.
    query(root, '');
    expect(renderedRowTitles(root)).toContain(signOutLabel);
    expect(targetHighlights(root)).toHaveLength(1);
    expect(signOutFn).not.toHaveBeenCalled();
  });

  it('opens a nested result on its screen with the row target and source params', async () => {
    const view = await mountProfile();
    const root = view.renderer.root;
    const nested = {
      id: 'preferences.language',
      label: i18n.t('common.preferences'),
      path: '/(app)/(tabs)/(3_profile)/preferences',
      params: { mode: 'review' },
    } as const;

    query(root, nested.label);
    const [resultNode] = byType(root, 'SettingsSearchResults');
    act(() => {
      resultNode!.props.onSelect(nested);
    });

    expect(routerPush).toHaveBeenCalledWith({
      pathname: nested.path,
      params: { mode: 'review', settingsTarget: nested.id },
    });
    expect(signOutFn).not.toHaveBeenCalled();
  });
});
