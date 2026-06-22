import { enableActionClickSidePanel } from '@/src/shared/side-panel';
import {
  EVAL_TAB_MESSAGE,
  GET_TAB_HTML_LENGTH_MESSAGE,
  LIST_INSPECTABLE_TABS_MESSAGE,
  evalInTab,
  getTabHtmlLength,
  isTabDebuggerRequest,
  listInspectableTabs,
} from '@/src/shared/tab-debugger';
import type {
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
}: {
  debuggerApi: ChromeDebuggerApi | undefined;
  request: TabDebuggerRequest;
}): Promise<TabDebuggerResponse> => {
  if (debuggerApi === undefined) {
    return { error: 'Debugger API is unavailable.', ok: false };
  }

  try {
    if (request.type === LIST_INSPECTABLE_TABS_MESSAGE) {
      return {
        ok: true,
        tabs: await listInspectableTabs(debuggerApi),
        type: LIST_INSPECTABLE_TABS_MESSAGE,
      };
    }

    if (request.type === GET_TAB_HTML_LENGTH_MESSAGE) {
      return {
        length: await getTabHtmlLength(debuggerApi, request.tabId),
        ok: true,
        type: GET_TAB_HTML_LENGTH_MESSAGE,
      };
    }

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
        sidePanel?: Parameters<typeof enableActionClickSidePanel>[0];
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
      });
      sendResponse(response);
    })();

    return true;
  });
});
