/* eslint-disable max-lines, max-classes-per-file -- the page-global fakes below need several instanceof-identity classes in this one test file */
import { describe, expect, it } from 'vitest';
import {
  FIREFOX_PLATFORM_LIMIT,
  FIREFOX_UNSUPPORTED_BROWSER_TOOLS,
  MAX_BROWSER_TOOL_CONSOLE_MESSAGES,
  MAX_BROWSER_TOOL_NETWORK_REQUESTS,
  createBrowserToolSession,
  getFirefoxUnsupportedToolError,
} from './browser-tool-session';
import { TAB_NOT_INSPECTABLE_ERROR } from './tab-debugger';
import type {
  BrowserScriptingApi,
  BrowserScriptingInjectionResult,
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

/**
 * Stands in for `browser.scripting.executeScript`: it records the injected
 * page code and returns the envelope `buildWorkflowPageCode` produces around a
 * script that returns `{ done: true, result }`, so the session's scripting path
 * is exercised without a real page.
 */
const createScriptingApi = (
  resultForCode: (code: string) => unknown = () => 'ok'
): {
  readonly api: BrowserScriptingApi;
  readonly codes: string[];
} => {
  const codes: string[] = [];
  const api: BrowserScriptingApi = {
    executeScript: <InjectionResult>(details: {
      readonly args: string[];
      readonly func: (...args: string[]) => InjectionResult;
      readonly target: { readonly tabId: number; readonly documentIds?: string[] };
      readonly world: 'MAIN';
    }): Promise<BrowserScriptingInjectionResult[]> => {
      const code = details.args[0] ?? '';

      codes.push(code);

      const payload = resultForCode(code);

      return Promise.resolve([
        { documentId: 'doc-1', result: { ok: true, value: { done: true, result: payload } } },
      ]);
    },
  };

  return { api, codes };
};

const createScriptingSession = (options: { readonly result?: (code: string) => unknown } = {}) => {
  const scriptingApi = createScriptingApi(options.result);
  const tabsApi = createTabsApi();

  return {
    scriptApi: scriptingApi,
    session: createBrowserToolSession({
      scriptingApi: scriptingApi.api,
      tabId: 7,
      tabsApi: tabsApi.api,
    }),
  };
};

/**
 * Runs the wrapped page code exactly like `runInjectedEval` in tab-debugger.ts
 * runs it in the real MAIN world. The workflow wrapper only passes `page` into
 * the compiled body form, so a page script referencing the wrapper's own
 * consts (`fillElement`, `sleepMs`) throws a ReferenceError here exactly as it
 * would in Firefox — this is what proves the scripting actions are
 * self-contained.
 */
const executeWrappedPageCode = (code: string): Promise<unknown> =>
  // eslint-disable-next-line eslint/no-new-func, typescript-eslint/no-implied-eval, typescript-eslint/no-unsafe-call, typescript-eslint/no-unsafe-return -- mirrors the real injection in tab-debugger.ts
  new Function(`return (async () => { ${code} })()`)();

// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the test installs and restores page globals by name
const globalScope = globalThis as unknown as Record<string, unknown>;

/** Installs the named page globals for the duration of `run`, then restores the previous values. */
const withPageGlobals = async (
  globals: Record<string, unknown>,
  run: () => Promise<void>
): Promise<void> => {
  const previous = new Map<string, unknown>();

  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, globalScope[key]);
    globalScope[key] = value;
  }

  try {
    await run();
  } finally {
    for (const [key, value] of previous) {
      globalScope[key] = value;
    }
  }
};

class FakeEvent {
  readonly type: string;

  constructor(type: string) {
    this.type = type;
  }
}

class FakeKeyboardEvent {
  readonly key: string;
  readonly type: string;

  constructor(type: string, init?: { readonly key?: string }) {
    this.type = type;
    this.key = init?.key ?? '';
  }
}

/** Stands in for `HTMLInputElement`: a real value accessor so the native-setter path in `__fillElement` runs. */
class FakeInputElement {
  #value = '';
  readonly events: { type: string; key?: string }[] = [];
  form = null;
  isContentEditable = false;

  get value(): string {
    return this.#value;
  }

  set value(next: unknown) {
    this.#value = String(next);
  }

  dispatchEvent(event: { readonly key?: string; readonly type: string }): void {
    this.events.push(
      event.key === undefined ? { type: event.type } : { key: event.key, type: event.type }
    );
  }

