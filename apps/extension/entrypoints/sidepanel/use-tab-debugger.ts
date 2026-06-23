import { browser } from '#imports';
import { useCallback, useRef, useState } from 'react';
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
  const [isLoadingTabs, setIsLoadingTabs] = useState(false);
  const [selectedTabId, setSelectedTabId] = useState<number | undefined>(
    rememberedSelectedTabId ?? undefined
  );
  const [tabDebuggerError, setTabDebuggerError] = useState<string | undefined>();
  const hasLoadedTabsRef = useRef(false);

  const loadInspectableTabs = useCallback(
    async ({ showLoading = true }: { readonly showLoading?: boolean } = {}): Promise<void> => {
      if (showLoading) {
        setIsLoadingTabs(true);
      }

      setTabDebuggerError(undefined);

      try {
        const response = await sendTabDebuggerRequest({ type: LIST_INSPECTABLE_TABS_MESSAGE });

        if (!response.ok) {
          throw new Error(response.error);
        }

        if (response.type !== LIST_INSPECTABLE_TABS_MESSAGE) {
          throw new Error('Extension background returned the wrong response.');
        }

        const isInitialLoad = !hasLoadedTabsRef.current;

        hasLoadedTabsRef.current = true;
        setInspectableTabs(response.tabs);
        setSelectedTabId(currentTabId => {
          if (currentTabId !== undefined && response.tabs.some(tab => tab.id === currentTabId)) {
            rememberedSelectedTabId = currentTabId;
            return currentTabId;
          }

          const nextTabId = isInitialLoad ? response.tabs[0]?.id : undefined;

          rememberedSelectedTabId = nextTabId ?? null;
          return nextTabId;
        });
      } catch (error) {
        setInspectableTabs([]);
        setSelectedTabId(undefined);
        rememberedSelectedTabId = null;
        setTabDebuggerError(getErrorMessage(error, 'Failed to load tabs.'));
      } finally {
        if (showLoading) {
          setIsLoadingTabs(false);
        }
      }
    },
    []
  );

  const selectTab = useCallback((tabId: number): void => {
    rememberedSelectedTabId = tabId;
    setSelectedTabId(tabId);
    setTabDebuggerError(undefined);
  }, []);

  return {
    inspectableTabs,
    isLoadingTabs,
    loadInspectableTabs,
    selectTab,
    selectedTabId,
    tabDebuggerError,
  };
};
