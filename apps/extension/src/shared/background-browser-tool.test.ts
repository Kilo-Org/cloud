/* eslint-disable max-lines, require-await, typescript-eslint/require-await, unicorn/no-useless-undefined -- Fake extension runtime returns verbatim responses for assertions. */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  BROWSER_TOOL_MESSAGE,
  DISPOSE_BROWSER_CALLER_MESSAGE,
  TAB_NOT_INSPECTABLE_ERROR,
} from '@/src/shared/tab-debugger';
import type {
  BrowserTabInfo,
  BrowserTabsApi,
  ChromeDebuggerApi,
  ChromeDebuggerDetachListener,
  ChromeDebuggerEventListener,
  TabDebuggerRequest,
} from '@/src/shared/tab-debugger';
import { startDownloadHold } from '@/src/shared/browser-download-hold-host';

/*
 * The WXT `defineBackground` global only exists inside the bundler. Stubbing
 * it before the import runs the background's registration body once, against
 * the fake `chrome` below, so the onMessage listener path is exercisable.
 */
const harness = vi.hoisted(() => {
  type OnMessageListener = (
    message: unknown,
    sender: unknown,
    sendResponse: (response: unknown) => void
  ) => boolean | void;

  const onMessageListeners: OnMessageListener[] = [];

  (globalThis as Record<string, unknown>)['defineBackground'] = (factory: () => void): void => {
    factory();
  };
  (globalThis as Record<string, unknown>)['chrome'] = {
    runtime: {
      id: 'kilo-test-extension-id',
      onMessage: {
        addListener: (listener: OnMessageListener): void => {
          onMessageListeners.push(listener);
        },
      },
    },
  };

  return { onMessageListeners };
});

// eslint-disable-next-line import/first
import { handleTabDebuggerRequest } from '../../entrypoints/background';

interface FakeDebuggerState {
  attachCalls: number;
  commands: { method: string; params?: Record<string, unknown> }[];
  detachCalls: number;
}

const createFakeDebuggerApi = (
  options: { readonly opensDialogOn?: string | undefined } = {}
): { api: ChromeDebuggerApi; state: FakeDebuggerState } => {
  const state: FakeDebuggerState = { attachCalls: 0, commands: [], detachCalls: 0 };
  const detachListeners: ChromeDebuggerDetachListener[] = [];
  const eventListeners: ChromeDebuggerEventListener[] = [];
  let dialogEmitted = false;
  const api: ChromeDebuggerApi = {
    attach: async () => {
      state.attachCalls += 1;
    },
    detach: async () => {
      state.detachCalls += 1;
    },
    getTargets: async () => [],
    onDetach: {
      addListener: listener => {
        detachListeners.push(listener);
      },
      removeListener: listener => {
        const index = detachListeners.indexOf(listener);

        if (index !== -1) {
          detachListeners.splice(index, 1);
        }
      },
    },
    onEvent: {
      addListener: listener => {
        eventListeners.push(listener);
      },
      removeListener: listener => {
        const index = eventListeners.indexOf(listener);

        if (index !== -1) {
          eventListeners.splice(index, 1);
        }
      },
    },
    sendCommand: async (_target, method, commandParams) => {
      state.commands.push({
        method,
        ...(commandParams === undefined ? {} : { params: commandParams }),
      });

      // A page's own script opens the dialog while the call runs, as a click's handler would.
      if (options.opensDialogOn === method && !dialogEmitted) {
        dialogEmitted = true;

        for (const listener of eventListeners) {
          listener({}, 'Page.javascriptDialogOpening', {
            frameId: 'main',
            message: 'Saved',
            type: 'alert',
            url: 'https://example.com/',
          });
        }
      }

      if (method === 'Runtime.evaluate') {
        const expression = commandParams?.['expression'];

        return typeof expression === 'string' && expression.includes('readyState')
          ? { result: { value: 'complete' } }
          : { result: { value: { title: 'Example', url: 'https://example.com/' } } };
      }

      return {};
    },
  };

  return { api, state };
};

interface FakeTabsState {
  removedListeners: ((tabId: number) => void)[];
}

const createFakeTabsApi = (
  tabs: Map<number, BrowserTabInfo>
): { api: BrowserTabsApi; state: FakeTabsState } => {
  const removedListeners: ((tabId: number) => void)[] = [];
  const api: BrowserTabsApi = {
    get: async tabId => {
      const tab = tabs.get(tabId);

      if (tab === undefined) {
        throw new Error(`No tab with id: ${String(tabId)}`);
      }

      return tab;
    },
    onRemoved: {
      addListener: listener => {
        removedListeners.push(listener);
      },
      removeListener: listener => {
        const index = removedListeners.indexOf(listener);

        if (index !== -1) {
          removedListeners.splice(index, 1);
        }
      },
    },
    query: async () => [...tabs.values()],
  };

  return { api, state: { removedListeners } };
};

