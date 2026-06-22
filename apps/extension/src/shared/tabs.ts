export interface PopupTargetTab {
  readonly id?: number | undefined;
  readonly lastAccessed?: number | undefined;
  readonly url?: string | undefined;
}

export const selectPopupTargetTabId = (
  activeTab: PopupTargetTab | undefined,
  tabs: readonly PopupTargetTab[],
  extensionOrigin: string
): number | undefined => {
  const fallbackTabs = tabs
    .filter(tab => typeof tab.id === 'number' && tab.id !== activeTab?.id)
    .toSorted((left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0));

  if (activeTab?.url === undefined) {
    const visibleWebTab = fallbackTabs.find(tab => /^https?:\/\//.test(tab.url ?? ''));

    if (typeof visibleWebTab?.id === 'number') {
      return visibleWebTab.id;
    }
  }

  if (
    typeof activeTab?.id === 'number' &&
    (activeTab.url === undefined || !activeTab.url.startsWith(extensionOrigin))
  ) {
    return activeTab.id;
  }

  return fallbackTabs[0]?.id;
};