  focus(): void {}

  getBoundingClientRect(): { height: number; left: number; top: number; width: number } {
    return { height: 10, left: 0, top: 0, width: 10 };
  }

  scrollIntoView(): void {}
}

/** Stands in for `DataTransfer`: records the MIME entries the drop script sets. */
class FakeDataTransfer {
  readonly entries: [string, string][] = [];

  setData(mimeType: string, value: string): void {
    this.entries.push([mimeType, value]);
  }
}

class FakeDragEvent extends FakeEvent {
  readonly dataTransfer: FakeDataTransfer;

  constructor(type: string, init?: { readonly dataTransfer?: FakeDataTransfer }) {
    super(type);
    this.dataTransfer = init?.dataTransfer ?? new FakeDataTransfer();
  }
}

/** Stands in for a checkbox: `click()` toggles `checked`, as a real input does. */
class FakeCheckboxElement {
  checked = true;
  clicks = 0;

  click(): void {
    this.clicks += 1;
    this.checked = !this.checked;
  }
}

/** A fake `browser.scripting.executeScript` that actually evaluates the wrapped page code. */
const createExecutingScriptingSession = () => {
  const codes: string[] = [];
  const scriptingApi: BrowserScriptingApi = {
    executeScript: async details => {
      const code = details.args[0] ?? '';

      codes.push(code);

      const result = await executeWrappedPageCode(code);

      return [{ documentId: 'doc-1', result }];
    },
  };
  const tabsApi = createTabsApi();

  return {
    codes,
    session: createBrowserToolSession({
      scriptingApi,
      tabId: 7,
      tabsApi: tabsApi.api,
    }),
  };
};