/** One browser tool message: the call the model made, and the panel's mode when it has one. */
const toolRequest = (call: {
  readonly args?: Record<string, unknown>;
  readonly safeMode?: boolean;
  readonly tabId: number;
  readonly tool: string;
}): TabDebuggerRequest => ({
  ...(call.safeMode === undefined ? {} : { safeMode: call.safeMode }),
  arguments: call.args ?? {},
  caller: { conversationId: 'conversation-1', kind: 'panel', panelId: 'panel-1' },
  tabId: call.tabId,
  tool: call.tool,
  type: BROWSER_TOOL_MESSAGE,
});

/** The text a browser tool answer carries, for the branches that answer with a result. */
const modalTextOf = (response: unknown): string => {
  const parsed = z
    .object({
      ok: z.literal(true),
      result: z.object({ ok: z.boolean(), value: z.unknown().optional() }),
      type: z.literal(BROWSER_TOOL_MESSAGE),
    })
    .safeParse(response);
  const value = parsed.success ? parsed.data.result.value : undefined;

  return typeof value === 'string' ? value : '';
};

describe('background browser tool branch', () => {
  it('tells a safe-mode message the dialog is the user’s to answer, naming no tool it cannot call', async () => {
    // The page opens a dialog while the tool runs; its frame carries the origin the answer is judged by.
    const { api: debuggerApi } = createFakeDebuggerApi({ opensDialogOn: 'Runtime.evaluate' });
    const tabs = new Map([[41, { id: 41, title: 'Example', url: 'https://example.com/' }]]);
    const { api: tabsApi } = createFakeTabsApi(tabs);

    const response = await handleTabDebuggerRequest({
      debuggerApi,
      request: toolRequest({ safeMode: true, tabId: 41, tool: 'kilo_browser_snapshot' }),
      scriptingApi: undefined,
      tabsApi,
    });

    // Through the whole message path: the background passes the mode to the runtime, which answers the modal state.
    expect(modalTextOf(response)).toContain(
      'answer it on the page; this mode cannot answer dialogs'
    );
  });

  it('names the handler to a danger-mode message, which can answer the same dialog', async () => {
    const { api: debuggerApi } = createFakeDebuggerApi({ opensDialogOn: 'Runtime.evaluate' });
    const tabs = new Map([[41, { id: 41, title: 'Example', url: 'https://example.com/' }]]);
    const { api: tabsApi } = createFakeTabsApi(tabs);

    const response = await handleTabDebuggerRequest({
      debuggerApi,
      request: toolRequest({ tabId: 41, tool: 'kilo_browser_snapshot' }),
      scriptingApi: undefined,
      tabsApi,
    });

    expect(modalTextOf(response)).toContain('can be handled by kilo_browser_handle_dialog');
  });

  it('answers a browser tool message with the dispatch result', async () => {
    const { api: debuggerApi, state } = createFakeDebuggerApi();
    const tabs = new Map([[41, { id: 41, title: 'Example', url: 'https://example.com/' }]]);
    const { api: tabsApi } = createFakeTabsApi(tabs);

    const response = await handleTabDebuggerRequest({
      debuggerApi,
      request: toolRequest({
        args: {
          url: 'https://example.com/other',
        },
        tabId: 41,
        tool: 'kilo_browser_navigate',
      }),
      scriptingApi: undefined,
      tabsApi,
    });

    expect(response).toStrictEqual({
      ok: true,
      result: { ok: true, value: { title: 'Example', url: 'https://example.com/' } },
      type: BROWSER_TOOL_MESSAGE,
    });
    expect(state.commands.map(command => command.method)).toContain('Page.navigate');
  });

  it('reuses the per-tab session across calls and disposes it when the tab closes', async () => {
    const { api: debuggerApi, state } = createFakeDebuggerApi();
    const tabs = new Map([[42, { id: 42, title: 'Example', url: 'https://example.com/' }]]);
    const { api: tabsApi, state: tabsState } = createFakeTabsApi(tabs);
    const request = toolRequest({
      args: {
        url: 'https://example.com/',
      },
      tabId: 42,
      tool: 'kilo_browser_navigate',
    });

    await handleTabDebuggerRequest({ debuggerApi, request, scriptingApi: undefined, tabsApi });
    await handleTabDebuggerRequest({ debuggerApi, request, scriptingApi: undefined, tabsApi });

    // The same session served both calls: one debugger attach.
    expect(state.attachCalls).toBe(1);

    for (const listener of tabsState.removedListeners) {
      listener(42);
    }
    await vi.waitFor(() => {
      expect(state.detachCalls).toBe(1);
    });

    await handleTabDebuggerRequest({ debuggerApi, request, scriptingApi: undefined, tabsApi });

    // The disposed session was evicted: the next call creates and attaches a fresh one.
    expect(state.attachCalls).toBe(2);
  });

  it('disposes the session and reports the uninspectable error when the tab leaves the extension reach', async () => {
    const { api: debuggerApi } = createFakeDebuggerApi();
    const tabs = new Map([[43, { id: 43, title: 'Example', url: 'https://example.com/' }]]);
    const { api: tabsApi } = createFakeTabsApi(tabs);

    const first = await handleTabDebuggerRequest({
      debuggerApi,
      request: toolRequest({
        args: { url: 'https://example.com/' },
        tabId: 43,
        tool: 'kilo_browser_navigate',
      }),
      scriptingApi: undefined,
      tabsApi,
    });

    expect(first).toMatchObject({ ok: true, type: BROWSER_TOOL_MESSAGE });

    tabs.set(43, { id: 43, title: 'Settings', url: 'chrome://settings' });

    const second = await handleTabDebuggerRequest({
      debuggerApi,
      request: toolRequest({
        args: { url: 'https://example.com/' },
        tabId: 43,
        tool: 'kilo_browser_navigate',
      }),
      scriptingApi: undefined,
      tabsApi,
    });

    expect(second).toStrictEqual({
      ok: true,
      result: { error: TAB_NOT_INSPECTABLE_ERROR, ok: false },
      type: BROWSER_TOOL_MESSAGE,
    });
  });

  it('clears a browser_resize override when the tab leaves the extension reach', async () => {
    const { api: debuggerApi, state } = createFakeDebuggerApi();
    const tabs = new Map([[46, { id: 46, title: 'Example', url: 'https://example.com/' }]]);
    const { api: tabsApi } = createFakeTabsApi(tabs);

    await handleTabDebuggerRequest({
      debuggerApi,
      request: toolRequest({
        args: { height: 600, width: 800 },
        tabId: 46,
        tool: 'kilo_browser_resize',
      }),
      scriptingApi: undefined,
      tabsApi,
    });

    tabs.set(46, { id: 46, title: 'Settings', url: 'chrome://settings' });

    await handleTabDebuggerRequest({
      debuggerApi,
      request: toolRequest({
        args: { url: 'https://example.com/' },
        tabId: 46,
        tool: 'kilo_browser_navigate',
      }),
      scriptingApi: undefined,
      tabsApi,
    });

    const methods = state.commands.map(command => command.method);

    expect(methods).toContain('Emulation.setDeviceMetricsOverride');
    expect(methods).toContain('Emulation.clearDeviceMetricsOverride');
  });

  it('reports a missing tabs API instead of creating a session', async () => {
    const { api: debuggerApi } = createFakeDebuggerApi();

    const response = await handleTabDebuggerRequest({
      debuggerApi,
      request: toolRequest({ tabId: 44, tool: 'kilo_browser_snapshot' }),
      scriptingApi: undefined,
      tabsApi: undefined,
    });

    expect(response).toStrictEqual({ error: 'Browser tool API is unavailable.', ok: false });
  });

  it('surfaces a dispatch validation failure as the tool result', async () => {
    const { api: debuggerApi, state } = createFakeDebuggerApi();
    const tabs = new Map([[45, { id: 45, title: 'Example', url: 'https://example.com/' }]]);
    const { api: tabsApi } = createFakeTabsApi(tabs);

    const response = await handleTabDebuggerRequest({
      debuggerApi,
      request: toolRequest({
        args: { bogus: true, target: 'e1' },
        tabId: 45,
        tool: 'kilo_browser_click',
      }),
      scriptingApi: undefined,
      tabsApi,
    });

    expect(response).toStrictEqual({
      ok: true,
      result: {
        error: 'Invalid arguments for kilo_browser_click: unknown argument "bogus".',
        ok: false,
      },
      type: BROWSER_TOOL_MESSAGE,
    });
    // No page command may run for an invalid call.
    expect(state.commands).toStrictEqual([]);
  });
});

