/* eslint-disable max-lines */
import { describe, expect, it } from 'vitest';
import {
  MAX_BROWSER_TOOL_CONSOLE_MESSAGES,
  MAX_BROWSER_TOOL_NETWORK_REQUESTS,
  createBrowserToolSession,
} from './browser-tool-session';
import { TAB_NOT_INSPECTABLE_ERROR } from './tab-debugger';
import type {
  BrowserTabsApi,
  ChromeDebuggerApi,
  ChromeDebuggerDetachListener,
  ChromeDebuggerEventListener,
  ChromeDebuggerTarget,
} from './tab-debugger';

const ENABLED_DOMAINS = [
  'Runtime.enable',
  'Log.enable',
  'Network.enable',
  'Page.enable',
  'DOM.enable',
  'Accessibility.enable',
];

const createDebuggerApi = ({
  documentNodeId = 11,
  gate,
}: {
  documentNodeId?: number;
  /** When set, `sendCommand` waits on `gate.wait` before resolving the gated method. */
  gate?: { readonly command: string; readonly wait: Promise<void> };
} = {}): {
  api: ChromeDebuggerApi;
  attachCalls: number[];
  commands: { method: string; params: Record<string, unknown> | undefined }[];
  detachCalls: number[];
  emitDetach: (tabId: number, reason?: string) => void;
  emitEvent: (tabId: number, method: string, params?: Record<string, unknown>) => void;
  setDocumentNodeId: (nextDocumentNodeId: number) => void;
} => {
  const attachCalls: number[] = [];
  const detachCalls: number[] = [];
  const commands: { method: string; params: Record<string, unknown> | undefined }[] = [];
  const detachListeners: ChromeDebuggerDetachListener[] = [];
  const eventListeners: ChromeDebuggerEventListener[] = [];
  let currentDocumentNodeId = documentNodeId;

  const api: ChromeDebuggerApi = {
    attach: (target: ChromeDebuggerTarget) => {
      attachCalls.push(target.tabId);
    },
    detach: (target: ChromeDebuggerTarget) => {
      detachCalls.push(target.tabId);
    },
    getTargets: () => [],
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
    sendCommand: async (_target, method, params) => {
      commands.push({ method, params });

      if (gate !== undefined && method === gate.command) {
        await gate.wait;
      }

      if (method === 'DOM.getDocument') {
        return { root: { nodeId: currentDocumentNodeId } };
      }

      if (method === 'DOM.querySelector') {
        return { nodeId: 42 };
      }

      return {};
    },
  };

  return {
    api,
    attachCalls,
    commands,
    detachCalls,
    emitDetach: (tabId, reason) => {
      for (const listener of detachListeners) {
        listener({ tabId }, reason);
      }
    },
    emitEvent: (tabId, method, params) => {
      for (const listener of eventListeners) {
        listener({ tabId }, method, params);
      }
    },
    setDocumentNodeId: nextDocumentNodeId => {
      currentDocumentNodeId = nextDocumentNodeId;
    },
  };
};

const createTabsApi = ({ url = 'https://example.com/' }: { url?: string } = {}): {
  api: BrowserTabsApi;
  emitRemoved: (tabId: number) => void;
} => {
  const removedListeners: ((tabId: number) => void)[] = [];

  return {
    api: {
      get: tabId => ({ id: tabId, title: 'Tab', url }),
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
      query: () => [],
    },
    emitRemoved: tabId => {
      for (const listener of removedListeners) {
        listener(tabId);
      }
    },
  };
};

const createSession = ({
  tabId = 7,
  url = 'https://example.com/',
  gate,
}: {
  tabId?: number;
  url?: string;
  gate?: { readonly command: string; readonly wait: Promise<void> };
} = {}) => {
  const debuggerApi = createDebuggerApi(gate === undefined ? {} : { gate });
  const tabsApi = createTabsApi({ url });

  return {
    debuggerApi,
    session: createBrowserToolSession({
      debuggerApi: debuggerApi.api,
      tabId,
      tabsApi: tabsApi.api,
    }),
    tabsApi,
  };
};

