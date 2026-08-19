import { browser } from '#imports';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { getTabListQueryKey } from '@/src/shared/side-panel-query-options';
import { deriveInspectableTabState } from '@/src/shared/tab-debugger-selection';
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

interface TabsQueryApi {
  readonly query: (queryInfo: {
    readonly active: true;
    readonly currentWindow: true;
  }) => Promise<readonly { readonly id?: number | undefined }[]>;
}

const activeTabIdSchema = z.looseObject({ id: z.number().optional() });

/**
 * Best-effort active-tab lookup for the side panel's own window.
 * Never throws: query failures and invalid ids degrade to `undefined`.
 */
export const getActiveTabId = async (tabsApi: TabsQueryApi): Promise<number | undefined> => {
  try {
    const tabs = await tabsApi.query({ active: true, currentWindow: true });
    const firstTab = activeTabIdSchema.safeParse(tabs[0]);

    return firstTab.success ? firstTab.data.id : undefined;
  } catch {
    return undefined;
  }
};

let rememberedSelectedTabId: number | null = null;

export const useTabDebugger = () => {
  const [inspectableTabs, setInspectableTabs] = useState<InspectableTab[]>([]);
  const [selectedTabId, setSelectedTabId] = useState<number | undefined>(
    rememberedSelectedTabId ?? undefined
  );
  const hasLoadedTabsRef = useRef(false);
  const {
    data,
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

      const activeTabId = await getActiveTabId(browser.tabs);

      return { activeTabId, tabs: response.tabs };
    },
    queryKey: getTabListQueryKey(),
    refetchInterval: 2000,
  });

  const tabs = data?.tabs;
  const activeTabId = data?.activeTabId;

  useEffect(() => {
    const nextState = deriveInspectableTabState({
      currentSelectedTabId: selectedTabId,
      hasLoadedTabs: hasLoadedTabsRef.current,
      isError,
      tabs,
    });

    if (nextState === undefined) {
      return;
    }

    const {
      hasLoadedTabs,
      inspectableTabs: nextInspectableTabs,
      rememberedSelectedTabId: nextRememberedSelectedTabId,
      selectedTabId: nextSelectedTabId,
    } = nextState;

    hasLoadedTabsRef.current = hasLoadedTabs;
    rememberedSelectedTabId = nextRememberedSelectedTabId;
    setInspectableTabs(nextInspectableTabs);
    setSelectedTabId(nextSelectedTabId);
  }, [isError, selectedTabId, tabs]);

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

  const selectDefaultTab = useCallback((): void => {
    const nextTabId = inspectableTabs[0]?.id;

    rememberedSelectedTabId = nextTabId ?? null;
    setSelectedTabId(nextTabId);
  }, [inspectableTabs]);

  return {
    activeTabId,
    inspectableTabs,
    isLoadingTabs: isLoading,
    loadInspectableTabs,
    selectDefaultTab,
    selectTab,
    selectedTabId,
    tabDebuggerError,
  };
};