describe('the cached browser runtime', () => {
  /**
   * The defect this covers: the panel path built the runtime without the hold, and the runtime cache is keyed by the
   * tabs API alone. The agent bridge then reused that runtime for the rest of the worker's life, with no hold: every
   * agent download fell back to the cancel-after-start guard.
   */
  it('keeps the hold when a panel message created the runtime first', async () => {
    const { api: debuggerApi } = createFakeDebuggerApi();
    const tabs = new Map([[60, { id: 60, title: 'Example', url: 'https://example.com/' }]]);
    const { api: tabsApi } = createFakeTabsApi(tabs);
    const closed: string[] = [];
    const hold = {
      announce: () => undefined,
      arm: () => undefined,
      closeSession: (session: string) => {
        closed.push(session);
      },
      drain: () => [],
      handle: () => false,
      navigate: () => undefined,
      needOf: () => undefined,
      settle: async () => 'no_sign' as const,
      tab: () => undefined,
      tracked: () => undefined,
    };
    const agentCaller = {
      controllerId: 'controller-1',
      kind: 'agent',
      sessionHandle: 'session-1',
    } as const;

    // The panel's message is the first one this worker sees: it creates the one runtime for this tabs API.
    await handleTabDebuggerRequest({
      debuggerApi,
      downloadHold: hold,
      request: toolRequest({
        args: { url: 'https://example.com/' },
        tabId: 60,
        tool: 'kilo_browser_navigate',
      }),
      scriptingApi: undefined,
      tabsApi,
    });

    // The agent's session ends through the same cached runtime: the hold is part of it, so the session closes there.
    const response = await handleTabDebuggerRequest({
      debuggerApi,
      downloadHold: hold,
      request: { caller: agentCaller, type: DISPOSE_BROWSER_CALLER_MESSAGE },
      scriptingApi: undefined,
      tabsApi,
    });

    expect(response).toMatchObject({ ok: true, type: DISPOSE_BROWSER_CALLER_MESSAGE });
    expect(closed).toStrictEqual(['session-1']);
  });
});

