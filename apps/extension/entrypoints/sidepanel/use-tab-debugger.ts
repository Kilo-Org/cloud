import { browser } from '#imports';
import { useCallback, useState } from 'react';
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

export const useTabDebugger = (): {
  readonly inspectableTabs: InspectableTab[];
  readonly isLoadingTabs: boolean;
  readonly loadInspectableTabs: () => Promise<void>;
  readonly selectTab: (tabId: number) => void;
  readonly selectedTabId: number | undefined;
  readonly tabDebuggerError: string | undefined;
} => {
  const [inspectableTabs, setInspectableTabs] = useState<InspectableTab[]>([]);
  const [isLoadingTabs, setIsLoadingTabs] = useState(false);
  const [selectedTabId, setSelectedTabId] = useState<number | undefined>();
  const [tabDebuggerError, setTabDebuggerError] = useState<string | undefined>();

  const loadInspectableTabs = useCallback(async (): Promise<void> => {
    setIsLoadingTabs(true);
    setTabDebuggerError(undefined);

    try {
      const response = await sendTabDebuggerRequest({ type: LIST_INSPECTABLE_TABS_MESSAGE });

      if (!response.ok) {
        throw new Error(response.error);
      }

      if (response.type !== LIST_INSPECTABLE_TABS_MESSAGE) {
        throw new Error('Extension background returned the wrong response.');
      }

      setInspectableTabs(response.tabs);
      setSelectedTabId(currentTabId => {
        if (currentTabId !== undefined && response.tabs.some(tab => tab.id === currentTabId)) {
          return currentTabId;
        }

        return response.tabs[0]?.id;
      });
    } catch (error) {
      setInspectableTabs([]);
      setSelectedTabId(undefined);
      setTabDebuggerError(getErrorMessage(error, 'Failed to load tabs.'));
    } finally {
      setIsLoadingTabs(false);
    }
  }, []);

  const selectTab = useCallback((tabId: number): void => {
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
