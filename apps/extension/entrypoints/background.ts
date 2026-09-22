/* eslint-disable max-lines */
import { storage } from '#imports';
import { z } from 'zod';
import { buildPendingMemoryDraft } from '@/src/shared/agent-memories';
import { savePendingAgentMemoryDraft } from '@/src/shared/agent-memories-storage';
import type { WebMcpToolCallEvent } from '@/src/shared/agent-conversation';
import { runKiloBrowserTool } from '@/src/shared/browser-tool-dispatch';
import type { BrowserToolDispatchOptions } from '@/src/shared/browser-tool-dispatch';
import { createBrowserToolSession } from '@/src/shared/browser-tool-session';
import type { BrowserToolSession } from '@/src/shared/browser-tool-session';
import { clearBrowserToolResize } from '@/src/shared/browser-tool-page-actions';
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
  BROWSER_TOOL_MESSAGE,
  EVAL_TAB_MESSAGE,
  LIST_INSPECTABLE_TABS_MESSAGE,
  PAGE_SNAPSHOT_MESSAGE,
  VIEWPORT_SCREENSHOT_MESSAGE,
  WEB_MCP_DISCOVER_MESSAGE,
  WEB_MCP_EXECUTE_MESSAGE,
  discoverWebMcpToolsInTab,
  evalInTab,
  evalInTabWithScripting,
  executeWebMcpToolInTab,
  getInspectableTab,
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
  EvalTabResult,
  TabDebuggerRequest,
  TabDebuggerResponse,
  WebMcpDiscoveryResult,
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
const extensionSchemeSchema = z
  .string()
  .refine(value => value.startsWith('chrome-extension://') || value.startsWith('moz-extension://'));

const isExtensionScheme = (value: unknown): boolean =>
  extensionSchemeSchema.safeParse(value).success;

const extensionSenderSchema = z.object({
  id: z.string().optional(),
  origin: z.unknown().optional(),
  url: z.unknown().optional(),
});

const isTrustedExtensionSender = (sender: unknown, runtimeId: string | undefined): boolean => {
  if (runtimeId === undefined) {
    return false;
  }

  const parsed = extensionSenderSchema.safeParse(sender);

  if (!parsed.success) {
    return false;
  }

  const { id, origin, url } = parsed.data;

  // Same-extension is already pinned by `id === runtimeId`, so origin only separates an extension page from a content script.
  return id === runtimeId && (isExtensionScheme(origin) || isExtensionScheme(url));
};

/*
 * One browser-tool session per tab, created through the session module
 * factory on the first `kilo.tabs.browserTool` message and reused for the
 * tab's lifetime (so console, network and ref state accumulate between tool
 * calls). Where `debuggerApi` is absent (Firefox) the factory builds the
 * scripting backend. A session is disposed and evicted when its tab closes or
 * leaves the extension's reach, so the next call starts fresh instead of
 * reusing a dead session.
 */
const browserToolSessions = new Map<number, BrowserToolSession>();

const disposeBrowserToolSession = async (tabId: number): Promise<void> => {
  const session = browserToolSessions.get(tabId);

  if (session === undefined) {
    return;
  }

  browserToolSessions.delete(tabId);
  // Clear a browser_resize override before the debugger detaches, so a tab that stays open but leaves the extension's reach does not keep the resized viewport.
  await clearBrowserToolResize(session);
  await session.dispose();
};

// One onRemoved listener per tabs API, wired lazily on the first tool message; the WeakSet keeps a second registration a no-op.
const sessionCleanupWiredTabsApis = new WeakSet<BrowserTabsApi>();

const wireBrowserToolSessionCleanup = (tabsApi: BrowserTabsApi): void => {
  if (sessionCleanupWiredTabsApis.has(tabsApi) || tabsApi.onRemoved === undefined) {
    return;
  }

  sessionCleanupWiredTabsApis.add(tabsApi);
  tabsApi.onRemoved.addListener(tabId => {
    void disposeBrowserToolSession(tabId);
  });
};

const getOrCreateBrowserToolSession = ({
  debuggerApi,
  scriptingApi,
  tabId,
  tabsApi,
}: {
  readonly debuggerApi: ChromeDebuggerApi | undefined;
  readonly scriptingApi: BrowserScriptingApi | undefined;
  readonly tabId: number;
  readonly tabsApi: BrowserTabsApi;
}): BrowserToolSession => {
  const existing = browserToolSessions.get(tabId);

  if (existing !== undefined) {
    return existing;
  }

  const session = createBrowserToolSession({ debuggerApi, scriptingApi, tabId, tabsApi });

  browserToolSessions.set(tabId, session);

  return session;
};

