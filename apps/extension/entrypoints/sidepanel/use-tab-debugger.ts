import { browser } from '#imports';
import { useCallback, useState } from 'react';
import {
  GET_TAB_HTML_LENGTH_MESSAGE,
  LIST_INSPECTABLE_TABS_MESSAGE,
  isTabDebuggerResponse,
} from '@/src/shared/tab-debugger';
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
  readonly htmlLength: number | undefined;
  readonly inspectableTabs: InspectableTab[];
  readonly isLoadingTabs: boolean;
  readonly isMeasuringHtml: boolean;
  readonly loadInspectableTabs: () => Promise<void>;
  readonly measureSelectedTabHtml: () => void;
  readonly selectTab: (tabId: number) => void;
  readonly selectedTabId: number | undefined;
  readonly tabDebuggerError: string | undefined;
} => {
  const [htmlLength, setHtmlLength] = useState<number | undefined>();
  const [inspectableTabs, setInspectableTabs] = useState<InspectableTab[]>([]);
  const [isLoadingTabs, setIsLoadingTabs] = useState(false);
  const [isMeasuringHtml, setIsMeasuringHtml] = useState(false);
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
    setHtmlLength(undefined);
    setSelectedTabId(tabId);
    setTabDebuggerError(undefined);
  }, []);

  const measureSelectedTabHtml = useCallback((): void => {
    if (selectedTabId === undefined) {
      setTabDebuggerError('Select a tab first.');
      return;
    }

    setHtmlLength(undefined);
    setIsMeasuringHtml(true);
    setTabDebuggerError(undefined);

    void (async (): Promise<void> => {
      try {
        const response = await sendTabDebuggerRequest({
          tabId: selectedTabId,
          type: GET_TAB_HTML_LENGTH_MESSAGE,
        });

        if (!response.ok) {
          throw new Error(response.error);
        }

        if (response.type !== GET_TAB_HTML_LENGTH_MESSAGE) {
          throw new Error('Extension background returned the wrong response.');
        }

        setHtmlLength(response.length);
      } catch (error) {
        setTabDebuggerError(getErrorMessage(error, 'Failed to measure HTML.'));
      } finally {
        setIsMeasuringHtml(false);
      }
    })();
  }, [selectedTabId]);

  return {
    htmlLength,
    inspectableTabs,
    isLoadingTabs,
    isMeasuringHtml,
    loadInspectableTabs,
    measureSelectedTabHtml,
    selectTab,
    selectedTabId,
    tabDebuggerError,
  };
};
