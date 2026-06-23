import { enableActionClickSidePanel } from '@/src/shared/side-panel';
import {
  EVAL_TAB_MESSAGE,
  LIST_INSPECTABLE_TABS_MESSAGE,
  evalInTab,
  evalInTabWithScripting,
  isTabDebuggerRequest,
  listInspectableTabs,
  listInspectableTabsWithTabsApi,
} from '@/src/shared/tab-debugger';
import type {
  BrowserScriptingApi,
  BrowserTabsApi,
  ChromeDebuggerApi,
  TabDebuggerRequest,
  TabDebuggerResponse,
} from '@/src/shared/tab-debugger';

interface ChromeRuntimeApi {
  readonly onMessage?: {
    readonly addListener: (
      listener: (
        message: unknown,
        sender: unknown,
        sendResponse: (response: TabDebuggerResponse) => void
      ) => boolean | void
    ) => void;
  };
}

const handleTabDebuggerRequest = async ({
  debuggerApi,
  request,
  scriptingApi,
  tabsApi,
}: {
  debuggerApi: ChromeDebuggerApi | undefined;
  request: TabDebuggerRequest;
  scriptingApi: BrowserScriptingApi | undefined;
  tabsApi: BrowserTabsApi | undefined;
}): Promise<TabDebuggerResponse> => {
  try {
    if (request.type === LIST_INSPECTABLE_TABS_MESSAGE) {
      if (debuggerApi) {
        return {
          ok: true,
          tabs: await listInspectableTabs(debuggerApi),
          type: LIST_INSPECTABLE_TABS_MESSAGE,
        };
      }

      if (tabsApi) {
        return {
          ok: true,
          tabs: await listInspectableTabsWithTabsApi(tabsApi),
          type: LIST_INSPECTABLE_TABS_MESSAGE,
        };
      }

      return { error: 'Tab listing API is unavailable.', ok: false };
    }

    if (debuggerApi) {
      return {
        ok: true,
        result: await evalInTab({
          code: request.code,
          debuggerApi,
          tabId: request.tabId,
          ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
        }),
        type: EVAL_TAB_MESSAGE,
      };
    }

    if (scriptingApi) {
      return {
        ok: true,
        result: await evalInTabWithScripting({
          code: request.code,
          scriptingApi,
          tabId: request.tabId,
          ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
        }),
        type: EVAL_TAB_MESSAGE,
      };
    }

    return { error: 'Tab evaluation API is unavailable.', ok: false };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'Debugger request failed.',
      ok: false,
    };
  }
};

export default defineBackground(() => {
  const chromeApi = (
    globalThis as typeof globalThis & {
      chrome?: {
        debugger?: ChromeDebuggerApi;
        runtime?: ChromeRuntimeApi;
        scripting?: BrowserScriptingApi;
        sidePanel?: Parameters<typeof enableActionClickSidePanel>[0];
        tabs?: BrowserTabsApi;
      };
    }
  ).chrome;

  void enableActionClickSidePanel(chromeApi?.sidePanel);

  chromeApi?.runtime?.onMessage?.addListener((message, sender, sendResponse) => {
    void sender;

    if (!isTabDebuggerRequest(message)) {
      return;
    }

    void (async (): Promise<void> => {
      const response = await handleTabDebuggerRequest({
        debuggerApi: chromeApi.debugger,
        request: message,
        scriptingApi: chromeApi.scripting,
        tabsApi: chromeApi.tabs,
      });
      sendResponse(response);
    })();

    return true;
  });
});
