import { browser } from '#imports';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getTabListQueryKey } from '@/src/shared/side-panel-query-options';
import { LIST_INSPECTABLE_TABS_MESSAGE, isTabDebuggerResponse } from '@/src/shared/tab-debugger';
import type {
  InspectableTab,
  TabDebuggerRequest,
  TabDebuggerResponse,
} from '@/src/shared/tab-debugger';

const getErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

const sendTabDebuggerRequest = async (
  request: TabDebuggerRequest
): Promise<TabDebuggerResponse> => {
  const response: unknown = await browser.runtime.sendMessage(request);

  if (!isTabDebuggerResponse(response)) {
    return { error: 'Extension background returned an invalid response.', ok: false };
  }

  return response;
};

let rememberedSelectedTabId: number | null = null;

export const useTabDebugger = (): {
  readonly inspectableTabs: InspectableTab[];
  readonly isLoadingTabs: boolean;
  readonly loadInspectableTabs: (options?: { readonly showLoading?: boolean }) => Promise<void>;
  readonly selectTab: (tabId: number) => void;
  readonly selectedTabId: number | undefined;
  readonly tabDebuggerError: string | undefined;
} => {
  const [inspectableTabs, setInspectableTabs] = useState<InspectableTab[]>([]);
  const [selectedTabId, setSelectedTabId] = useState<number | undefined>(
    rememberedSelectedTabId ?? undefined
  );
  const hasLoadedTabsRef = useRef(false);
  const {
    data: tabs,
    error: tabsError,
    isError,
    isLoading,
    refetch,
  } = useQuery({
    queryFn: async () => {
      const response = await sendTabDebuggerRequest({ type: LIST_INSPECTABLE_TABS_MESSAGE });

      if (!response.ok) {
        throw new Error(response.error);
      }

      if (response.type !== LIST_INSPECTABLE_TABS_MESSAGE) {
        throw new Error('Extension background returned the wrong response.');
      }

      return response.tabs;
    },
    queryKey: getTabListQueryKey(),
    refetchInterval: 2000,
  });

  useEffect(() => {
    if (tabs === undefined) {
      if (isError) {
        setInspectableTabs([]);
        setSelectedTabId(undefined);
        rememberedSelectedTabId = null;
      }
      return;
    }

    const isInitialLoad = !hasLoadedTabsRef.current;

    hasLoadedTabsRef.current = true;
    setInspectableTabs(tabs);
    setSelectedTabId(currentTabId => {
      if (currentTabId !== undefined && tabs.some(tab => tab.id === currentTabId)) {
        rememberedSelectedTabId = currentTabId;
        return currentTabId;
      }

      const nextTabId = isInitialLoad ? tabs[0]?.id : undefined;

      rememberedSelectedTabId = nextTabId ?? null;
      return nextTabId;
    });
  }, [isError, tabs]);

  const loadInspectableTabs = useCallback(
    async (_options: { readonly showLoading?: boolean } = {}): Promise<void> => {
      await refetch();
    },
    [refetch]
  );

  const tabDebuggerError =
    tabsError === null ? undefined : getErrorMessage(tabsError, 'Failed to load tabs.');

  const selectTab = useCallback((tabId: number): void => {
    rememberedSelectedTabId = tabId;
    setSelectedTabId(tabId);
  }, []);

  return {
    inspectableTabs,
    isLoadingTabs: isLoading,
    loadInspectableTabs,
    selectTab,
    selectedTabId,
    tabDebuggerError,
  };
};