const createFakePageGlobals = (): {
  globals: Record<string, unknown>;
  checkbox: FakeCheckboxElement;
  dataTransfers: FakeDataTransfer[];
  input: FakeInputElement;
} => {
  const input = new FakeInputElement();
  const checkbox = new FakeCheckboxElement();
  const dataTransfers: FakeDataTransfer[] = [];

  class RecordingDataTransfer extends FakeDataTransfer {
    constructor() {
      super();
      dataTransfers.push(this);
    }
  }

  return {
    checkbox,
    dataTransfers,
    globals: {
      DataTransfer: RecordingDataTransfer,
      DragEvent: FakeDragEvent,
      Event: FakeEvent,
      HTMLInputElement: FakeInputElement,
      // eslint-disable-next-line typescript-eslint/no-extraneous-class -- instanceof identity only: the page script checks `el instanceof HTMLSelectElement`
      HTMLSelectElement: class FakeSelectElement {},
      // eslint-disable-next-line typescript-eslint/no-extraneous-class -- instanceof identity only: the page script checks `el instanceof HTMLTextAreaElement`
      HTMLTextAreaElement: class FakeTextAreaElement {},
      KeyboardEvent: FakeKeyboardEvent,
      document: {
        querySelector: (selector: string): FakeCheckboxElement | FakeInputElement | null => {
          if (selector === '#name') {
            return input;
          }

          return selector === '#agree' ? checkbox : null;
        },
      },
    },
    input,
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

  it('records the frame id and scopes requests since load to the main-frame document', async () => {
    const { debuggerApi, session } = createSession();

    await session.attach();
    debuggerApi.emitEvent(7, 'Page.frameNavigated', {
      frame: { id: 'main', url: 'https://example.com/' },
    });
    debuggerApi.emitEvent(7, 'Network.requestWillBeSent', {
      frameId: 'main',
      request: { url: 'https://example.com/' },
      requestId: 'doc',
      type: 'Document',
    });
    debuggerApi.emitEvent(7, 'Network.requestWillBeSent', {
      frameId: 'main',
      request: { url: 'https://example.com/api' },
      requestId: 'api',
      type: 'XHR',
    });
    // A same-process iframe's document request must not move the boundary or hide the main document.
    debuggerApi.emitEvent(7, 'Network.requestWillBeSent', {
      frameId: 'frame-1',
      request: { url: 'https://example.com/embed' },
      requestId: 'frame-doc',
      type: 'Document',
    });

    expect(session.networkRequestsSinceLoad().map(request => request.requestId)).toStrictEqual([
      'doc',
      'api',
      'frame-doc',
    ]);
    expect(session.networkRequests().find(request => request.requestId === 'doc')?.frameId).toBe(
      'main'
    );
  });

  it('starts requests since load at the newest main-frame document', async () => {
    const { debuggerApi, session } = createSession();

    await session.attach();
    debuggerApi.emitEvent(7, 'Page.frameNavigated', { frame: { id: 'main' } });
    debuggerApi.emitEvent(7, 'Network.requestWillBeSent', {
      frameId: 'main',
      request: { url: 'https://example.com/first' },
      requestId: 'first-doc',
      type: 'Document',
    });
    debuggerApi.emitEvent(7, 'Network.requestWillBeSent', {
      frameId: 'main',
      request: { url: 'https://example.com/second' },
      requestId: 'second-doc',
      type: 'Document',
    });

    expect(session.networkRequestsSinceLoad().map(request => request.requestId)).toStrictEqual([
      'second-doc',
    ]);
  });

  it('keeps the whole buffer when no main-frame navigation was observed', async () => {
    const { debuggerApi, session } = createSession();

    await session.attach();
    debuggerApi.emitEvent(7, 'Network.requestWillBeSent', {
      frameId: 'frame-1',
      request: { url: 'https://example.com/embed' },
      requestId: 'frame-doc',
      type: 'Document',
    });

    expect(session.networkRequestsSinceLoad().map(request => request.requestId)).toStrictEqual([
      'frame-doc',
    ]);
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

  it('keeps the previous refs when a targeted snapshot registers with merge', async () => {
    const { session } = createSession();

    session.registerRefs([{ backendNodeId: 1, ref: 'e1' }]);
    session.registerRefs([{ ref: 'e2', selector: '.later' }], { merge: true });

    await expect(session.resolveTarget('e1')).resolves.toStrictEqual({
      backendNodeId: 1,
      kind: 'ref',
      ref: 'e1',
    });
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

const scriptingSnapshotPayload = {
  lines: ['- button "Go" e1'],
  nextRef: 1,
  refs: [{ ref: 'e1', selector: 'button.go' }],
};

// The snapshot builder and every other scripting action run through the same injection.
// The fake keys its payload off the aria builder in the code.
const scriptingResultForCode = (code: string): unknown =>
  code.includes('__buildAria') ? scriptingSnapshotPayload : 'ok';

describe('browser tool session scripting backend', () => {
  it('selects the scripting backend when chrome.debugger is unavailable', () => {
    const { session } = createScriptingSession();
    const { session: debuggerBackedSession } = createSession();

    expect(session.backend).toBe('scripting');
    expect(debuggerBackedSession.backend).toBe('debugger');
  });

  it('runs a supported tool through the scripting API and surfaces its value', async () => {
    const { scriptApi, session } = createScriptingSession({
      result: () => 'Clicked #submit with the left button.',
    });

    await expect(
      session.callTool('kilo_browser_click', { target: '#submit' })
    ).resolves.toStrictEqual({
      ok: true,
      value: 'Clicked #submit with the left button.',
    });
    expect(scriptApi.codes).toHaveLength(1);
    expect(scriptApi.codes[0]).toContain('#submit');
  });

  it('registers scripting snapshot refs so a later tool call can target them', async () => {
    const { scriptApi, session } = createScriptingSession({
      result: scriptingResultForCode,
    });

    await expect(session.callTool('kilo_browser_snapshot')).resolves.toStrictEqual({
      ok: true,
      value: '- button "Go" e1',
    });

    await session.callTool('kilo_browser_click', { target: 'e1' });

    expect(scriptApi.codes).toHaveLength(2);
    expect(scriptApi.codes[1]).toContain('button.go');
  });

  it('types into a fake input by executing the injected page code for real', async () => {
    const { session } = createExecutingScriptingSession();
    const { globals, input } = createFakePageGlobals();

    await withPageGlobals(globals, async () => {
      await expect(
        session.callTool('kilo_browser_type', { target: '#name', text: 'Ada' })
      ).resolves.toStrictEqual({ ok: true, value: 'Typed into #name.' });
    });

    expect(input.value).toBe('Ada');
    expect(input.events.map(event => event.type)).toStrictEqual(['input', 'change']);
  });

  it('types slowly character by character with key events through the injected code', async () => {
    const { session } = createExecutingScriptingSession();
    const { globals, input } = createFakePageGlobals();

    await withPageGlobals(globals, async () => {
      await expect(
        session.callTool('kilo_browser_type', { slowly: true, target: '#name', text: 'Go' })
      ).resolves.toStrictEqual({ ok: true, value: 'Typed into #name.' });
    });

    expect(input.value).toBe('Go');
    expect(
      input.events.filter(event => event.type === 'keydown').map(event => event.key)
    ).toStrictEqual(['G', 'o']);
    expect(input.events.filter(event => event.type === 'input')).toHaveLength(2);
  });

  it('fills a form field by executing the injected page code for real', async () => {
    const { session } = createExecutingScriptingSession();
    const { globals, input } = createFakePageGlobals();

    await withPageGlobals(globals, async () => {
      await expect(
        session.callTool('kilo_browser_fill_form', {
          fields: [{ name: 'email', target: '#name', type: 'text', value: 'ada@example.com' }],
        })
      ).resolves.toStrictEqual({
        ok: true,
        value: 'Filled 1 field(s).\nemail: filled',
      });
    });

    expect(input.value).toBe('ada@example.com');
  });

  it('unchecks a checkbox when the contract value is the string "false"', async () => {
    const { session } = createExecutingScriptingSession();
    const { checkbox, globals } = createFakePageGlobals();

    await withPageGlobals(globals, async () => {
      await expect(
        session.callTool('kilo_browser_fill_form', {
          fields: [{ name: 'Agree', target: '#agree', type: 'checkbox', value: 'false' }],
        })
      ).resolves.toStrictEqual({ ok: true, value: 'Filled 1 field(s).\nAgree: unchecked' });
    });

    expect(checkbox.clicks).toBe(1);
    expect(checkbox.checked).toBe(false);
  });

  it('sets the contract record shape for browser_drop data on the page DataTransfer', async () => {
    const { session } = createExecutingScriptingSession();
    const { dataTransfers, globals } = createFakePageGlobals();

    await withPageGlobals(globals, async () => {
      await expect(
        session.callTool('kilo_browser_drop', {
          data: { 'text/plain': 'hello' },
          target: '#name',
        })
      ).resolves.toStrictEqual({ ok: true, value: 'Dropped 1 data item(s) onto #name.' });
    });

    expect(dataTransfers[0]?.entries).toStrictEqual([['text/plain', 'hello']]);
  });

  it('accepts the webp screenshot type the contract advertises', async () => {
    const { session } = createScriptingSession();

    const result = await session.callTool('kilo_browser_take_screenshot', {
      scale: 'css',
      type: 'webp',
    });

    // The fake tabs API has no captureVisibleTab; reaching that error proves the arguments schema accepted webp.
    expect(result).toStrictEqual({ error: 'Viewport screenshot API is unavailable.', ok: false });
  });

  it('waits for a bounded time through the injected page code', async () => {
    const { session } = createExecutingScriptingSession();

    await expect(session.callTool('kilo_browser_wait_for', { time: 0.2 })).resolves.toStrictEqual({
      ok: true,
      value: 'Waited 0 second(s).',
    });
  });

  it.each(FIREFOX_UNSUPPORTED_BROWSER_TOOLS)(
    'returns a named Firefox error for %s instead of a silent no-op',
    async tool => {
      const { scriptApi, session } = createScriptingSession();

      await expect(session.callTool(tool)).resolves.toStrictEqual({
        error: `${tool} is not available in Firefox: ${FIREFOX_PLATFORM_LIMIT}.`,
        ok: false,
      });
      expect(scriptApi.codes).toStrictEqual([]);
      expect(session.getToolUnavailableError(tool)).toBe(
        `${tool} is not available in Firefox: ${FIREFOX_PLATFORM_LIMIT}.`
      );
    }
  );

  it('names the upstream tool in the Firefox error and keeps it off the debugger backend', () => {
    const { session } = createScriptingSession();

    expect(getFirefoxUnsupportedToolError('browser_console_messages')).toBe(
      `kilo_browser_console_messages is not available in Firefox: ${FIREFOX_PLATFORM_LIMIT}.`
    );
    expect(session.getToolUnavailableError('kilo_browser_console_messages')).toContain(
      FIREFOX_PLATFORM_LIMIT
    );

    const { session: debuggerBackedSession } = createSession();

    expect(
      debuggerBackedSession.getToolUnavailableError('kilo_browser_console_messages')
    ).toBeUndefined();
  });
});
