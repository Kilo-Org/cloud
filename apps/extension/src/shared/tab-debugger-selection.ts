import type { InspectableTab } from './tab-debugger';

interface DeriveInspectableTabStateOptions {
  readonly currentSelectedTabId: number | undefined;
  readonly hasLoadedTabs: boolean;
  readonly isError: boolean;
  readonly tabs: InspectableTab[] | undefined;
}

interface InspectableTabState {
  readonly hasLoadedTabs: boolean;
  readonly inspectableTabs: InspectableTab[];
  readonly rememberedSelectedTabId: number | null;
  readonly selectedTabId: number | undefined;
}

export const deriveInspectableTabState = ({
  currentSelectedTabId,
  hasLoadedTabs,
  isError,
  tabs,
}: DeriveInspectableTabStateOptions): InspectableTabState | undefined => {
  if (isError) {
    return {
      hasLoadedTabs,
      inspectableTabs: [],
      rememberedSelectedTabId: null,
      selectedTabId: undefined,
    };
  }

  if (tabs === undefined) {
    return undefined;
  }

  if (currentSelectedTabId !== undefined && tabs.some(tab => tab.id === currentSelectedTabId)) {
    return {
      hasLoadedTabs: true,
      inspectableTabs: tabs,
      rememberedSelectedTabId: currentSelectedTabId,
      selectedTabId: currentSelectedTabId,
    };
  }

  const nextTabId = hasLoadedTabs ? undefined : tabs[0]?.id;

  return {
    hasLoadedTabs: true,
    inspectableTabs: tabs,
    rememberedSelectedTabId: nextTabId ?? null,
    selectedTabId: nextTabId,
  };
};
