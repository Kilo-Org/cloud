/* eslint-disable max-lines, max-classes-per-file, vitest/max-expects -- the page-global fakes below need several instanceof-identity classes in this one test file, and one contract is several assertions */
import { describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line import/no-nodejs-modules -- the snapshot walker runs against a real DOM
import { JSDOM } from 'jsdom';
import {
  FIREFOX_PLATFORM_LIMIT,
  FIREFOX_UNSUPPORTED_BROWSER_TOOLS,
  MAX_BROWSER_TOOL_CONSOLE_MESSAGES,
  MAX_BROWSER_TOOL_NETWORK_REQUESTS,
  MAX_BROWSER_TOOL_REFS,
  createBrowserToolSession,
  getFirefoxUnsupportedToolError,
} from './browser-tool-session';
import { TAB_NOT_INSPECTABLE_ERROR } from './tab-debugger';
import { STALE_REF_ERROR } from './browser-agent-checks';
import { TAB_TAKEN_ERROR } from './browser-caller';
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

/**
 * A base64 png whose IHDR reports this size: the capture checks the frame's own
 * pixels against the layout viewport, so a test frame has to carry a real header.
 */
const pngOfSize = (width: number, height: number): string => {
  const header = new Uint8Array(24);

  // The PNG signature, then a 4-byte chunk length, the IHDR type, and the two 4-byte dimensions.
  header.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  new DataView(header.buffer).setUint32(16, width);
  new DataView(header.buffer).setUint32(20, height);

  return btoa(String.fromCodePoint(...header));
};

const createDebuggerApi = ({
  documentNodeId = 11,
  gate,
  layoutViewport,
  responseBodies,
  screencast,
  selectorMatches = [42],
  visibilityState = 'visible',
}: {
  documentNodeId?: number;
  /** When set, `sendCommand` waits on `gate.wait` before resolving the gated method. */
  gate?: { readonly command: string; readonly wait: Promise<void> };
  /** What `Page.getLayoutMetrics` reports, in device pixels. */
  layoutViewport?: { readonly clientHeight: number; readonly clientWidth: number };
  responseBodies?: Record<string, { base64Encoded?: boolean; body: string }>;
  /** The frame `Page.startScreencast` pushes back, on a macrotask like the real event. */
  screencast?: {
    readonly data: string;
    readonly deviceHeight: number;
    readonly deviceWidth: number;
  };
  selectorMatches?: readonly number[];
  visibilityState?: string;
} = {}): {
  api: ChromeDebuggerApi;
  attachCalls: number[];
  commands: { method: string; params: Record<string, unknown> | undefined }[];
  detachCalls: number[];
  emitDetach: (tabId: number, reason?: string) => void;
  emitEvent: (tabId: number, method: string, params?: Record<string, unknown>) => void;
  setDocumentNodeId: (nextDocumentNodeId: number) => void;
  setVisibilityState: (nextVisibilityState: string) => void;
} => {
  const attachCalls: number[] = [];
  const detachCalls: number[] = [];
  const commands: { method: string; params: Record<string, unknown> | undefined }[] = [];
  const detachListeners: ChromeDebuggerDetachListener[] = [];
  const eventListeners: ChromeDebuggerEventListener[] = [];
  let currentDocumentNodeId = documentNodeId;
  let currentVisibilityState = visibilityState;

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

      if (method === 'DOM.querySelectorAll') {
        return { nodeIds: selectorMatches };
      }

      if (method === 'Page.getLayoutMetrics') {
        return layoutViewport === undefined ? {} : { layoutViewport };
      }

      if (method === 'Page.startScreencast' && screencast !== undefined) {
        const frame = screencast;

        setTimeout(() => {
          for (const listener of eventListeners) {
            listener({}, 'Page.screencastFrame', {
              data: frame.data,
              metadata: { deviceHeight: frame.deviceHeight, deviceWidth: frame.deviceWidth },
              sessionId: 3,
            });
          }
        }, 0);
      }

      if (method === 'Network.getResponseBody') {
        const requestId = params?.['requestId'];

        return (typeof requestId === 'string' ? responseBodies?.[requestId] : undefined) ?? {};
      }

      if (method === 'Runtime.evaluate' && params?.['expression'] === 'document.visibilityState') {
        return { result: { value: currentVisibilityState } };
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
    setVisibilityState: nextVisibilityState => {
      currentVisibilityState = nextVisibilityState;
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
  layoutViewport,
  responseBodies,
  screencast,
  selectorMatches,
}: {
  tabId?: number;
  url?: string;
  gate?: { readonly command: string; readonly wait: Promise<void> };
  layoutViewport?: { readonly clientHeight: number; readonly clientWidth: number };
  responseBodies?: Record<string, { base64Encoded?: boolean; body: string }>;
  screencast?: {
    readonly data: string;
    readonly deviceHeight: number;
    readonly deviceWidth: number;
  };
  selectorMatches?: readonly number[];
} = {}) => {
  const debuggerApi = createDebuggerApi({
    ...(gate === undefined ? {} : { gate }),
    ...(layoutViewport === undefined ? {} : { layoutViewport }),
    ...(responseBodies === undefined ? {} : { responseBodies }),
    ...(screencast === undefined ? {} : { screencast }),
    ...(selectorMatches === undefined ? {} : { selectorMatches }),
  });
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
      readonly world: 'ISOLATED' | 'MAIN';
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

/** An injection the browser never answers, for the timeout path. */
const neverResolves = (): Promise<never[]> =>
  // eslint-disable-next-line promise/avoid-new -- the fixture is a promise that never settles
  new Promise<never[]>(() => {});

/** A scripting fake that answers a selector with its match count. */
const selectorCountScript =
  (counts: Record<string, number>) =>
  (details: { readonly args: string[] }): Promise<{ readonly result?: unknown }[]> => {
    const code = details.args[0] ?? '';
    const selector = Object.keys(counts).find(key => code.includes(JSON.stringify(key)));

    return Promise.resolve([{ result: selector === undefined ? 0 : counts[selector] }]);
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

type TabUpdatedListener = (
  tabId: number,
  changeInfo: { readonly status?: string; readonly url?: string }
) => void;

const SHOP_ORIGIN = 'https://shop.example.com';
const PAY_ORIGIN = 'https://pay.example.com';

/**
 * One tab behind two real documents: the shop page (frame 0) and the pay
 * frame it embeds (frame 4). MAIN-world code runs in the document its target
 * frame names; the ISOLATED probe answers the frame tree.
 */
const createFramedScriptingSession = () => {
  const shop = new JSDOM('<body><button>Top</button><iframe></iframe></body>', {
    url: `${SHOP_ORIGIN}/`,
  });
  const pay = new JSDOM('<body><button>Buy</button><input></body>', { url: `${PAY_ORIGIN}/` });
  const documents = new Map([
    [0, shop],
    [4, pay],
  ]);
  const frameAnswers = [
    { frameId: 0, origin: SHOP_ORIGIN, owners: [4], parentFrameId: null },
    { frameId: 4, origin: PAY_ORIGIN, owners: [], parentFrameId: 0 },
  ];
  const isolatedKinds: string[] = [];
  const mainWorldFrames: (number | undefined)[] = [];
  const updatedListeners: TabUpdatedListener[] = [];
  const scriptingApi: BrowserScriptingApi = {
    executeScript: async details => {
      if (details.world === 'ISOLATED') {
        isolatedKinds.push(details.args[0] ?? '');

        return details.args[0] === 'frame'
          ? frameAnswers.map(({ frameId, ...answer }) => ({
              frameId,
              result: JSON.stringify({ ...answer, url: `${answer.origin}/` }),
            }))
          : [];
      }

      const frameId = details.target.frameIds?.[0];
      const dom = documents.get(frameId ?? 0);
      const results: unknown[] = [];

      mainWorldFrames.push(frameId);

      if (dom !== undefined) {
        Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', {
          configurable: true,
          value: vi.fn(),
        });
        await withPageGlobals(
          {
            MouseEvent: dom.window.MouseEvent,
            document: dom.window.document,
            location: dom.window.location,
            window: dom.window,
          },
          async () => {
            results.push(await executeWrappedPageCode(details.args[0] ?? ''));
          }
        );
      }

      return [{ documentId: `doc-${String(frameId ?? 0)}`, result: results[0] }];
    },
  };
  const tabsApi: BrowserTabsApi = {
    ...createTabsApi().api,
    onUpdated: {
      addListener: listener => {
        updatedListeners.push(listener);
      },
      removeListener: () => {},
    },
  };

  return {
    emitUpdated: (
      tabId: number,
      changeInfo: { readonly status?: string; readonly url?: string }
    ) => {
      for (const listener of updatedListeners) {
        listener(tabId, changeInfo);
      }
    },
    isolatedKinds,
    mainWorldFrames,
    pay,
    session: createBrowserToolSession({ scriptingApi, tabId: 7, tabsApi }),
    shop,
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
  it('attaches once, lazily, and enables every CDP domain plus focus emulation before the first send', async () => {
    const { debuggerApi, session } = createSession();

    expect(session.isAttached()).toBe(false);
    expect(debuggerApi.attachCalls).toStrictEqual([]);

    await session.send('Runtime.evaluate', { expression: '1 + 1' });
    await session.send('Runtime.evaluate', { expression: '2 + 2' });

    expect(session.isAttached()).toBe(true);
    expect(debuggerApi.attachCalls).toStrictEqual([7]);
    expect(debuggerApi.commands).toStrictEqual([
      ...ENABLED_DOMAINS.map(method => ({ method, params: undefined })),
      { method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } },
      { method: 'Runtime.evaluate', params: { expression: '1 + 1' } },
      { method: 'Runtime.evaluate', params: { expression: '2 + 2' } },
    ]);
  });

  it('takes back the debugger attachment a stopped service worker left on the tab', async () => {
    const { debuggerApi, session } = createSession();
    // Chrome keeps the extension's debugger on the tab when it stops the worker, and refuses the new worker's attach.
    const refused = new Error('Another debugger is already attached to the tab with id: 7.');
    const attach = vi.fn(debuggerApi.api.attach).mockRejectedValueOnce(refused);

    Object.assign(debuggerApi.api, { attach });

    await session.send('Runtime.evaluate', { expression: '1 + 1' });

    expect(session.isAttached()).toBe(true);
    expect(debuggerApi.detachCalls).toStrictEqual([7]);
    expect(debuggerApi.attachCalls).toStrictEqual([7]);
  });

  it('keeps one ref registry per caller so snapshots do not invalidate each other', async () => {
    const { session } = createSession();
    const first = session.bindCaller('panel:panel-1:conversation-1');
    const second = session.bindCaller('panel:panel-1:conversation-2');

    first.registerRefs([{ backendNodeId: 11, ref: 'e11' }]);
    second.registerRefs([{ backendNodeId: 99, ref: 'e99' }]);

    await expect(first.resolveTarget('e11')).resolves.toStrictEqual({
      backendNodeId: 11,
      kind: 'ref',
      ref: 'e11',
    });
    await expect(second.resolveTarget('e99')).resolves.toStrictEqual({
      backendNodeId: 99,
      kind: 'ref',
      ref: 'e99',
    });
    await expect(first.resolveTarget('e99')).resolves.toBeUndefined();

    // A full snapshot from the second caller replaces only its own registry.
    second.registerRefs([{ backendNodeId: 77, ref: 'e77' }]);

    await expect(first.resolveTarget('e11')).resolves.toStrictEqual({
      backendNodeId: 11,
      kind: 'ref',
      ref: 'e11',
    });
    await expect(second.resolveTarget('e99')).resolves.toBeUndefined();
  });

  it("drops a disposed caller's registry and keeps the other caller's refs", async () => {
    const { session } = createSession();
    const first = session.bindCaller('panel:panel-1:conversation-1');
    const second = session.bindCaller('panel:panel-1:conversation-2');

    first.registerRefs([{ backendNodeId: 11, ref: 'e11' }]);
    second.registerRefs([{ backendNodeId: 77, ref: 'e77' }]);

    session.disposeCaller('panel:panel-1:conversation-1');

    await expect(first.resolveTarget('e11')).resolves.toBeUndefined();
    await expect(second.resolveTarget('e77')).resolves.toStrictEqual({
      backendNodeId: 77,
      kind: 'ref',
      ref: 'e77',
    });
  });

  it('stops a cancelled caller view from sending its remaining commands', async () => {
    const { debuggerApi, session } = createSession();
    let cancelled = false;
    const view = session.bindCaller('panel:panel-1:conversation-1', {
      cancelled: () => cancelled,
    });

    await view.send('Runtime.evaluate', { expression: '1' });
    const sentBeforeTakeOver = debuggerApi.commands.length;

    cancelled = true;

    // The guard ends the call at its next command, so nothing reaches the page.
    expect(() => view.send('Runtime.evaluate', { expression: '2' })).toThrow(TAB_TAKEN_ERROR);
    expect(() => view.callTool('browser_evaluate', { function: '() => 1' })).toThrow(
      TAB_TAKEN_ERROR
    );
    expect(debuggerApi.commands).toHaveLength(sentBeforeTakeOver);
  });

  it('keeps refs across turns and drops every registry on navigation', async () => {
    const { debuggerApi, session } = createSession();
    const first = session.bindCaller('panel:panel-1:conversation-1');
    const second = session.bindCaller('panel:panel-1:conversation-2');

    first.registerRefs([{ backendNodeId: 11, ref: 'e11' }]);
    second.registerRefs([{ backendNodeId: 77, ref: 'e77' }]);

    // Nothing a turn does clears a registry: only navigation or disposal does.
    await expect(first.resolveTarget('e11')).resolves.toStrictEqual({
      backendNodeId: 11,
      kind: 'ref',
      ref: 'e11',
    });

    debuggerApi.emitEvent(7, 'Page.frameNavigated', {
      frame: { id: 'main', url: 'https://example.com/next' },
    });

    await expect(first.resolveTarget('e11')).resolves.toBeUndefined();
    await expect(second.resolveTarget('e77')).resolves.toBeUndefined();
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

  it('renders the body part with the shared field rules', async () => {
    const { debuggerApi, session } = createSession({
      responseBodies: { r1: { body: '{"ok":true,"refreshToken":"rt-fixture-1"}' } },
    });

    await session.attach();
    debuggerApi.emitEvent(7, 'Network.requestWillBeSent', {
      request: { url: 'https://example.com/api' },
      requestId: 'r1',
    });
    debuggerApi.emitEvent(7, 'Network.responseReceived', {
      requestId: 'r1',
      response: { status: 200 },
    });

    const result = await session.callTool('kilo_browser_network_request', {
      number: 1,
      part: 'body',
    });

    const text = JSON.stringify(result);

    expect(text).toContain(String.raw`\"refreshToken\": \"[REDACTED]\"`);
    expect(text).not.toContain('rt-fixture-1');
  });

  it('replaces fields inside a base64 response body', async () => {
    const { debuggerApi, session } = createSession({
      responseBodies: {
        r1: { base64Encoded: true, body: btoa('{"ok":true,"sessionId":"s-fixture-1"}') },
      },
    });

    await session.attach();
    debuggerApi.emitEvent(7, 'Network.requestWillBeSent', {
      request: { url: 'https://example.com/api' },
      requestId: 'r1',
    });
    debuggerApi.emitEvent(7, 'Network.responseReceived', {
      requestId: 'r1',
      response: { status: 200 },
    });

    const result = await session.callTool('kilo_browser_network_request', {
      number: 1,
      part: 'body',
    });

    const text = JSON.stringify(result);

    expect(text).toContain('(base64, decoded)');
    expect(text).toContain(String.raw`\"sessionId\": \"[REDACTED]\"`);
    expect(text).not.toContain('s-fixture-1');
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
      debuggerApi.commands.filter(command => command.method === 'DOM.querySelectorAll')
    ).toStrictEqual([
      { method: 'DOM.querySelectorAll', params: { nodeId: 11, selector: '#submit' } },
    ]);
  });

  it('refuses a selector that matches zero or several elements', async () => {
    const none = createSession({ selectorMatches: [] });
    const many = createSession({ selectorMatches: [42, 43] });
    const one = createSession({ selectorMatches: [42] });

    await expect(none.session.resolveTarget('#ambiguous')).resolves.toBeUndefined();
    await expect(many.session.resolveTarget('#ambiguous')).resolves.toStrictEqual({
      kind: 'ambiguous',
      matches: 2,
      selector: '#ambiguous',
    });
    await expect(one.session.resolveTarget('#unique')).resolves.toStrictEqual({
      kind: 'selector',
      nodeId: 42,
      selector: '#unique',
    });
  });

  it('applies the unique-match rule on the scripting backend too', async () => {
    const scriptingApi: BrowserScriptingApi = {
      executeScript: selectorCountScript({ '#many': 3, '#none': 0, '#one': 1 }),
    };
    const tabsApi = createTabsApi();
    const session = createBrowserToolSession({
      scriptingApi,
      tabId: 7,
      tabsApi: tabsApi.api,
    });

    await expect(session.resolveTarget('#many')).resolves.toStrictEqual({
      kind: 'ambiguous',
      matches: 3,
      selector: '#many',
    });
    await expect(session.resolveTarget('#none')).resolves.toBeUndefined();
    await expect(session.resolveTarget('#one')).resolves.toStrictEqual({
      kind: 'selector',
      nodeId: 0,
      selector: '#one',
    });
  });

  it('surfaces a scripting injection error instead of reporting no match', async () => {
    const scriptingApi: BrowserScriptingApi = {
      executeScript: () => Promise.resolve([{ error: 'permission denied' }]),
    };
    const tabsApi = createTabsApi();
    const session = createBrowserToolSession({ scriptingApi, tabId: 7, tabsApi: tabsApi.api });

    await expect(session.resolveTarget('#broken')).rejects.toThrow(/permission denied/);
  });

  it('times out a scripting selector count instead of reporting no match', async () => {
    vi.useFakeTimers();

    try {
      const scriptingApi: BrowserScriptingApi = { executeScript: neverResolves };
      const tabsApi = createTabsApi();
      const session = createBrowserToolSession({ scriptingApi, tabId: 7, tabsApi: tabsApi.api });
      // Observe the rejection before the timer fires, so it is never unhandled.
      const failures: unknown[] = [];
      const pending = session.resolveTarget('#slow');
      const settled = (async (): Promise<void> => {
        try {
          await pending;
        } catch (error) {
          failures.push(error);
        }
      })();

      await vi.advanceTimersByTimeAsync(20_000);
      await settled;

      expect(failures[0]).toBeInstanceOf(Error);
      expect(String(failures[0])).toContain('timed out');
    } finally {
      vi.useRealTimers();
    }
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
        .filter(command => command.method === 'DOM.querySelectorAll')
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
        .filter(command => command.method === 'DOM.querySelectorAll')
        .map(command => command.params)
    ).toStrictEqual([
      { nodeId: 11, selector: '#frame' },
      { nodeId: 11, selector: '#still' },
      { nodeId: 33, selector: '#fresh' },
    ]);
  });
});

const scriptingSnapshotPayload = {
  lines: ['- button "Go" [ref=e1]'],
  nextRef: 1,
  refs: [{ ref: 'e1', selector: 'button.go' }],
};

// The snapshot builder and every other scripting action run through the same injection.
// The fake keys its payload off the aria builder in the code.
const scriptingResultForCode = (code: string): unknown =>
  code.includes('__buildAria') ? scriptingSnapshotPayload : 'ok';

/** A snapshot whose page registered more refs than the cap while its returned text names only e1 and e2. */
const oversizedSnapshotPayload = {
  lines: ['- button "One" [ref=e1]', '- button "Two" [ref=e2]'],
  nextRef: MAX_BROWSER_TOOL_REFS + 1,
  refs: Array.from({ length: MAX_BROWSER_TOOL_REFS + 1 }, (_slot, index) => ({
    ref: `e${String(index + 1)}`,
    selector: `#node-${String(index + 1)}`,
  })),
};

const oversizedSnapshotResultForCode = (code: string): unknown =>
  code.includes('__buildAria') ? oversizedSnapshotPayload : 'ok';

describe('browser tool session scripting backend', () => {
  it('selects the scripting backend when chrome.debugger is unavailable', () => {
    const { session } = createScriptingSession();
    const { session: debuggerBackedSession } = createSession();

    expect(session.backend).toBe('scripting');
    expect(debuggerBackedSession.backend).toBe('debugger');
  });

  it('navigates through the tabs API and answers only once the page has loaded', async () => {
    type Updated = (tabId: number, changeInfo: { readonly status?: string }) => void;
    const listeners: Updated[] = [];
    const updates: unknown[] = [];
    let shown = { title: 'Tab', url: 'https://example.com/' };
    const tabsApi: BrowserTabsApi = {
      get: tabId => ({ id: tabId, ...shown }),
      onUpdated: {
        addListener: listener => {
          listeners.push(listener);
        },
        removeListener: () => {
          listeners.length = 0;
        },
      },
      query: () => [],
      update: (tabId, properties) => {
        updates.push(properties);
        shown = { title: 'Next', url: 'https://example.com/next' };

        return { id: tabId };
      },
    };
    const emit = (status: string) => {
      for (const listener of listeners) {
        listener(7, { status });
      }
    };
    const session = createBrowserToolSession({
      scriptingApi: createScriptingApi().api,
      tabId: 7,
      tabsApi,
    });
    let settled = false;
    const navigated = (async () => {
      const result = await session.callTool('browser_navigate', { url: '/next' });

      settled = true;

      return result;
    })();

    await vi.waitFor(() => {
      expect(updates).toStrictEqual([{ url: 'https://example.com/next' }]);
    });
    emit('loading');
    await flushPendingWork();
    expect(settled).toBe(false);

    emit('complete');

    await expect(navigated).resolves.toStrictEqual({
      ok: true,
      value: { title: 'Next', url: 'https://example.com/next' },
    });
    expect(listeners).toHaveLength(0);
  });

  it('answers a same-document navigation once its url changes, without a load', async () => {
    type Updated = (
      tabId: number,
      changeInfo: { readonly status?: string; readonly url?: string }
    ) => void;
    const listeners: Updated[] = [];
    let shown = { status: 'complete', title: 'Tab', url: 'https://example.com/page' };
    const emitUrl = (status: string, url: string) => {
      shown = { status, title: 'Tab', url };
      for (const listener of listeners) {
        listener(7, { url });
      }
    };
    const tabsApi: BrowserTabsApi = {
      get: tabId => ({ id: tabId, ...shown }),
      onUpdated: {
        addListener: listener => {
          listeners.push(listener);
        },
        removeListener: () => {
          listeners.length = 0;
        },
      },
      query: () => [],
      update: tabId => ({ id: tabId }),
    };
    const session = createBrowserToolSession({
      scriptingApi: createScriptingApi().api,
      tabId: 7,
      tabsApi,
    });
    let settled = false;
    const navigated = (async () => {
      const result = await session.callTool('browser_navigate', { url: '#next' });

      settled = true;

      return result;
    })();

    await vi.waitFor(() => {
      expect(listeners).toHaveLength(1);
    });
    // A cross-document navigation can report its url while the tab is still loading: that is not the end.
    emitUrl('loading', 'https://example.com/other');
    await flushPendingWork();
    expect(settled).toBe(false);

    emitUrl('complete', 'https://example.com/page#next');

    await expect(navigated).resolves.toStrictEqual({
      ok: true,
      value: { title: 'Tab', url: 'https://example.com/page#next' },
    });
  });

  it('ends a back navigation that went nowhere instead of waiting for a load', async () => {
    vi.useFakeTimers();

    try {
      type Updated = (tabId: number, changeInfo: { readonly status?: string }) => void;
      const listeners: Updated[] = [];
      const shown = { status: 'complete', title: 'Tab', url: 'https://example.com/page' };
      const tabsApi: BrowserTabsApi = {
        get: tabId => ({ id: tabId, ...shown }),
        onUpdated: {
          addListener: listener => {
            listeners.push(listener);
          },
          removeListener: () => {
            listeners.length = 0;
          },
        },
        query: () => [],
        update: tabId => ({ id: tabId }),
      };
      const session = createBrowserToolSession({
        scriptingApi: createScriptingApi().api,
        tabId: 7,
        tabsApi,
      });
      let settled = false;
      const navigated = (async () => {
        const result = await session.callTool('browser_navigate_back', {});

        settled = true;

        return result;
      })();

      // A no-op: history.back() with no entry reports nothing at all.
      await vi.advanceTimersByTimeAsync(1000);
      expect(settled).toBe(true);

      // Let the full timeout fire too, so a slow answer cannot outlive the test.
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(navigated).resolves.toStrictEqual({
        error: 'The page has no history entry to go back to.',
        ok: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for the load of a navigation the browser already reported', async () => {
    vi.useFakeTimers();

    try {
      type Updated = (tabId: number, changeInfo: { readonly status?: string }) => void;
      const listeners: Updated[] = [];
      let shown = { status: 'complete', title: 'Tab', url: 'https://example.com/page' };
      const tabsApi: BrowserTabsApi = {
        get: tabId => ({ id: tabId, ...shown }),
        onUpdated: {
          addListener: listener => {
            listeners.push(listener);
          },
          removeListener: () => {
            listeners.length = 0;
          },
        },
        query: () => [],
        update: tabId => ({ id: tabId }),
      };
      const session = createBrowserToolSession({
        scriptingApi: createScriptingApi().api,
        tabId: 7,
        tabsApi,
      });
      let settled = false;
      const navigated = (async () => {
        const result = await session.callTool('browser_navigate_back', {});

        settled = true;

        return result;
      })();
      await vi.advanceTimersByTimeAsync(0);
      expect(listeners.length).toBeGreaterThan(0);

      const emit = (status: string) => {
        for (const listener of listeners) {
          listener(7, { status });
        }
      };

      // The browser reported a load: a slow commit must not be read as nothing happening.
      emit('loading');
      await vi.advanceTimersByTimeAsync(1000);
      expect(settled).toBe(false);

      shown = { status: 'complete', title: 'Back', url: 'https://example.com/previous' };
      emit('complete');

      await expect(navigated).resolves.toStrictEqual({
        ok: true,
        value: { title: 'Back', url: 'https://example.com/previous' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not end a cross-document navigation on its first url-only update', async () => {
    type Updated = (
      tabId: number,
      changeInfo: { readonly status?: string; readonly url?: string }
    ) => void;
    const listeners: Updated[] = [];
    let shown = { status: 'complete', title: 'Tab', url: 'https://example.com/page' };
    const emit = (changeInfo: { readonly status?: string; readonly url?: string }) => {
      for (const listener of listeners) {
        listener(7, changeInfo);
      }
    };
    const tabsApi: BrowserTabsApi = {
      get: tabId => ({ id: tabId, ...shown }),
      onUpdated: {
        addListener: listener => {
          listeners.push(listener);
        },
        removeListener: () => {
          listeners.length = 0;
        },
      },
      query: () => [],
      update: tabId => ({ id: tabId }),
    };
    const session = createBrowserToolSession({
      scriptingApi: createScriptingApi().api,
      tabId: 7,
      tabsApi,
    });
    let settled = false;
    const navigated = (async () => {
      const result = await session.callTool('browser_navigate_back', {});

      settled = true;

      return result;
    })();

    await vi.waitFor(() => {
      expect(listeners).toHaveLength(1);
    });
    // The new document's url arrives before any loading status: the tab still reports the old document as complete.
    shown = { status: 'complete', title: 'Tab', url: 'https://example.com/previous' };
    emit({ url: 'https://example.com/previous' });
    await flushPendingWork();
    expect(settled).toBe(false);

    emit({ status: 'loading' });
    emit({ status: 'complete' });

    await expect(navigated).resolves.toStrictEqual({
      ok: true,
      value: { title: 'Tab', url: 'https://example.com/previous' },
    });
  });

  it('refuses a data: navigation without touching the tab', async () => {
    const updates: unknown[] = [];
    const tabsApi: BrowserTabsApi = {
      ...createTabsApi().api,
      onUpdated: { addListener: () => {}, removeListener: () => {} },
      update: (tabId, properties) => {
        updates.push(properties);

        return { id: tabId };
      },
    };
    const session = createBrowserToolSession({
      scriptingApi: createScriptingApi().api,
      tabId: 7,
      tabsApi,
    });

    await expect(
      session.callTool('browser_navigate', { url: 'data:text/html,<p>hi</p>' })
    ).resolves.toStrictEqual({
      error: 'Refusing to navigate to a data: URL.',
      ok: false,
    });
    expect(updates).toStrictEqual([]);
  });

  it('sends the page the canonical WebMCP signature it rebuilds', async () => {
    const executeScript = vi
      .fn<BrowserScriptingApi['executeScript']>()
      .mockResolvedValueOnce([
        {
          documentId: 'doc-1',
          result: [
            {
              description: 'Do it',
              // eslint-disable-next-line sort-keys -- the page declares this order; the signature must not depend on it.
              inputSchema: { type: 'object', properties: { amount: { type: 'number' } } },
              name: 'do_thing',
              origin: 'https://example.com',
              title: 'Do',
            },
          ],
        },
      ])
      .mockResolvedValueOnce([{ documentId: 'doc-1', result: { ok: true, value: 'ran' } }]);
    const tabsApi = createTabsApi();
    const session = createBrowserToolSession({
      scriptingApi: { executeScript },
      tabId: 7,
      tabsApi: tabsApi.api,
    });

    await expect(
      session.callTool('kilo_browser_webmcp_call', { name: 'do_thing' })
    ).resolves.toStrictEqual({ ok: true, value: 'ran' });
    expect(executeScript.mock.calls[1]?.[0].args[2]).toBe(
      '["do_thing","Do","Do it","https://example.com",{"properties":{"amount":{"type":"number"}},"type":"object"}]'
    );
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
      value: '- button "Go" [ref=e1]',
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

  it('renders the snapshot contract format: refs, label names and printed-ancestor depth', async () => {
    const dom = new JSDOM(
      '<body><h1>Parity</h1><p>idle</p>' +
        '<label>Name <input id="name"></label>' +
        '<label><input type="checkbox" checked> Agree</label>' +
        '<label>Color <select><option>Red</option><option>Blue</option></select></label>' +
        '<div><span id="caption">Send it</span><button aria-labelledby="caption">x</button></div>' +
        '<section><iframe title="Pay"></iframe></section>' +
        '</body>'
    );
    const { session } = createExecutingScriptingSession();

    await withPageGlobals(
      { document: dom.window.document, location: dom.window.location, window: dom.window },
      async () => {
        await expect(session.callTool('browser_snapshot', {})).resolves.toStrictEqual({
          ok: true,
          value: [
            '- heading "Parity"[level=1]',
            '- paragraph "idle"',
            '- textbox "Name" [ref=e1]',
            '- checkbox "Agree" [ref=e2][checked]',
            '- combobox "Color" [ref=e3]',
            '  - option "Red" [ref=e4]',
            '  - option "Blue" [ref=e5]',
            '- text: Send it',
            '- button "Send it" [ref=e6]',
            '- iframe [ref=e7]',
          ].join('\n'),
        });
      }
    );
  });

  it('keeps the snapshot refs after a find, which only adds its own', async () => {
    const dom = new JSDOM('<body><button id="go">Go</button><p>idle</p></body>');
    const { session } = createExecutingScriptingSession();

    await withPageGlobals(
      { document: dom.window.document, location: dom.window.location, window: dom.window },
      async () => {
        await expect(session.callTool('browser_snapshot', {})).resolves.toStrictEqual({
          ok: true,
          value: '- button "Go" [ref=e1]\n- paragraph "idle"',
        });
        await expect(session.callTool('browser_find', { text: 'go' })).resolves.toStrictEqual({
          ok: true,
          value: 'Found 1 matching line(s):\n\n- button "Go" [ref=e2]\n- paragraph "idle"',
        });
        await expect(session.resolveTarget('e1')).resolves.toMatchObject({ kind: 'selector' });
        await expect(session.resolveTarget('e2')).resolves.toMatchObject({ kind: 'selector' });
      }
    );
  });

  it('splices a granted frame without a ref on its line, which would only reach the owner element', async () => {
    const { isolatedKinds, session } = createFramedScriptingSession();

    await expect(
      session.callTool('browser_snapshot', {}, { readableOrigins: [SHOP_ORIGIN, PAY_ORIGIN] })
    ).resolves.toStrictEqual({
      ok: true,
      value: [
        '- button "Top" [ref=e1]',
        '- iframe',
        '  - button "Buy" [ref=e3]',
        '  - textbox [ref=e4]',
      ].join('\n'),
    });
    await expect(session.resolveTarget('e2')).resolves.toBeUndefined();
    expect(isolatedKinds).toStrictEqual(['frame']);
  });

  it('splices from the call’s frame inventory instead of probing the frames again', async () => {
    const { isolatedKinds, session } = createFramedScriptingSession();
    const readFrames = vi.fn(() =>
      Promise.resolve({
        childSessions: new Map<string, string>(),
        complete: true,
        frames: [
          { id: '0', origin: SHOP_ORIGIN, url: `${SHOP_ORIGIN}/` },
          { id: '4', origin: PAY_ORIGIN, parentId: '0', url: `${PAY_ORIGIN}/` },
        ],
        owners: new Map<string, readonly (string | undefined)[]>([
          ['0', ['4']],
          ['4', []],
        ]),
      })
    );

    await expect(
      session.callTool(
        'browser_snapshot',
        {},
        { readFrames, readableOrigins: [SHOP_ORIGIN, PAY_ORIGIN] }
      )
    ).resolves.toStrictEqual({
      ok: true,
      value: [
        '- button "Top" [ref=e1]',
        '- iframe',
        '  - button "Buy" [ref=e3]',
        '  - textbox [ref=e4]',
      ].join('\n'),
    });
    expect(readFrames.mock.calls).toStrictEqual([[]]);
    expect(isolatedKinds).toStrictEqual([]);
  });

  it('makes every scripting ref stale once the tab starts loading another document', async () => {
    const { emitUpdated, session } = createFramedScriptingSession();

    await session.callTool('browser_snapshot', {});
    emitUpdated(7, { url: `${SHOP_ORIGIN}/#section` });
    emitUpdated(8, { status: 'loading' });
    await expect(session.resolveTarget('e1')).resolves.toMatchObject({ kind: 'selector' });

    emitUpdated(7, { status: 'loading' });

    await expect(session.resolveTarget('e1')).resolves.toBeUndefined();
    await expect(session.callTool('browser_click', { target: 'e1' })).resolves.toStrictEqual({
      error: STALE_REF_ERROR,
      ok: false,
    });
  });

  it('runs a ref from a granted frame in that frame, never in the top document', async () => {
    const { mainWorldFrames, pay, session, shop } = createFramedScriptingSession();
    const clicked: string[] = [];

    shop.window.document.querySelector('button')?.addEventListener('click', () => {
      clicked.push('shop');
    });
    pay.window.document.querySelector('button')?.addEventListener('click', () => {
      clicked.push('pay');
    });

    await session.callTool('browser_snapshot', {}, { readableOrigins: [SHOP_ORIGIN, PAY_ORIGIN] });
    // Both documents name their button `body > button`; only the frame id tells them apart.
    await expect(session.resolveTarget('e3')).resolves.toStrictEqual({
      frameId: 4,
      kind: 'selector',
      nodeId: 0,
      selector: 'body > button',
    });
    await expect(session.resolveTarget('e1')).resolves.toStrictEqual({
      kind: 'selector',
      nodeId: 0,
      selector: 'body > button',
    });
    // The input exists only in the frame, so its match is counted in the frame's document.
    await expect(session.resolveTarget('e4')).resolves.toStrictEqual({
      frameId: 4,
      kind: 'selector',
      nodeId: 0,
      selector: 'body > input',
    });

    mainWorldFrames.length = 0;

    await expect(session.callTool('browser_click', { target: 'e3' })).resolves.toStrictEqual({
      ok: true,
      value: 'Clicked ref=e3 with the left button.',
    });
    expect(clicked).toStrictEqual(['pay']);
    expect(mainWorldFrames).toStrictEqual([4]);

    await expect(
      session.callTool('browser_fill_form', {
        fields: [
          { name: 'Top', target: 'e1', type: 'textbox', value: 'a' },
          { name: 'Card', target: 'e4', type: 'textbox', value: 'b' },
        ],
      })
    ).resolves.toStrictEqual({
      error:
        'browser_fill_form fields live in different frames: fill each frame with its own call.',
      ok: false,
    });

    await expect(session.callTool('browser_snapshot', { target: 'e3' })).resolves.toStrictEqual({
      ok: true,
      value: '- button "Buy" [ref=e5]',
    });
    await expect(session.resolveTarget('e5')).resolves.toStrictEqual({
      frameId: 4,
      kind: 'selector',
      nodeId: 0,
      selector: 'body > button',
    });
  });

  it('caps a caller’s merged refs, dropping the oldest earlier refs first', async () => {
    const { session } = createScriptingSession();

    session.registerRefs(
      Array.from({ length: MAX_BROWSER_TOOL_REFS }, (_slot, index) => ({
        ref: `e${String(index + 1)}`,
        selector: `#node-${String(index + 1)}`,
      })),
      { merge: true }
    );
    session.registerRefs([{ ref: 'e9999', selector: '#late' }], { merge: true });

    await expect(session.callTool('browser_click', { target: 'e1' })).resolves.toStrictEqual({
      error: STALE_REF_ERROR,
      ok: false,
    });
    await expect(session.callTool('browser_click', { target: 'e2' })).resolves.toMatchObject({
      ok: true,
    });
  });

  it('never evicts the refs of the registration it is making', async () => {
    const { session } = createScriptingSession();

    session.registerRefs(
      Array.from({ length: MAX_BROWSER_TOOL_REFS + 1 }, (_slot, index) => ({
        ref: `e${String(index + 1)}`,
        selector: `#node-${String(index + 1)}`,
      })),
      { merge: true }
    );

    await expect(session.callTool('browser_click', { target: 'e1' })).resolves.toMatchObject({
      ok: true,
    });
  });

  it('registers only the refs a snapshot’s returned text names', async () => {
    const { session } = createScriptingSession({ result: oversizedSnapshotResultForCode });

    await expect(session.callTool('browser_snapshot', {})).resolves.toMatchObject({ ok: true });
    await expect(session.callTool('browser_click', { target: 'e1' })).resolves.toMatchObject({
      ok: true,
    });
    await expect(session.resolveTarget('e3')).resolves.toBeUndefined();
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

  it('names the tool the way the caller called it and keeps it off the debugger backend', () => {
    const { session } = createScriptingSession();

    expect(getFirefoxUnsupportedToolError('browser_console_messages')).toBe(
      `browser_console_messages is not available in Firefox: ${FIREFOX_PLATFORM_LIMIT}.`
    );
    expect(getFirefoxUnsupportedToolError('kilo_browser_drag')).toBe(
      `kilo_browser_drag is not available in Firefox: ${FIREFOX_PLATFORM_LIMIT}.`
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

describe('background tab viewport capture', () => {
  const LAYOUT = { clientHeight: 557, clientWidth: 1000 };

  it('returns the frame the screencast pushes, acked and then stopped', async () => {
    const frame = pngOfSize(LAYOUT.clientWidth, LAYOUT.clientHeight);
    const { debuggerApi, session } = createSession({
      layoutViewport: LAYOUT,
      // The metadata is in device-independent pixels; the frame's own header is what the size gate reads.
      screencast: {
        data: frame,
        deviceHeight: LAYOUT.clientHeight,
        deviceWidth: LAYOUT.clientWidth,
      },
    });

    await expect(session.captureViewportImage('png')).resolves.toBe(frame);

    const methods = debuggerApi.commands.map(command => command.method);

    expect(methods).toContain('Page.startScreencast');
    expect(methods).toContain('Page.screencastFrameAck');
    expect(methods).toContain('Page.stopScreencast');
    // The page is told it is looked at before the frame is asked for, which is what makes an inactive tab paint.
    expect(methods.indexOf('Emulation.setFocusEmulationEnabled')).toBeLessThan(
      methods.indexOf('Page.startScreencast')
    );
    expect(debuggerApi.commands).toContainEqual({
      method: 'Page.startScreencast',
      params: { everyNthFrame: 1, format: 'png' },
    });
  });

  it('falls back when no frame arrives inside the bound, and drops a late one', async () => {
    vi.useFakeTimers();

    try {
      const { debuggerApi, session } = createSession({ layoutViewport: LAYOUT });
      const capture = session.captureViewportImage('png');

      await vi.advanceTimersByTimeAsync(400);

      await expect(capture).resolves.toBeUndefined();
      // The screencast is stopped even when nothing came back.
      expect(debuggerApi.commands.map(command => command.method)).toContain('Page.stopScreencast');

      debuggerApi.emitEvent(7, 'Page.screencastFrame', {
        data: 'TEFURQ==',
        metadata: { deviceHeight: LAYOUT.clientHeight, deviceWidth: LAYOUT.clientWidth },
        sessionId: 4,
      });

      // The late frame answers nothing: the next capture is a fresh request, not this image.
      const next = session.captureViewportImage('png');

      await vi.advanceTimersByTimeAsync(400);

      await expect(next).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a frame that is not the size a plain capture of this viewport is', async () => {
    const { session } = createSession({
      layoutViewport: LAYOUT,
      // A frame at another scale would put the mask boxes off the pixels they must cover.
      screencast: { data: pngOfSize(2000, 1114), deviceHeight: 1114, deviceWidth: 2000 },
    });

    await expect(session.captureViewportImage('png')).resolves.toBeUndefined();
  });

  it('accepts the frame a plain capture of a DPR-2 viewport is, whatever the metadata reports', async () => {
    // A DPR-2 renderer reports a layout viewport in device pixels and captures at that size, while the
    // Screencast metadata stays in device-independent pixels, i.e. half of it. The image is the viewport,
    // So a gate on the metadata would throw away the frame that matches the mask geometry exactly.
    const layout = { clientHeight: 1114, clientWidth: 2000 };
    const frame = pngOfSize(2000, 1114);
    const { session } = createSession({
      layoutViewport: layout,
      screencast: { data: frame, deviceHeight: 557, deviceWidth: 1000 },
    });

    await expect(session.captureViewportImage('png')).resolves.toBe(frame);
  });

  it('refuses a frame whose header it cannot read, rather than scale the mask onto a guess', async () => {
    const { session } = createSession({
      layoutViewport: LAYOUT,
      screencast: { data: 'TlVSU0VSQ0FTVA==', deviceHeight: 557, deviceWidth: 1000 },
    });

    // Not a png or a jpeg: the plain capture is the only image whose pixels are known.
    await expect(session.captureViewportImage('png')).resolves.toBeUndefined();
  });

  it('takes no frame on a platform without the debugger', async () => {
    const { session } = createScriptingSession();

    await expect(session.captureViewportImage('png')).resolves.toBeUndefined();
  });

  it('gives each capture its own screencast, so an older one cannot stop a newer one\u2019s frame', async () => {
    vi.useFakeTimers();

    try {
      const { debuggerApi, session } = createSession({ layoutViewport: LAYOUT });
      const older = session.captureViewportImage('png');

      // The older capture is still waiting for its frame when the newer one starts on the same tab.
      await vi.advanceTimersByTimeAsync(240);

      const newer = session.captureViewportImage('png');

      // The older capture's bound expires while the newer one waits: only its own attempt may be given up.
      await vi.advanceTimersByTimeAsync(20);

      const frame = pngOfSize(LAYOUT.clientWidth, LAYOUT.clientHeight);

      debuggerApi.emitEvent(7, 'Page.screencastFrame', {
        data: frame,
        metadata: { deviceHeight: LAYOUT.clientHeight, deviceWidth: LAYOUT.clientWidth },
        sessionId: 5,
      });

      await expect(newer).resolves.toBe(frame);
      await expect(older).resolves.toBeUndefined();

      const methods = debuggerApi.commands.map(command => command.method);

      // The screencast is stopped once — by the capture that owns it — not by the capture it replaced.
      expect(methods.filter(method => method === 'Page.stopScreencast')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends nothing after the tab is taken over mid-capture', async () => {
    const { promise: gateWait, resolve: openGate } = Promise.withResolvers<void>();
    const { debuggerApi, session } = createSession({
      gate: { command: 'Page.getLayoutMetrics', wait: gateWait },
      layoutViewport: LAYOUT,
    });
    const taken = { cancelled: false };
    const capture = session.captureViewportImage(
      'png',
      {},
      {
        cancelled: () => taken.cancelled,
      }
    );

    await vi.waitFor(() => {
      expect(debuggerApi.commands.map(command => command.method)).toContain(
        'Page.getLayoutMetrics'
      );
    });

    // The panel took the tab while the measurement was in flight.
    taken.cancelled = true;
    openGate();

    await expect(capture).resolves.toBeUndefined();

    const methods = debuggerApi.commands.map(command => command.method);

    expect(methods).not.toContain('Page.startScreencast');
    expect(methods).not.toContain('Page.screencastFrameAck');
    expect(methods).not.toContain('Page.stopScreencast');
  });

  it('acks no frame and stops only its own screencast once the tab is taken over', async () => {
    const { debuggerApi, session } = createSession({ layoutViewport: LAYOUT });
    const taken = { cancelled: false };
    const capture = session.captureViewportImage(
      'png',
      {},
      {
        cancelled: () => taken.cancelled,
      }
    );

    await vi.waitFor(() => {
      expect(debuggerApi.commands.map(command => command.method)).toContain('Page.startScreencast');
    });

    taken.cancelled = true;
    debuggerApi.emitEvent(7, 'Page.screencastFrame', {
      data: 'VEFLRU4=',
      metadata: { deviceHeight: LAYOUT.clientHeight, deviceWidth: LAYOUT.clientWidth },
      sessionId: 6,
    });

    await expect(capture).resolves.toBeUndefined();

    const methods = debuggerApi.commands.map(command => command.method);

    // The frame belongs to nobody now: the ack is not sent, and the best-effort stop winds its own screencast down.
    expect(methods).not.toContain('Page.screencastFrameAck');
    expect(methods.filter(method => method === 'Page.stopScreencast')).toHaveLength(1);
  });

  it('takes no screencast frame for a webp request, which the protocol has no format for', async () => {
    const { debuggerApi, session } = createSession({
      layoutViewport: LAYOUT,
      screencast: {
        data: 'V0VCUA==',
        deviceHeight: LAYOUT.clientHeight,
        deviceWidth: LAYOUT.clientWidth,
      },
    });

    await expect(session.captureViewportImage('webp')).resolves.toBeUndefined();
    expect(debuggerApi.commands.map(command => command.method)).not.toContain(
      'Page.startScreencast'
    );
  });
});
