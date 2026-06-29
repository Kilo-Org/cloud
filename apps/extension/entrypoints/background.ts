import { enableActionClickSidePanel } from '@/src/shared/side-panel';
import {
  EVAL_TAB_MESSAGE,
  LIST_INSPECTABLE_TABS_MESSAGE,
  PAGE_SNAPSHOT_MESSAGE,
  VIEWPORT_SCREENSHOT_MESSAGE,
  evalInTab,
  evalInTabWithScripting,
  getPageSnapshotInTabWithScripting,
  getViewportScreenshotWithTabsApi,
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
  readonly id?: string;
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

/*
 * Trust boundary for the eval/debugger message path. Today only the extension's own pages (the
 * side panel) can reach this listener — there is no externally_connectable and no content script.
 * Accept only same-extension, non-tab senders so adding either later can't silently widen access
 * to the dangerous eval path. Content scripts carry a `tab`; external pages carry a different `id`.
 */
const isTrustedExtensionSender = (sender: unknown, runtimeId: string | undefined): boolean => {
  if (runtimeId === undefined || typeof sender !== 'object' || sender === null) {
    return false;
  }

  const { id, tab } = sender as { id?: unknown; tab?: unknown };
  return id === runtimeId && tab === undefined;
};

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

    if (request.type === PAGE_SNAPSHOT_MESSAGE) {
      if (scriptingApi) {
        return {
          ok: true,
          result: await getPageSnapshotInTabWithScripting({
            scriptingApi,
            tabId: request.tabId,
            ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
          }),
          type: PAGE_SNAPSHOT_MESSAGE,
        };
      }

      return { error: 'Page snapshot API is unavailable.', ok: false };
    }

    if (request.type === VIEWPORT_SCREENSHOT_MESSAGE) {
      if (tabsApi) {
        return {
          ok: true,
          result: await getViewportScreenshotWithTabsApi({
            tabId: request.tabId,
            tabsApi,
          }),
          type: VIEWPORT_SCREENSHOT_MESSAGE,
        };
      }

      return { error: 'Viewport screenshot API is unavailable.', ok: false };
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
    if (!isTrustedExtensionSender(sender, chromeApi?.runtime?.id)) {
      return;
    }

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
