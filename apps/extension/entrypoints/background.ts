import { storage } from '#imports';
import { buildPendingMemoryDraft } from '@/src/shared/agent-memories';
import { savePendingAgentMemoryDraft } from '@/src/shared/agent-memories-storage';
import {
  ADD_TO_MEMORY_MENU_ID,
  enableActionClickSidePanel,
  openSidePanelInWindow,
  registerAddToMemoryMenu,
} from '@/src/shared/side-panel';
import type {
  NativeContextMenusApi,
  NativeContextMenusOnClickData,
  NativeContextMenusTab,
  NativeSidePanelOpenApi,
  NativeSidebarActionApi,
} from '@/src/shared/side-panel';
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
  readonly onInstalled?: {
    readonly addListener: (listener: () => void) => void;
  };
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
 * Accept only same-extension senders whose origin is an extension page, so adding a content script
 * later can't silently widen access to the dangerous eval path: a content script shares the
 * extension `id` but reports the host page's web origin, while an extension page reports an
 * extension-scheme origin (`chrome-extension://` on Chrome, `moz-extension://` on Firefox).
 */
const isExtensionScheme = (value: unknown): boolean =>
  typeof value === 'string' &&
  (value.startsWith('chrome-extension://') || value.startsWith('moz-extension://'));

const isTrustedExtensionSender = (sender: unknown, runtimeId: string | undefined): boolean => {
  if (runtimeId === undefined || typeof sender !== 'object' || sender === null) {
    return false;
  }

  const { id, origin, url } = sender as { id?: unknown; origin?: unknown; url?: unknown };

  // Same-extension is already pinned by `id === runtimeId`, so origin only separates an extension page from a content script.
  return id === runtimeId && (isExtensionScheme(origin) || isExtensionScheme(url));
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

const handleAddToMemoryClick = (
  info: NativeContextMenusOnClickData,
  tab: NativeContextMenusTab | undefined,
  {
    sidePanelOpen,
    sidebarAction,
  }: {
    sidePanelOpen?: NativeSidePanelOpenApi | undefined;
    sidebarAction?: NativeSidebarActionApi | undefined;
  }
): void => {
  if (info.menuItemId !== ADD_TO_MEMORY_MENU_ID) {
    return;
  }

  const draft = buildPendingMemoryDraft({
    now: Date.now(),
    pageTitle: tab?.title ?? '',
    pageUrl: info.pageUrl ?? tab?.url ?? '',
    selectionText: info.selectionText,
  });

  if (draft === undefined) {
    return;
  }

  const windowId = tab?.windowId;
  if (windowId !== undefined) {
    // User-gesture contract: open synchronously before any await.
    try {
      const openResult = openSidePanelInWindow({
        sidePanelOpen,
        sidebarAction,
        windowId,
      });
      // Fire-and-forget: must not await before storage save, and open failures are non-fatal.
      // eslint-disable-next-line promise/prefer-await-to-then, promise/prefer-await-to-callbacks -- user-gesture open must not await
      void Promise.resolve(openResult).catch((error: unknown) => {
        console.warn('Failed to open side panel for Add to memory:', error);
      });
    } catch (error) {
      console.warn('Failed to open side panel for Add to memory:', error);
    }
  }

  // eslint-disable-next-line promise/prefer-await-to-then, promise/prefer-await-to-callbacks -- keep open/save non-blocking in the SW click path
  void savePendingAgentMemoryDraft(storage, draft).catch((error: unknown) => {
    console.warn('Failed to save pending agent memory draft:', error);
  });
};

export default defineBackground(() => {
  const chromeApi = (
    globalThis as typeof globalThis & {
      chrome?: {
        contextMenus?: NativeContextMenusApi;
        debugger?: ChromeDebuggerApi;
        runtime?: ChromeRuntimeApi;
        scripting?: BrowserScriptingApi;
        sidePanel?: Parameters<typeof enableActionClickSidePanel>[0] & NativeSidePanelOpenApi;
        sidebarAction?: NativeSidebarActionApi;
        tabs?: BrowserTabsApi;
      };
    }
  ).chrome;

  const browserGlobal = (
    globalThis as typeof globalThis & {
      browser?: {
        contextMenus?: NativeContextMenusApi;
        runtime?: ChromeRuntimeApi;
        sidePanel?: NativeSidePanelOpenApi;
        sidebarAction?: NativeSidebarActionApi;
      };
    }
  ).browser;

  const menusApi: NativeContextMenusApi | undefined =
    browserGlobal?.contextMenus ?? chromeApi?.contextMenus;
  const sidePanelOpen: NativeSidePanelOpenApi | undefined =
    chromeApi?.sidePanel ?? browserGlobal?.sidePanel;
  const sidebarAction: NativeSidebarActionApi | undefined =
    browserGlobal?.sidebarAction ?? chromeApi?.sidebarAction;

  void enableActionClickSidePanel(chromeApi?.sidePanel);

  void registerAddToMemoryMenu(menusApi);
  const runtimeApi = browserGlobal?.runtime ?? chromeApi?.runtime;
  runtimeApi?.onInstalled?.addListener(() => {
    void registerAddToMemoryMenu(menusApi);
  });

  menusApi?.onClicked.addListener((info, tab) => {
    handleAddToMemoryClick(info, tab, { sidePanelOpen, sidebarAction });
  });

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
