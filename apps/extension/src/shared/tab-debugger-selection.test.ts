import { describe, expect, it } from 'vitest';
import { deriveInspectableTabState } from './tab-debugger-selection';
import type { InspectableTab } from './tab-debugger';

const firstTab: InspectableTab = {
  id: 1,
  title: 'First',
  url: 'https://example.com/first',
};
const secondTab: InspectableTab = {
  id: 2,
  title: 'Second',
  url: 'https://example.com/second',
};

describe('tab debugger selection state', () => {
  it('clears stale tabs and selected tab when the latest query is an error', () => {
    expect(
      deriveInspectableTabState({
        currentSelectedTabId: firstTab.id,
        hasLoadedTabs: true,
        isError: true,
        tabs: [firstTab],
      })
    ).toStrictEqual({
      hasLoadedTabs: true,
      inspectableTabs: [],
      rememberedSelectedTabId: null,
      selectedTabId: undefined,
    });
  });

  it('selects the first tab only on the initial successful load', () => {
    expect(
      deriveInspectableTabState({
        currentSelectedTabId: undefined,
        hasLoadedTabs: false,
        isError: false,
        tabs: [firstTab, secondTab],
      })
    ).toStrictEqual({
      hasLoadedTabs: true,
      inspectableTabs: [firstTab, secondTab],
      rememberedSelectedTabId: firstTab.id,
      selectedTabId: firstTab.id,
    });

    expect(
      deriveInspectableTabState({
        currentSelectedTabId: undefined,
        hasLoadedTabs: true,
        isError: false,
        tabs: [firstTab, secondTab],
      })
    ).toStrictEqual({
      hasLoadedTabs: true,
      inspectableTabs: [firstTab, secondTab],
      rememberedSelectedTabId: null,
      selectedTabId: undefined,
    });
  });

  it('keeps the selected tab when it still exists in the refreshed tab list', () => {
    expect(
      deriveInspectableTabState({
        currentSelectedTabId: secondTab.id,
        hasLoadedTabs: true,
        isError: false,
        tabs: [firstTab, secondTab],
      })
    ).toStrictEqual({
      hasLoadedTabs: true,
      inspectableTabs: [firstTab, secondTab],
      rememberedSelectedTabId: secondTab.id,
      selectedTabId: secondTab.id,
    });
  });
});
