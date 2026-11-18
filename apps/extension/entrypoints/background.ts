/* eslint-disable import/max-dependencies, max-lines */
import { storage } from '#imports';
import { z } from 'zod';
import { buildPendingMemoryDraft } from '@/src/shared/agent-memories';
import { savePendingAgentMemoryDraft } from '@/src/shared/agent-memories-storage';
import type { WebMcpToolCallEvent } from '@/src/shared/agent-conversation';
import type { BrowserToolDispatchOptions } from '@/src/shared/browser-tool-dispatch';
import { createBrowserRuntime } from '@/src/shared/browser-runtime';
import type { BrowserRuntime } from '@/src/shared/browser-runtime';
import { createBrowserTabGroupController } from '@/src/shared/browser-tab-groups';
import type { BrowserTabGroupsApi } from '@/src/shared/browser-tab-groups';
import {
  createStorageSessionLeasePersistence,
  createTabLeaseRegistry,
} from '@/src/shared/browser-tab-leases';
import { createRuntimeBrowserBridge } from '@/src/shared/local-agents/browser-bridge';
import { readLocalAgentsHostApis, startLocalAgentsHost } from '@/src/shared/local-agents/host';
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
  CLAIM_TAB_MESSAGE,
  DISPOSE_BROWSER_CALLER_MESSAGE,
  EVAL_TAB_MESSAGE,
  LIST_INSPECTABLE_TABS_MESSAGE,
  PAGE_SNAPSHOT_MESSAGE,
  RELEASE_BROWSER_CALLER_MESSAGE,
  VIEWPORT_SCREENSHOT_MESSAGE,
  WEB_MCP_DISCOVER_MESSAGE,
  WEB_MCP_EXECUTE_MESSAGE,
  discoverWebMcpToolsInTab,
  executeWebMcpToolInTab,
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
 * One browser runtime per tabs API — in the browser, the one `chrome.tabs`
 * object. Every browser-tool and eval message goes through it: it owns the
 * per-tab lease, the single debugger attachment per tab, one ref registry per
 * caller, and the serial call chain. Where `debuggerApi` is absent (Firefox)
 * the tab session builds the scripting backend.
 */
const browserRuntimes = new WeakMap<BrowserTabsApi, BrowserRuntime>();

// One onRemoved listener per tabs API, wired lazily on the first message; the WeakSet keeps a second registration a no-op.
const runtimeCleanupWiredTabsApis = new WeakSet<BrowserTabsApi>();

/** `chrome.tabs.group` is the one tab-group call that lives on the tabs API; the rest are `chrome.tabGroups`. */
type NativeTabsApi = BrowserTabsApi & Pick<BrowserTabGroupsApi, 'group'>;

