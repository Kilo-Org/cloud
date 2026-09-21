/* eslint-disable max-lines, require-await, typescript-eslint/require-await, unicorn/no-useless-undefined -- Fake extension runtime returns verbatim responses for assertions. */
import { describe, expect, it, vi } from 'vitest';
import { BROWSER_TOOL_MESSAGE, TAB_NOT_INSPECTABLE_ERROR } from '@/src/shared/tab-debugger';
import type {
  BrowserTabInfo,
  BrowserTabsApi,
  ChromeDebuggerApi,
  ChromeDebuggerDetachListener,
  ChromeDebuggerEventListener,
  TabDebuggerRequest,
} from '@/src/shared/tab-debugger';

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

const createFakeDebuggerApi = (): { api: ChromeDebuggerApi; state: FakeDebuggerState } => {
  const state: FakeDebuggerState = { attachCalls: 0, commands: [], detachCalls: 0 };
  const detachListeners: ChromeDebuggerDetachListener[] = [];
  const eventListeners: ChromeDebuggerEventListener[] = [];
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

const browserToolRequest = (
  tabId: number,
  tool: string,
  args: Record<string, unknown>
): TabDebuggerRequest => ({
  arguments: args,
  tabId,
  tool,
  type: BROWSER_TOOL_MESSAGE,
});

describe('background browser tool branch', () => {
  it('answers a browser tool message with the dispatch result', async () => {
    const { api: debuggerApi, state } = createFakeDebuggerApi();
    const tabs = new Map([[41, { id: 41, title: 'Example', url: 'https://example.com/' }]]);
    const { api: tabsApi } = createFakeTabsApi(tabs);

    const response = await handleTabDebuggerRequest({
      debuggerApi,
      request: browserToolRequest(41, 'kilo_browser_navigate', {
        url: 'https://example.com/other',
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
    const request = browserToolRequest(42, 'kilo_browser_navigate', {
      url: 'https://example.com/',
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
      request: browserToolRequest(43, 'kilo_browser_navigate', { url: 'https://example.com/' }),
      scriptingApi: undefined,
      tabsApi,
    });

    expect(first).toMatchObject({ ok: true, type: BROWSER_TOOL_MESSAGE });

    tabs.set(43, { id: 43, title: 'Settings', url: 'chrome://settings' });

    const second = await handleTabDebuggerRequest({
      debuggerApi,
      request: browserToolRequest(43, 'kilo_browser_navigate', { url: 'https://example.com/' }),
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
      request: browserToolRequest(46, 'kilo_browser_resize', { height: 600, width: 800 }),
      scriptingApi: undefined,
      tabsApi,
    });

    tabs.set(46, { id: 46, title: 'Settings', url: 'chrome://settings' });

    await handleTabDebuggerRequest({
      debuggerApi,
      request: browserToolRequest(46, 'kilo_browser_navigate', { url: 'https://example.com/' }),
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
      request: browserToolRequest(44, 'kilo_browser_snapshot', {}),
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
      request: browserToolRequest(45, 'kilo_browser_click', { bogus: true, target: 'e1' }),
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

describe('background trusted-sender gate over the browser tool message', () => {
  it('ignores the browser tool message from a content-script sender', () => {
    const listener = harness.onMessageListeners.at(-1);

    expect(listener).toBeDefined();

    const sendResponse = vi.fn();
    const result = listener?.(
      browserToolRequest(50, 'kilo_browser_navigate', { url: 'https://example.com/' }),
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
      browserToolRequest(52, 'kilo_browser_navigate', { url: 'https://example.com/' }),
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
