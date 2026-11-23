import { beforeEach, describe, expect, it, vi } from 'vitest';

// The mock harness registers every product-module mock before the screen loads.
import {
  confirmFn,
  findConfigureRows,
  keyboardDismissFn,
  mountProfile,
  providersQueryFn,
  routerPush,
  scrollToFn,
  signOutFn,
} from '@/components/profile-screen.test-helpers';
import { SettingsTarget } from '@/components/settings-search/settings-target';
import { type SettingsSearchResult } from '@/components/settings-search/use-settings-search';
import { i18n } from '@/i18n';
import { type SettingDefinition } from '@/lib/settings-search/definitions';
import { act, type ReactTestInstance } from '@/test/renderer';

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
  const { onChangeText } = node.props as { onChangeText: (next: string) => void };
  act(() => {
    onChangeText(text);
  });
}

function results(root: ReactTestInstance): readonly SettingsSearchResult[] {
  const [node] = byType(root, 'SettingsSearchResults');
  if (!node) {
    return [];
  }
  const value: readonly SettingsSearchResult[] = node.props.results;
  return value;
}

function resultNode(root: ReactTestInstance): ReactTestInstance {
  const [node] = byType(root, 'SettingsSearchResults');
  if (!node) {
    throw new Error('search results are not rendered');
  }
  return node;
}

/** Choose one result through the results body's own callback. */
function selectResult(root: ReactTestInstance, result: SettingsSearchResult) {
  const { onSelect } = resultNode(root).props as {
    onSelect: (entry: SettingsSearchResult['entry']) => void;
  };
  act(() => {
    onSelect(result.entry);
  });
}

/** The stationary highlight each active target paints over its row. */
function targetHighlights(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAll(
    node =>
      String(node.type) === 'View' && String(node.props.className ?? '').includes('border-primary')
  );
}

/**
 * The Settings search index has to describe the rows the screen really renders:
 * every permanent row is searchable, the index never offers a row that is not on
 * screen, and a root result only ever highlights its control.
 */