export const getBrowserRuntime = ({
  debuggerApi,
  scriptingApi,
  tabGroupsApi,
  tabsApi,
}: {
  readonly debuggerApi: ChromeDebuggerApi | undefined;
  readonly scriptingApi: BrowserScriptingApi | undefined;
  /** Absent on Firefox or without the `tabGroups` permission: sessions track their tabs by id. */
  readonly tabGroupsApi?: BrowserTabGroupsApi | undefined;
  readonly tabsApi: NativeTabsApi;
}): BrowserRuntime => {
  const existing = browserRuntimes.get(tabsApi);

  if (existing !== undefined) {
    return existing;
  }

  const runtime = createBrowserRuntime({
    debuggerApi,
    leases: createTabLeaseRegistry({
      persistence: createStorageSessionLeasePersistence(storage),
    }),
    scriptingApi,
    // Every session gets its group `Kilo · <title>`; an ended one collapses, greys and stays adoptable (D12).
    ...(tabGroupsApi === undefined
      ? {}
      : {
          tabGroups: createBrowserTabGroupController({
            api: {
              ...(tabGroupsApi.group === undefined
                ? {}
                : { group: tabGroupsApi.group.bind(tabGroupsApi) }),
              tabQuery: query => tabsApi.query(query),
              ...(tabGroupsApi.update === undefined
                ? {}
                : {
                    update: async (groupId, props) => {
                      await tabGroupsApi.update?.(groupId, props);
                    },
                  }),
            },
          }),
        }),
    tabsApi,
  });

  browserRuntimes.set(tabsApi, runtime);

  if (!runtimeCleanupWiredTabsApis.has(tabsApi)) {
    runtimeCleanupWiredTabsApis.add(tabsApi);
    tabsApi.onRemoved?.addListener(tabId => {
      void runtime.disposeTab(tabId);
    });
    // A tab opened from a tab in a session's group joins that session (D9).
    tabsApi.onCreated?.addListener(tab => {
      if (tab.id !== undefined) {
        void runtime.noteTabCreated(tab.id, tab.openerTabId);
      }
    });
  }

  return runtime;
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
  tabGroupsApi,
  tabsApi,
}: {
  debuggerApi: ChromeDebuggerApi | undefined;
  request: TabDebuggerRequest;
  scriptingApi: BrowserScriptingApi | undefined;
  tabGroupsApi?: BrowserTabGroupsApi | undefined;
  tabsApi: NativeTabsApi | undefined;
}): Promise<TabDebuggerResponse> => {
  // One runtime per tabs API, and the same tab-group surface for the panel and the agent bridge.
  const runtimeFor = (tabs: NativeTabsApi): BrowserRuntime =>
    getBrowserRuntime({ debuggerApi, scriptingApi, tabGroupsApi, tabsApi: tabs });

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
      if (tabsApi === undefined) {
        return { error: 'Tab evaluation API is unavailable.', ok: false };
      }

      const runtime = runtimeFor(tabsApi);

      return {
        ok: true,
        result: await runtime.evalInTab({
          caller: request.caller,
          code: request.code,
          tabId: request.tabId,
          ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
        }),
        type: EVAL_TAB_MESSAGE,
      };
    }

    if (request.type === CLAIM_TAB_MESSAGE) {
      if (tabsApi === undefined) {
        return { error: 'Tab lease API is unavailable.', ok: false };
      }

      const runtime = runtimeFor(tabsApi);

      return {
        granted: await runtime.claimTab({
          caller: request.caller,
          ...(request.from === undefined ? {} : { from: request.from }),
          tabId: request.tabId,
        }),
        ok: true,
        type: CLAIM_TAB_MESSAGE,
      };
    }

    if (request.type === RELEASE_BROWSER_CALLER_MESSAGE) {
      const runtime = tabsApi === undefined ? undefined : runtimeFor(tabsApi);

      return {
        ok: true,
        released: runtime?.releaseCaller(request.caller) ?? 0,
        type: RELEASE_BROWSER_CALLER_MESSAGE,
      };
    }

    if (request.type === DISPOSE_BROWSER_CALLER_MESSAGE) {
      const runtime = tabsApi === undefined ? undefined : runtimeFor(tabsApi);

      return {
        ok: true,
        released: runtime?.disposeCaller(request.caller) ?? 0,
        type: DISPOSE_BROWSER_CALLER_MESSAGE,
      };
    }

    if (request.type === BROWSER_TOOL_MESSAGE) {
      if (tabsApi === undefined) {
        return { error: 'Browser tool API is unavailable.', ok: false };
      }

      const runtime = runtimeFor(tabsApi);
      const outcome = await runtime.runTool({
        ...(request.agent === undefined ? {} : { agent: request.agent }),
        arguments: request.arguments,
        caller: request.caller,
        options: webMcpDispatchOptions(scriptingApi),
        tabId: request.tabId,
        ...(request.takeOver === undefined ? {} : { takeOver: request.takeOver }),
        toolName: request.tool,
      });

      if (outcome.kind === 'needs_permission') {
        return {
          ok: true,
          permission: {
            items: outcome.items.map(item => ({ ...item })),
            ...(outcome.stepToken === undefined ? {} : { stepToken: outcome.stepToken }),
          },
          result: outcome.result,
          type: BROWSER_TOOL_MESSAGE,
        };
      }

      if (outcome.kind === 'origin_changed') {
        return {
          ok: true,
          originChanged: { from: outcome.from, to: outcome.to },
          result: outcome.result,
          type: BROWSER_TOOL_MESSAGE,
        };
      }

      if (outcome.kind === 'needs_take_over') {
        return {
          ok: true,
          takeOver: {
            holderKind: 'agent',
            sessionTitle: outcome.holder.title ?? 'Kilo CLI session',
            tabId: request.tabId,
          },
          type: BROWSER_TOOL_MESSAGE,
        };
      }

      return {
        ok: true,
        result: outcome.result,
        type: BROWSER_TOOL_MESSAGE,
        ...(outcome.withheldFrames === undefined ? {} : { withheldFrames: outcome.withheldFrames }),
      };
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
        tabGroups?: BrowserTabGroupsApi;
        tabs?: NativeTabsApi;
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

  // Local agents register every listener here so one service-worker wake serves either feature.
  // The bridge resolves the runtime lazily: a CLI session opens it, not every worker boot.
  const tabsApi = chromeApi?.tabs;
  const debuggerApi = chromeApi?.debugger;
  const scriptingApi = chromeApi?.scripting;
  const tabGroupsApi = chromeApi?.tabGroups;
  startLocalAgentsHost({
    ...readLocalAgentsHostApis(),
    ...(tabsApi === undefined
      ? {}
      : {
          bridge: createRuntimeBrowserBridge({
            activeTabId: async () => {
              const tabs = await tabsApi.query({ active: true, lastFocusedWindow: true });

              return tabs[0]?.id;
            },
            runtime: () => getBrowserRuntime({ debuggerApi, scriptingApi, tabGroupsApi, tabsApi }),
          }),
        }),
  });

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
        tabGroupsApi: chromeApi.tabGroups,
        tabsApi: chromeApi.tabs,
      });
      sendResponse(response);
    })();

    return true;
  });
});