const webMcpDiscoveryValueSchema = z.object({
  documentId: z.string(),
  tools: z.array(
    z.object({
      description: z.string(),
      inputSchema: z.unknown(),
      name: z.string(),
      origin: z.string(),
      title: z.string(),
    })
  ),
});

/**
 * The WebMCP runtime hooks the page-family handlers need for
 * `browser_webmcp_list`/`browser_webmcp_call`, wired to the same injected
 * discovery/execution helpers the standalone WebMCP messages use. The
 * execution hook is signature-checked by the page handler before anything
 * runs in the page.
 */
const webMcpDispatchOptions = (
  scriptingApi: BrowserScriptingApi | undefined
): Pick<BrowserToolDispatchOptions, 'webMcpDiscover' | 'webMcpExecute'> => ({
  webMcpDiscover:
    scriptingApi === undefined
      ? undefined
      : async (tabId: number): Promise<WebMcpDiscoveryResult | undefined> => {
          const discovery = await discoverWebMcpToolsInTab({ scriptingApi, tabId });

          if (!discovery.ok) {
            return undefined;
          }

          const parsed = webMcpDiscoveryValueSchema.safeParse(discovery.value);

          return parsed.success ? parsed.data : undefined;
        },
  webMcpExecute:
    scriptingApi === undefined
      ? undefined
      : (event: WebMcpToolCallEvent): Promise<EvalTabResult> =>
          executeWebMcpToolInTab({
            arguments: JSON.stringify(event.arguments),
            definitionSignature: event.definitionSignature,
            documentId: event.documentId,
            scriptingApi,
            tabId: event.tabId,
            toolName: event.name,
          }),
});

export const handleTabDebuggerRequest = async ({
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
            ...(request.query === undefined ? {} : { query: request.query }),
            ...(request.textStart === undefined ? {} : { textStart: request.textStart }),
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

    if (request.type === WEB_MCP_DISCOVER_MESSAGE) {
      if (scriptingApi) {
        return {
          ok: true,
          result: await discoverWebMcpToolsInTab({
            scriptingApi,
            tabId: request.tabId,
          }),
          type: WEB_MCP_DISCOVER_MESSAGE,
        };
      }

      return { error: 'WebMCP discovery API is unavailable.', ok: false };
    }

    if (request.type === WEB_MCP_EXECUTE_MESSAGE) {
      if (scriptingApi) {
        return {
          ok: true,
          result: await executeWebMcpToolInTab({
            arguments: request.arguments,
            definitionSignature: request.definitionSignature,
            documentId: request.documentId,
            scriptingApi,
            tabId: request.tabId,
            toolName: request.toolName,
          }),
          type: WEB_MCP_EXECUTE_MESSAGE,
        };
      }

      return { error: 'WebMCP execution API is unavailable.', ok: false };
    }

    if (request.type === EVAL_TAB_MESSAGE) {
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
    }

    if (request.type === BROWSER_TOOL_MESSAGE) {
      if (tabsApi === undefined) {
        return { error: 'Browser tool API is unavailable.', ok: false };
      }

      wireBrowserToolSessionCleanup(tabsApi);

      // The tab left the extension's reach (closed, or a browser-internal page): dispose its session and report it.
      const reach = await getInspectableTab({ tabId: request.tabId, tabsApi });

      if (!reach.ok) {
        await disposeBrowserToolSession(request.tabId);

        return {
          ok: true,
          result: { error: reach.error, ok: false },
          type: BROWSER_TOOL_MESSAGE,
        };
      }

      const session = getOrCreateBrowserToolSession({
        debuggerApi,
        scriptingApi,
        tabId: request.tabId,
        tabsApi,
      });
      const result = await runKiloBrowserTool({
        arguments: request.arguments,
        options: {
          tabId: request.tabId,
          tabsApi,
          ...webMcpDispatchOptions(scriptingApi),
        },
        session,
        toolName: request.tool,
      });

      return { ok: true, result, type: BROWSER_TOOL_MESSAGE };
    }

    // Every schema-valid request type is handled above; this keeps the chain total for future message types.
    return { error: 'Unsupported tab debugger request.', ok: false };
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