describe('ProfileScreen settings search', () => {
  beforeEach(() => {
    confirmFn.mockClear();
    keyboardDismissFn.mockClear();
    routerPush.mockClear();
    scrollToFn.mockClear();
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
        const item: SettingDefinition = node.props.item;
        return item;
      });
    const indexedTitles = targetItems.map(item => i18n.t(item.label));
    expect(new Set(indexedTitles)).toEqual(new Set(titles));
    expect(indexedTitles).toHaveLength(titles.length);
    expect(renderedRowTitles(root)).toEqual(titles);
    // Every rendered settings row is a control the person can press, which is
    // what the search result promises to locate.
    for (const row of byType(root, 'ConfigureRow')) {
      expect(row.props.onPress).toBeTypeOf('function');
    }
  });

  it('highlights the sign-out row from its logout alias without signing out', async () => {
    const view = await mountProfile();
    const root = view.renderer.root;
    const signOutLabel = i18n.t('common.signOut');
    expect(findConfigureRows(root, signOutLabel)).toHaveLength(1);
    expect(targetHighlights(root)).toEqual([]);

    // The field matches the localized keyword ("logout|log off"), not only the
    // visible label.
    query(root, 'logout');
    const entry = results(root).find(result => result.entry.id === 'profile.signOut');
    if (!entry) {
      throw new Error('the sign-out row is not found by its logout alias');
    }
    selectResult(root, entry);

    expect(signOutFn).not.toHaveBeenCalled();
    expect(confirmFn).not.toHaveBeenCalled();
    expect(routerPush).not.toHaveBeenCalled();
    expect(keyboardDismissFn).toHaveBeenCalledTimes(1);

    // The highlight is painted over the control the row renders, not a copy of
    // the result: exactly the sign-out row's target is active.
    const [highlight] = targetHighlights(root);
    const highlightBox = highlight?.parent;
    if (!highlightBox) {
      throw new Error('the sign-out row is not highlighted');
    }
    expect(
      highlightBox.findAll(
        node => String(node.type) === 'ConfigureRow' && node.props.title === signOutLabel
      )
    ).toHaveLength(1);

    // Clearing the query restores the full settings list with the target kept.
    query(root, '');
    expect(renderedRowTitles(root)).toContain(signOutLabel);
    expect(targetHighlights(root)).toHaveLength(1);
    expect(signOutFn).not.toHaveBeenCalled();

    // The same result can be chosen again. The target id is unchanged, so the
    // selection asks for a fresh reveal without running the row's action.
    query(root, 'logout');
    const repeated = results(root).find(result => result.entry.id === 'profile.signOut');
    if (!repeated) {
      throw new Error('the repeated logout search does not find the sign-out row');
    }
    selectResult(root, repeated);
    expect(keyboardDismissFn).toHaveBeenCalledTimes(2);
    expect(targetHighlights(root)).toHaveLength(1);
    expect(signOutFn).not.toHaveBeenCalled();
    expect(confirmFn).not.toHaveBeenCalled();
  });

  it('indexes the dev-only native remote row only while it renders', async () => {
    vi.stubGlobal('__DEV__', true);
    const view = await mountProfile();
    const root = view.renderer.root;
    const title = i18n.t('nativeRemote.title');
    expect(renderedRowTitles(root)).toContain(title);

    query(root, title);
    expect(
      results(root).some(result => result.entry.path === undefined && result.entry.label === title)
    ).toBe(true);
  });

  it('takes a theme search to one Appearance control instead of its individual options', async () => {
    const { renderer } = await mountProfile();
    query(renderer.root, 'theme');
    const matches = results(renderer.root);
    expect(matches).toHaveLength(1);
    const [first] = matches;
    if (!first) {
      throw new Error('no result for theme');
    }
    expect(first.entry.label).toBe(i18n.t('preferences.appearance'));
    selectResult(renderer.root, first);
    expect(routerPush).toHaveBeenCalledWith({
      pathname: '/(app)/(tabs)/(3_profile)/preferences',
      params: { settingsTarget: 'appearance' },
    });
  });

  it('keeps the Dark option distinct from its parent control', async () => {
    const { renderer } = await mountProfile();
    query(renderer.root, i18n.t('preferences.appearanceDark'));
    const option = results(renderer.root).find(result => result.entry.id === 'appearance.dark');
    if (!option) {
      throw new Error('the Dark option is not indexed');
    }
    expect(option.entry.context).toBe(
      `${i18n.t('common.preferences')} · ${i18n.t('preferences.appearance')}`
    );
    selectResult(renderer.root, option);
    expect(routerPush).toHaveBeenCalledWith({
      pathname: '/(app)/(tabs)/(3_profile)/preferences',
      params: { settingsTarget: 'appearance.dark' },
    });
  });

  it('returns the settings body to its first row when the search ends', async () => {
    // The settings body and the results body share one scroller. A results list
    // scrolled deep used to leave its offset on the settings body that replaced
    // it, which parked the credits card and every section above APP above the
    // viewport with Add credits unreachable.
    const { renderer } = await mountProfile();
    const root = renderer.root;
    const resets = () =>
      scrollToFn.mock.calls.filter(([options]) => {
        const call = options as { y?: number; animated?: boolean } | undefined;
        // Only the body reset scrolls instantly; a reveal animates to its row.
        return call?.y === 0 && call.animated === false;
      });

    expect(resets()).toHaveLength(0);

    query(root, 'logout');
    // Entering the search swaps the body, so the results start at their own
    // first row.
    expect(resets()).toHaveLength(1);
    expect(scrollToFn).toHaveBeenLastCalledWith({ y: 0, animated: false });

    // Clearing the query with no highlight set ends the search, so the settings
    // body that replaces the results starts at its first row. This is the
    // reported collapse: without it the replaced body keeps the results' offset.
    query(root, '');
    expect(resets()).toHaveLength(2);

    // A root result selection owns the swap it makes: its reveal is the
    // destination, so that swap is not also reset.
    query(root, 'logout');
    const entry = results(root).find(result => result.entry.path === undefined);
    if (!entry) {
      throw new Error('the search renders no root result');
    }
    selectResult(root, entry);
    expect(targetHighlights(root)).toHaveLength(1);

    // That highlight stays set. A later search and clear must still start the
    // settings body at its first row, and must drop the highlight rather than
    // return the body to a stale row far below the top.
    query(root, 'logout');
    const beforeClear = resets().length;
    query(root, '');
    expect(resets()).toHaveLength(beforeClear + 1);
    expect(targetHighlights(root)).toEqual([]);
  });

  it('opens the privacy analytics setting on the consent review screen', async () => {
    const view = await mountProfile();
    const root = view.renderer.root;

    // The privacy review's analytics control is reachable by its synonym, and
    // its source carries the review-mode route parameter.
    query(root, 'analytics');
    const matches = results(root);
    expect(matches.map(result => result.entry.id)).toEqual([
      'profile.privacyChoices',
      'consent.helpImprove',
    ]);
    const entry = matches.find(result => result.entry.id === 'consent.helpImprove');
    if (!entry) {
      throw new Error('the privacy analytics setting is not indexed');
    }
    expect(entry.entry.path).toBe('/(app)/consent');
    selectResult(root, entry);

    expect(routerPush).toHaveBeenCalledWith({
      pathname: '/(app)/consent',
      params: { mode: 'review', settingsTarget: 'consent.helpImprove' },
    });
    expect(keyboardDismissFn).toHaveBeenCalledTimes(1);
    expect(signOutFn).not.toHaveBeenCalled();
  });
});