describe('the hold a browser is given', () => {
  /**
   * The defect this covers: the request handler was handed a hold unconditionally, and `downloadTierOf` reads
   * `hasHold: downloadHold !== undefined`. A browser whose `chrome.downloads` has no `onDeterminingFilename` — Firefox —
   * was therefore given the hold tier, where nothing was ever registered, and `legacy` — the cancel-after-start guard
   * the extension keeps there — was unreachable from the agent bridge.
   */
  it('gives a browser without the event no hold, so the legacy guard is the one that arms', () => {
    const downloads = { cancel: async () => undefined };

    // A Firefox extension: its own origin is `moz-extension://`, and its downloads API has no hold event at all.
    expect(
      startDownloadHold({
        downloads: () => downloads,
        extensionOrigin: () => 'moz-extension://kilo-test-extension-id/',
        sessionStorage: () => undefined,
      })
    ).toBeUndefined();

    // Chrome keeps the hold, whether or not the optional permission has been granted yet: the grant is what makes the
    // Event exist there, and the listener is installed again from `permissions.onAdded` when it arrives.
    expect(
      startDownloadHold({
        downloads: () => ({
          cancel: async () => undefined,
          onDeterminingFilename: { addListener: () => undefined },
        }),
        extensionOrigin: () => 'chrome-extension://kilo-test-extension-id/',
        sessionStorage: () => undefined,
      })
    ).toBeDefined();
  });
});

describe('background trusted-sender gate over the browser tool message', () => {
  it('ignores the browser tool message from a content-script sender', () => {
    const listener = harness.onMessageListeners.at(-1);

    expect(listener).toBeDefined();

    const sendResponse = vi.fn();
    const result = listener?.(
      toolRequest({
        args: { url: 'https://example.com/' },
        tabId: 50,
        tool: 'kilo_browser_navigate',
      }),
      // A content script shares the extension id but reports the host page's web origin.
      { id: 'kilo-test-extension-id', origin: 'https://evil.example' },
      sendResponse
    );

    expect(result).toBeUndefined();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('answers a browser tool message from a trusted extension-page sender through the onMessage listener', async () => {
    const listener = harness.onMessageListeners.at(-1);

    expect(listener).toBeDefined();

    const sendResponse = vi.fn();
    const returned = listener?.(
      toolRequest({
        args: { url: 'https://example.com/' },
        tabId: 52,
        tool: 'kilo_browser_navigate',
      }),
      {
        id: 'kilo-test-extension-id',
        origin: 'chrome-extension://kilo-test-extension-id/entrypoints/sidepanel.html',
      },
      sendResponse
    );

    // Returning true keeps the message channel open for the async answer.
    expect(returned).toBe(true);
    await vi.waitFor(() => {
      expect(sendResponse.mock.calls.at(0)?.[0]).toMatchObject({ ok: false });
    });

    // The registration fake has no tabs API, so the branch refuses before creating a session — but the trusted sender got an answer.
    expect(sendResponse.mock.calls[0]?.[0]).toStrictEqual({
      error: 'Browser tool API is unavailable.',
      ok: false,
    });
  });
});