/**
 * Lets the attach chain run to the gated `sendCommand`, which is a macrotask
 * away because every earlier step resolves as a microtask.
 */
const flushPendingWork = (): Promise<void> =>
  // eslint-disable-next-line promise/avoid-new -- deterministic wait for the in-flight attach to reach the gated enable command
  new Promise<void>(resolve => {
    setTimeout(resolve, 0);
  });

/** A promise whose resolution the test controls, so it can hold one CDP command open. */
const createGate = (): { readonly release: () => void; readonly wait: Promise<void> } => {
  let release: (() => void) | undefined = undefined;
  // eslint-disable-next-line promise/avoid-new -- the test drives the moment the gated command resolves
  const wait = new Promise<void>(resolve => {
    release = () => {
      resolve();
    };
  });

  return {
    release: () => {
      release?.();
    },
    wait,
  };
};

describe('browser tool session', () => {
  it('attaches once, lazily, and enables every CDP domain before the first send', async () => {
    const { debuggerApi, session } = createSession();

    expect(session.isAttached()).toBe(false);
    expect(debuggerApi.attachCalls).toStrictEqual([]);

    await session.send('Runtime.evaluate', { expression: '1 + 1' });
    await session.send('Runtime.evaluate', { expression: '2 + 2' });

    expect(session.isAttached()).toBe(true);
    expect(debuggerApi.attachCalls).toStrictEqual([7]);
    expect(debuggerApi.commands).toStrictEqual([
      ...ENABLED_DOMAINS.map(method => ({ method, params: undefined })),
      { method: 'Runtime.evaluate', params: { expression: '1 + 1' } },
      { method: 'Runtime.evaluate', params: { expression: '2 + 2' } },
    ]);
  });

  it('buffers console messages from Runtime and Log events and drops the oldest past the bound', async () => {
    const { debuggerApi, session } = createSession();

    await session.attach();
    debuggerApi.emitEvent(7, 'Runtime.consoleAPICalled', {
      args: [
        { type: 'string', value: 'hello' },
        { type: 'number', value: 42 },
      ],
      timestamp: 1,
      type: 'warning',
    });
    // Another tab's events must not enter this session.
    debuggerApi.emitEvent(8, 'Runtime.consoleAPICalled', { args: [], type: 'log' });
    debuggerApi.emitEvent(7, 'Log.entryAdded', {
      entry: {
        level: 'error',
        text: 'boom',
        timestamp: 2,
        url: 'https://example.com/a.js',
      },
    });

    expect(session.consoleMessages()).toStrictEqual([
      { level: 'warning', text: 'hello 42', timestamp: 1 },
      { level: 'error', text: 'boom', timestamp: 2, url: 'https://example.com/a.js' },
    ]);

    const extraCount = MAX_BROWSER_TOOL_CONSOLE_MESSAGES + 5;

    for (const index of Array.from({ length: extraCount }, (_unused, value) => value)) {
      debuggerApi.emitEvent(7, 'Runtime.consoleAPICalled', {
        args: [{ type: 'string', value: `line ${index}` }],
        type: 'log',
      });
    }

    const messages = session.consoleMessages();

    expect(messages).toHaveLength(MAX_BROWSER_TOOL_CONSOLE_MESSAGES);
    expect(messages.at(-1)?.text).toBe(`line ${extraCount - 1}`);
    expect(messages.some(message => message.text === 'line 0')).toBe(false);
  });

  it('keys network requests by requestId and merges request, response and finish events', async () => {
    const { debuggerApi, session } = createSession();

    await session.attach();
    debuggerApi.emitEvent(7, 'Network.requestWillBeSent', {
      request: {
        headers: { 'x-test': '1' },
        method: 'POST',
        postData: '{"a":1}',
        url: 'https://example.com/api',
      },
      requestId: 'r1',
      timestamp: 10,
      type: 'XHR',
    });
    debuggerApi.emitEvent(7, 'Network.responseReceived', {
      requestId: 'r1',
      response: {
        headers: { 'content-type': 'application/json' },
        mimeType: 'application/json',
        status: 200,
        statusText: 'OK',
        url: 'https://example.com/api',
      },
      type: 'XHR',
    });
    debuggerApi.emitEvent(7, 'Network.loadingFinished', { requestId: 'r1', timestamp: 12 });

    expect(session.networkRequests()).toStrictEqual([
      {
        finishedAt: 12,
        method: 'POST',
        mimeType: 'application/json',
        postData: '{"a":1}',
        requestHeaders: { 'x-test': '1' },
        requestId: 'r1',
        resourceType: 'XHR',
        responseHeaders: { 'content-type': 'application/json' },
        startedAt: 10,
        status: 200,
        statusText: 'OK',
        url: 'https://example.com/api',
      },
    ]);
  });

  it('records failed requests and bounds the network buffer', async () => {
    const { debuggerApi, session } = createSession();

    await session.attach();
    debuggerApi.emitEvent(7, 'Network.requestWillBeSent', {
      request: { url: 'https://example.com/missing' },
      requestId: 'fail-1',
    });
    debuggerApi.emitEvent(7, 'Network.loadingFailed', {
      errorText: 'net::ERR_ABORTED',
      requestId: 'fail-1',
      timestamp: 5,
    });

    expect(session.networkRequests()).toStrictEqual([
      {
        failure: 'net::ERR_ABORTED',
        finishedAt: 5,
        requestId: 'fail-1',
        url: 'https://example.com/missing',
      },
    ]);

    for (const index of Array.from(
      { length: MAX_BROWSER_TOOL_NETWORK_REQUESTS + 3 },
      (_unused, value) => value
    )) {
      debuggerApi.emitEvent(7, 'Network.requestWillBeSent', {
        request: { url: `https://example.com/${index}` },
        requestId: `r-${index}`,
      });
    }

    const requests = session.networkRequests();

    expect(requests).toHaveLength(MAX_BROWSER_TOOL_NETWORK_REQUESTS);
    expect(requests.at(-1)?.requestId).toBe(`r-${MAX_BROWSER_TOOL_NETWORK_REQUESTS + 2}`);
    expect(requests.some(request => request.requestId === 'fail-1')).toBe(false);
  });

  it('hands the pending dialog to exactly one call and clears it on close', async () => {
    const { debuggerApi, session } = createSession();

    await session.attach();
    debuggerApi.emitEvent(7, 'Page.javascriptDialogOpening', {
      message: 'Are you sure?',
      type: 'confirm',
      url: 'https://example.com/',
    });

    expect(session.takeDialog()).toStrictEqual({
      message: 'Are you sure?',
      type: 'confirm',
      url: 'https://example.com/',
    });
    expect(session.takeDialog()).toBeUndefined();

    debuggerApi.emitEvent(7, 'Page.javascriptDialogOpening', { message: 'Bye', type: 'alert' });
    debuggerApi.emitEvent(7, 'Page.javascriptDialogClosed', {});

    expect(session.takeDialog()).toBeUndefined();
  });

  it('resolves a snapshot ref to its backend node id and a selector through the DOM domain', async () => {
    const { debuggerApi, session } = createSession();

    session.registerRefs([{ backendNodeId: 99, ref: 'e5' }]);

    await expect(session.resolveTarget('e5')).resolves.toStrictEqual({
      backendNodeId: 99,
      kind: 'ref',
      ref: 'e5',
    });
    await expect(session.resolveTarget('ref=e5')).resolves.toStrictEqual({
      backendNodeId: 99,
      kind: 'ref',
      ref: 'e5',
    });
    await expect(session.resolveTarget('e404')).resolves.toBeUndefined();
    await expect(session.resolveTarget('#submit')).resolves.toStrictEqual({
      kind: 'selector',
      nodeId: 42,
      selector: '#submit',
    });
    expect(
      debuggerApi.commands.filter(command => command.method === 'DOM.querySelector')
    ).toStrictEqual([{ method: 'DOM.querySelector', params: { nodeId: 11, selector: '#submit' } }]);
  });

  it('replaces the ref registry so an older snapshot ref cannot resolve', async () => {
    const { session } = createSession();

    session.registerRefs([{ backendNodeId: 1, ref: 'e1' }]);
    session.registerRefs([{ ref: 'e2', selector: '.later' }]);

    await expect(session.resolveTarget('e1')).resolves.toBeUndefined();
    await expect(session.resolveTarget('e2')).resolves.toStrictEqual({
      kind: 'selector',
      nodeId: 42,
      selector: '.later',
    });
  });

  it('clears state on Debugger.detach and attaches cleanly on the next call', async () => {
    const { debuggerApi, session } = createSession();

    await session.attach();
    debuggerApi.emitEvent(7, 'Runtime.consoleAPICalled', {
      args: [{ type: 'string', value: 'before detach' }],
      type: 'log',
    });
    session.registerRefs([{ backendNodeId: 1, ref: 'e1' }]);

    debuggerApi.emitDetach(7, 'canceled_by_user');

    expect(session.isAttached()).toBe(false);
    expect(session.consoleMessages()).toStrictEqual([]);
    await expect(session.resolveTarget('e1')).resolves.toBeUndefined();

    await session.send('Runtime.evaluate', {});

    expect(session.isAttached()).toBe(true);
    expect(debuggerApi.attachCalls).toStrictEqual([7, 7]);
  });

  it('disposes and detaches when the tab closes, and stays disposed', async () => {
    const { debuggerApi, session, tabsApi } = createSession();

    await session.attach();
    await session.send('Runtime.evaluate', {});

    tabsApi.emitRemoved(7);
    await session.dispose();

    expect(session.isAttached()).toBe(false);
    expect(debuggerApi.detachCalls).toStrictEqual([7]);
    await expect(session.send('Runtime.evaluate', {})).rejects.toThrow(
      'The browser tool session was disposed.'
    );
  });

  it('is idempotent on dispose and stops collecting events', async () => {
    const { debuggerApi, session } = createSession();

    await session.attach();
    await session.dispose();
    await session.dispose();

    debuggerApi.emitEvent(7, 'Runtime.consoleAPICalled', {
      args: [{ type: 'string', value: 'after dispose' }],
      type: 'log',
    });

    expect(debuggerApi.detachCalls).toStrictEqual([7]);
    expect(session.consoleMessages()).toStrictEqual([]);
  });

  it('refuses a tab the debugger cannot attach to', async () => {
    const { debuggerApi, session } = createSession({ url: 'chrome://settings' });

    await expect(session.attach()).rejects.toThrow(TAB_NOT_INSPECTABLE_ERROR);
    expect(debuggerApi.attachCalls).toStrictEqual([]);
    expect(session.isAttached()).toBe(false);
  });

  it('releases the debugger when dispose lands while attach is in flight', async () => {
    const enableGate = createGate();
    const { debuggerApi, session } = createSession({
      gate: { command: 'Accessibility.enable', wait: enableGate.wait },
    });

    const attachResult = session.attach();

    await flushPendingWork();

    const disposeResult = session.dispose();

    enableGate.release();
    await expect(attachResult).rejects.toThrow('The browser tool session was disposed.');
    await disposeResult;

    expect(session.isAttached()).toBe(false);
    expect(debuggerApi.attachCalls).toStrictEqual([7]);
    expect(debuggerApi.detachCalls).toStrictEqual([7]);
    await expect(session.send('Runtime.evaluate', {})).rejects.toThrow(
      'The browser tool session was disposed.'
    );
  });

  it('does not report attached when the debugger detaches while attach is in flight', async () => {
    const enableGate = createGate();
    const { debuggerApi, session } = createSession({
      gate: { command: 'Accessibility.enable', wait: enableGate.wait },
    });

    const attachResult = session.attach();

    await flushPendingWork();
    debuggerApi.emitDetach(7, 'canceled_by_user');
    enableGate.release();

    await expect(attachResult).rejects.toThrow('The debugger detached from the tab.');
    // The browser detached itself, so there is nothing left to release.
    expect(debuggerApi.detachCalls).toStrictEqual([]);
    expect(session.isAttached()).toBe(false);

    // The next call attaches again instead of trusting the lost session.
    await session.send('Runtime.evaluate', {});

    expect(session.isAttached()).toBe(true);
    expect(debuggerApi.attachCalls).toStrictEqual([7, 7]);
  });

  it('drops the cached document root and refs when the main frame navigates', async () => {
    const { debuggerApi, session } = createSession();

    session.registerRefs([{ backendNodeId: 1, ref: 'e1' }]);
    await expect(session.resolveTarget('#first')).resolves.toStrictEqual({
      kind: 'selector',
      nodeId: 42,
      selector: '#first',
    });

    debuggerApi.setDocumentNodeId(22);
    // A main-frame navigation replaces the document, so the root id and the refs are stale.
    debuggerApi.emitEvent(7, 'Page.frameNavigated', {
      frame: { url: 'https://example.com/next' },
    });

    await expect(session.resolveTarget('e1')).resolves.toBeUndefined();
    await expect(session.resolveTarget('#second')).resolves.toStrictEqual({
      kind: 'selector',
      nodeId: 42,
      selector: '#second',
    });
    expect(
      debuggerApi.commands
        .filter(command => command.method === 'DOM.querySelector')
        .map(command => command.params)
    ).toStrictEqual([
      { nodeId: 11, selector: '#first' },
      { nodeId: 22, selector: '#second' },
    ]);
  });

  it('keeps the document root across a subframe navigation and drops it on DOM.documentUpdated', async () => {
    const { debuggerApi, session } = createSession();

    await expect(session.resolveTarget('#frame')).resolves.toStrictEqual({
      kind: 'selector',
      nodeId: 42,
      selector: '#frame',
    });

    debuggerApi.setDocumentNodeId(22);
    // A subframe navigation leaves the main document's node ids valid.
    debuggerApi.emitEvent(7, 'Page.frameNavigated', {
      frame: { parentId: 'frame-1', url: 'https://example.com/frame' },
    });
    await expect(session.resolveTarget('#still')).resolves.toStrictEqual({
      kind: 'selector',
      nodeId: 42,
      selector: '#still',
    });

    debuggerApi.setDocumentNodeId(33);
    // DOM.documentUpdated reports the same replacement without a navigation event.
    debuggerApi.emitEvent(7, 'DOM.documentUpdated', {});
    await expect(session.resolveTarget('#fresh')).resolves.toStrictEqual({
      kind: 'selector',
      nodeId: 42,
      selector: '#fresh',
    });

    expect(
      debuggerApi.commands.filter(command => command.method === 'DOM.getDocument')
    ).toStrictEqual([
      { method: 'DOM.getDocument', params: { depth: 0 } },
      { method: 'DOM.getDocument', params: { depth: 0 } },
    ]);
    expect(
      debuggerApi.commands
        .filter(command => command.method === 'DOM.querySelector')
        .map(command => command.params)
    ).toStrictEqual([
      { nodeId: 11, selector: '#frame' },
      { nodeId: 11, selector: '#still' },
      { nodeId: 33, selector: '#fresh' },
    ]);
  });
});
