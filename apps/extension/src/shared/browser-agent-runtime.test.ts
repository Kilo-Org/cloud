/* eslint-disable vitest/no-conditional-in-test -- the fake CDP and tabs API answer per method and per tab id */
/* eslint-disable import/max-dependencies, max-lines, require-await, vitest/max-expects -- the suite drives one fake CDP session and one fake tab-group API through every agent tool path, whose fakes are async by contract. */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createBrowserTabGroupController } from './browser-tab-groups';
import type {
  BrowserTabGroupController,
  BrowserTabGroupPersistence,
  PersistedTabGroupSession,
} from './browser-tab-groups';
import { createTabLeaseRegistry } from './browser-tab-leases';
import type { TabLeaseRegistry } from './browser-tab-leases';
import { createBrowserRuntime } from './browser-runtime';
import type {
  BrowserDownloadItem,
  BrowserDownloadsApi,
  BrowserRuntime,
  BrowserToolRunOutcome,
} from './browser-runtime';
import {
  AGENT_TAB_OUTSIDE_GROUP_ERROR,
  DOWNLOAD_BLOCKED_BY_BROWSER_ERROR,
  DOWNLOAD_STEP_TAB_GONE_ERROR,
  hashBrowserToolArguments,
  NEEDS_PERMISSION_ERROR,
  ORIGIN_CHANGED_ERROR,
  SENSITIVE_REASON,
} from './browser-agent-checks';
import type { BrowserGrant } from './browser-agent-checks';
import { createRuntimeBrowserBridge } from './local-agents/browser-bridge';
import { LOCAL_AGENT_ERROR_CODES } from './local-agents/jsonrpc';
import { createDownloadHold } from './browser-download-hold';
import type {
  ApprovalNeed,
  DownloadHold,
  DownloadHoldNavigation,
  DownloadHoldReport,
  SettleWindow,
  TrackedDownload,
} from './browser-download-hold';
import { TAB_BUSY_ERROR, TAB_TAKEN_ERROR } from './browser-caller';
import type { BrowserCaller } from './browser-caller';
import type {
  BrowserTabInfo,
  BrowserTabsApi,
  ChromeDebuggerApi,
  ChromeDebuggerEventListener,
  EvalTabResult,
} from './tab-debugger';

const TAB_ID = 7;
const MAIN_ORIGIN = 'https://app.example.com';
const FRAME_ORIGIN = 'https://pay.example.com';

const agent = (sessionHandle = 'session-1'): BrowserCaller => ({
  controllerId: 'controller-1',
  kind: 'agent',
  sessionHandle,
});

/** The side panel: a caller with no model to report a download to. */
const panel = (): BrowserCaller => ({
  conversationId: 'conversation-1',
  kind: 'panel',
  panelId: 'panel-1',
});

type CdpHandler = (
  params: Record<string, unknown> | undefined,
  /** The tab the command was sent to: a deferred answer can be scoped to the tab a call drives. */
  target?: { readonly tabId: number }
) => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined;

type AgentResult = Extract<EvalTabResult, { readonly ok: true }>;

/**
 * Asserts the call produced a tool result and hands back the narrowed result, so
 * the test body never has to branch on the outcome's kind.
 */
const expectResult = (
  outcome: BrowserToolRunOutcome,
  message = 'expected a tool result'
): { readonly result: AgentResult; readonly withheldFrames: readonly string[] | undefined } => {
  if (outcome.kind !== 'result' || !outcome.result.ok) {
    throw new Error(message);
  }

  return { result: outcome.result, withheldFrames: outcome.withheldFrames };
};

/** The step token a refused sensitive call returns, so the retry can carry it. */
const expectStepToken = (outcome: BrowserToolRunOutcome): string => {
  if (outcome.kind !== 'needs_permission' || outcome.stepToken === undefined) {
    throw new Error('expected a step token');
  }

  return outcome.stepToken;
};

/** The result a navigate call reports alongside its `origin_changed` kind. */
const originChangedResultOf = (outcome: BrowserToolRunOutcome): EvalTabResult | undefined =>
  outcome.kind === 'origin_changed' ? outcome.result : undefined;

interface FakeCdp {
  /** Records the ordered CDP method names. */
  readonly commands: () => readonly string[];
  /** Every command with the tab it went to, its params and the url it named, in dispatch order. */
  readonly sent: () => readonly {
    readonly method: string;
    readonly params: Record<string, unknown> | undefined;
    readonly tabId: number;
    readonly url: string | undefined;
  }[];
  readonly downloadsDenied: () => number;
  readonly downloadsRestored: () => number;
  readonly emit: (method: string, params: Record<string, unknown>) => void;
  /** One event from a child (out-of-process frame) session, the way chrome.debugger reports it. */
  readonly emitFrom: (method: string, params: Record<string, unknown>, sessionId: string) => void;
  /** One event on a named tab, for a call that drives a tab the call itself opened. */
  readonly emitOn: (tabId: number, method: string, params: Record<string, unknown>) => void;
  readonly setHandlers: (handlers: Record<string, CdpHandler>) => void;
  readonly setFrameUrl: (url: string) => void;
  readonly setProbe: (probe: Record<string, unknown>) => void;
  readonly api: ChromeDebuggerApi;
}

const MAIN_TREE = {
  nodes: [
    { backendDOMNodeId: 1, childIds: ['2', '4'], nodeId: '1', role: { value: 'RootWebArea' } },
    { backendDOMNodeId: 2, name: { value: 'Pay now' }, nodeId: '2', role: { value: 'button' } },
    { backendDOMNodeId: 20, childIds: ['5'], nodeId: '4', role: { value: 'Iframe' } },
    {
      backendDOMNodeId: 21,
      name: { value: 'leaked frame text' },
      nodeId: '5',
      role: { value: 'StaticText' },
    },
  ],
};

const FRAME_TREE = {
  nodes: [
    { childIds: ['2'], nodeId: '1', role: { value: 'RootWebArea' } },
    {
      backendDOMNodeId: 31,
      name: { value: 'card marker-42' },
      nodeId: '2',
      role: { value: 'StaticText' },
    },
  ],
};

const frameTreePayload = (mainUrl: string): Record<string, unknown> => ({
  frameTree: {
    childFrames: [
      {
        frame: {
          id: 'f1',
          parentId: 'main',
          securityOrigin: FRAME_ORIGIN,
          url: `${FRAME_ORIGIN}/widget`,
        },
      },
    ],
    frame: { id: 'main', securityOrigin: MAIN_ORIGIN, url: mainUrl },
  },
});

const createFakeCdp = (): FakeCdp => {
  const commands: string[] = [];
  /** Every command with the tab it went to, its params and the url it named, so a test can tell one tab's call from another's. */
  const sent: {
    method: string;
    params: Record<string, unknown> | undefined;
    tabId: number;
    url: string | undefined;
  }[] = [];
  const eventListeners: ChromeDebuggerEventListener[] = [];
  let denied = 0;
  let restored = 0;
  let mainUrl = `${MAIN_ORIGIN}/dashboard`;
  let probe: Record<string, unknown> = { fields: [], paymentFormSubmit: false };
  let emitDownloadOnClick = false;
  const handlers: Record<string, CdpHandler> = {};

  /** The fake's own answer for a method no test handler claims. */
  const answerDefault = (
    method: string,
    params: Record<string, unknown> | undefined
  ): Record<string, unknown> => {
    switch (method) {
      case 'Accessibility.getFullAXTree': {
        const { frameId } = params ?? {};

        return frameId === undefined || frameId === 'main' ? MAIN_TREE : FRAME_TREE;
      }
      case 'DOM.getDocument': {
        return { root: { nodeId: 1 } };
      }
      case 'DOM.querySelectorAll': {
        return { nodeIds: [5] };
      }
      case 'DOM.resolveNode': {
        return { object: { objectId: 'obj-5' } };
      }
      case 'DOM.getBoxModel': {
        return { model: { content: [10, 10, 110, 10, 110, 60, 10, 60], height: 50, width: 100 } };
      }
      case 'DOM.describeNode': {
        return { node: { frameId: 'main' } };
      }
      case 'DOM.getContentQuads': {
        return { quads: [[10, 10, 110, 10, 110, 60, 10, 60]] };
      }
      case 'DOM.getFrameOwner': {
        return { backendNodeId: 20 };
      }
      case 'Page.captureScreenshot': {
        return { data: 'aGVsbG8=' };
      }
      case 'Page.createIsolatedWorld': {
        return { executionContextId: 3 };
      }
      case 'Page.getFrameTree': {
        return frameTreePayload(mainUrl);
      }
      case 'Page.getLayoutMetrics': {
        return {
          cssLayoutViewport: { clientWidth: 800 },
          cssVisualViewport: { pageX: 0, pageY: 0 },
          layoutViewport: { clientWidth: 800 },
        };
      }
      case 'Page.navigate': {
        return { frameId: 'main' };
      }
      case 'Page.setDownloadBehavior': {
        if ((params ?? {})['behavior'] === 'deny') {
          denied += 1;
        } else {
          restored += 1;
        }

        return {};
      }
      case 'Runtime.callFunctionOn': {
        const declaration = (params ?? {})['functionDeclaration'];

        // `browser_type` focuses and selects the field before it inserts the text.
        if (typeof declaration === 'string' && declaration.includes("status: 'ready'")) {
          return { result: { value: { status: 'ready' } } };
        }

        return { result: { value: JSON.stringify(probe) } };
      }
      case 'Runtime.evaluate': {
        const requested = (params ?? {})['expression'];
        const expression = typeof requested === 'string' ? requested : '';

        if (expression.includes('visibilityState')) {
          return { result: { value: 'visible' } };
        }

        if (expression.includes('readyState')) {
          return { result: { value: 'complete' } };
        }

        if (expression.includes('document.title')) {
          return { result: { value: { title: 'Example', url: mainUrl } } };
        }

        if (expression.includes('HIDDEN') || expression.includes('values')) {
          return { result: { value: JSON.stringify({ hidden: [], values: [] }) } };
        }

        // The script tools' page probe: this page holds no protected field.
        if (expression.includes('present')) {
          return { result: { value: JSON.stringify({ present: false }) } };
        }

        return { result: { value: 1 } };
      }
      default: {
        return {};
      }
    }
  };

  /**
   * A test handler answers first; one that answers `undefined` declines, so the call falls through to the fake's own
   * answer for that method and a handler can claim only the commands it is about.
   */
  const sendMailbox = async (
    method: string,
    params: Record<string, unknown> | undefined,
    target?: { readonly tabId: number }
  ): Promise<Record<string, unknown>> => {
    const handler = handlers[method];

    if (handler !== undefined) {
      const answered = await handler(params, target);

      if (answered !== undefined) {
        return answered;
      }
    }

    return answerDefault(method, params);
  };

  const api: ChromeDebuggerApi = {
    attach: async () => {},
    detach: async () => {},
    getTargets: async () => [],
    onDetach: { addListener: () => {}, removeListener: () => {} },
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
    sendCommand: async (target, method, params) => {
      commands.push(method);
      sent.push({
        method,
        params,
        tabId: target.tabId,
        url: typeof params?.['url'] === 'string' ? params['url'] : undefined,
      });

      if (method === 'Input.dispatchMouseEvent' && emitDownloadOnClick) {
        emitDownloadOnClick = false;
        const guid = 'download-1';

        for (const listener of eventListeners) {
          listener({ tabId: target.tabId }, 'Browser.downloadWillBegin', {
            guid,
            suggestedFilename: 'invoice.pdf',
            url: `${MAIN_ORIGIN}/invoice.pdf`,
          });
        }
      }

      return sendMailbox(method, params, target);
    },
  };

  return {
    api,
    commands: () => commands,
    downloadsDenied: () => denied,
    downloadsRestored: () => restored,
    emit: (method, params) => {
      for (const listener of eventListeners) {
        listener({ tabId: TAB_ID }, method, params);
      }
    },
    emitFrom: (method, params, sessionId) => {
      for (const listener of eventListeners) {
        listener({ sessionId, tabId: TAB_ID }, method, params);
      }
    },
    emitOn: (tabId, method, params) => {
      for (const listener of eventListeners) {
        listener({ tabId }, method, params);
      }
    },
    sent: () => sent,
    setFrameUrl: url => {
      mainUrl = url;
    },
    setHandlers: next => {
      Object.assign(handlers, next);
    },
    setProbe: next => {
      probe = next;
    },
  };
};

const createTabsApi = (): BrowserTabsApi => {
  const tab: BrowserTabInfo = { id: TAB_ID, title: 'Example', url: `${MAIN_ORIGIN}/dashboard` };

  return {
    get: async () => tab,
    query: async () => [tab],
  };
};

/** What the fake `chrome.downloads` hands a test: the API the runtime reads, and the records it left behind. */
interface FakeDownloads {
  readonly api: BrowserDownloadsApi;
  readonly cancelled: readonly number[];
  /** Records an item and tells the guard, as `chrome.downloads.onCreated` does. */
  readonly emit: (item: BrowserDownloadItem) => void;
  readonly erased: readonly { readonly id: number }[];
  /** How many `onCreated` listeners the guard has installed right now. */
  readonly live: () => number;
  /** Records an item without telling the guard: the browser creates one after the call's own command returned. */
  readonly record: (item: BrowserDownloadItem) => void;
  readonly removed: readonly number[];
  /** The history a `startedAfter` search answers with, which a test seeds itself. */
  readonly searched: BrowserDownloadItem[];
}

/** `chrome.downloads` as the runtime sees it: the single `onCreated` stream and the erase that deletes the file. */
const createFakeDownloads = (
  options: { readonly cancelRejects?: boolean; readonly removeRejects?: boolean } = {}
): FakeDownloads => {
  const listeners: ((item: BrowserDownloadItem) => void)[] = [];
  const cancelled: number[] = [];
  const erased: { readonly id: number }[] = [];
  const removed: number[] = [];
  const searched: BrowserDownloadItem[] = [];
  // One entry per item, as `chrome.downloads.search({ id })` reports it after the guard's cancel.
  const items = new Map<number, BrowserDownloadItem>();
  /** When the browser created each item, so a `startedAfter` search sees only that call's own window. */
  const recordedAt = new Map<number, number>();
  /** The items the browser itself created, in creation order; a url search answers the seeded history instead. */
  const created: BrowserDownloadItem[] = [];
  const api: BrowserDownloadsApi = {
    // Sorted keys: `cancel` first, as chrome.downloads declares them.
    cancel: async downloadId => {
      cancelled.push(downloadId);

      if (options.cancelRejects === true) {
        throw new Error('complete');
      }
    },
    erase: async query => {
      erased.push(query);
    },
    onCreated: {
      addListener: listener => {
        listeners.push(listener);
      },
      removeListener: listener => {
        const index = listeners.indexOf(listener);

        if (index !== -1) {
          listeners.splice(index, 1);
        }
      },
    },
    removeFile: async downloadId => {
      if (options.removeRejects === true) {
        throw new Error('cannot delete');
      }

      removed.push(downloadId);
    },
    search: async query => {
      if (query.id !== undefined) {
        const item = items.get(query.id);

        return item === undefined ? [] : [item];
      }

      const since = query.startedAfter;

      if (since !== undefined && typeof since !== 'string') {
        // Chrome validates `DownloadQuery.startedAfter` as an ISO-8601 string and rejects the whole search otherwise.
        throw new Error("Invalid value for argument 1. Property '.startedAfter': Expected string");
      }

      if (since !== undefined) {
        const sinceMs = Date.parse(since);
        // The items the browser created inside this call's window, plus whatever a test placed in the history itself.
        return [...searched, ...created.filter(item => (recordedAt.get(item.id) ?? 0) >= sinceMs)];
      }

      return searched;
    },
  };

  const record = (item: BrowserDownloadItem): void => {
    // A cancel that landed leaves the browser's own `interrupted`; a test says `complete` when it lost the race.
    const recorded = { state: 'interrupted', ...item };

    items.set(item.id, recorded);
    recordedAt.set(item.id, Date.now());
    created.push(recorded);
  };

  return {
    api,
    cancelled,
    /** Records an item and tells the guard, as `chrome.downloads.onCreated` does. */
    emit: (item: BrowserDownloadItem) => {
      record(item);

      for (const listener of listeners) {
        listener(item);
      }
    },
    erased,
    live: () => listeners.length,
    /** Records an item without telling the guard: the browser creates one after the call's own command returned. */
    record,
    removed,
    searched,
  };
};

const createHarness = async (
  options: {
    readonly downloadHold?: DownloadHold | undefined;
    readonly downloadsApi?: BrowserDownloadsApi | undefined;
    readonly downloadsGranted?: boolean;
    readonly downloadsResolver?: () => BrowserDownloadsApi | undefined;
    readonly leases?: TabLeaseRegistry;
    readonly share?: boolean;
    readonly tabGroups?: BrowserTabGroupController;
    readonly tabsApi?: BrowserTabsApi;
  } = {}
) => {
  const cdp = createFakeCdp();
  const leases = options.leases ?? createTabLeaseRegistry({});
  // The normal state is the granted permission: the switch asks for it, and without it every page load is refused.
  const grantedByDefault =
    options.downloadsGranted !== false &&
    options.downloadsResolver === undefined &&
    options.downloadsApi === undefined;
  const fallbackDownloads = grantedByDefault ? createFakeDownloads() : undefined;
  const provided = options.downloadsApi;
  let downloadsApi =
    options.downloadsResolver ?? (provided === undefined ? undefined : () => provided);

  if (downloadsApi === undefined && fallbackDownloads !== undefined) {
    downloadsApi = () => fallbackDownloads.api;
  }
  const runtime = createBrowserRuntime({
    debuggerApi: cdp.api,
    ...(downloadsApi === undefined ? {} : { downloadsApi }),
    ...(options.downloadHold === undefined ? {} : { downloadHold: options.downloadHold }),
    leases,
    scriptingApi: undefined,
    ...(options.tabGroups === undefined ? {} : { tabGroups: options.tabGroups }),
    tabsApi: options.tabsApi ?? createTabsApi(),
  });

  // D9: an agent reaches only its session's group, so session-1 owns the tab unless a case says otherwise.
  if (options.share !== false) {
    await runtime.openSession({
      controllerId: 'controller-1',
      sessionHandle: 'session-1',
      title: 'Work',
    });
    await runtime.shareActiveTab({ sessionHandle: 'session-1', tabId: TAB_ID });
  }

  return { cdp, downloads: fallbackDownloads, leases, runtime };
};

const createGroups = () => {
  const updates: { readonly groupId: number; readonly props: Record<string, unknown> }[] = [];
  const controller = createBrowserTabGroupController({
    api: {
      get: async () => ({ id: 42 }),
      group: async () => 42,
      queryGroup: async () => [{ id: 42 }],
      tabQuery: async () => [{ active: true, id: TAB_ID, windowId: 1 }],
      update: async (groupId, props) => {
        updates.push({ groupId, props });
      },
    },
  });

  return { controller, updates };
};

/** The first grouping attempt fails (so a share leaves no group), later ones succeed. */
const failFirstGroupCall = (
  calls: { readonly groupId?: number; readonly tabIds: readonly number[] }[]
): ((options: {
  readonly groupId?: number;
  readonly tabIds: readonly number[];
}) => Promise<number>) => {
  let attempts = 0;

  return options => {
    attempts += 1;

    if (attempts === 1) {
      return Promise.reject(new Error('group failed'));
    }

    calls.push(options);

    return Promise.resolve(42);
  };
};

const readGrant = { class: 'read' as const, origin: MAIN_ORIGIN };
const actGrant = { class: 'act' as const, origin: MAIN_ORIGIN };

describe('agent browser calls', () => {
  it('refuses a read the CLI did not approve, before any page work', async () => {
    const { cdp, runtime } = await createHarness();

    const outcome = await runtime.runTool({
      agent: { authorized: [] },
      arguments: {},
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_snapshot',
    });

    expect(outcome).toMatchObject({
      items: [{ class: 'read', origin: MAIN_ORIGIN }],
      kind: 'needs_permission',
      result: { error: NEEDS_PERMISSION_ERROR, ok: false },
    });
    expect(cdp.commands()).not.toContain('Accessibility.getFullAXTree');
  });

  it('withholds an iframe origin from the snapshot and reports it', async () => {
    const { runtime } = await createHarness();

    const outcome = await runtime.runTool({
      agent: { authorized: [readGrant] },
      arguments: {},
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_snapshot',
    });

    expect(outcome.kind).toBe('result');

    const { result, withheldFrames } = expectResult(outcome, 'expected a snapshot result');
    const text = String(result.value);

    expect(text).toContain(`[origin withheld: ${FRAME_ORIGIN}]`);
    expect(text).not.toContain('marker-42');
    expect(withheldFrames).toStrictEqual([FRAME_ORIGIN]);
  });

  it('splices the iframe in once its origin is approved and still drops its withheld console entries', async () => {
    const { cdp, runtime } = await createHarness();
    const authorized = [readGrant, { class: 'read' as const, origin: FRAME_ORIGIN }];

    const outcome = await runtime.runTool({
      agent: { authorized },
      arguments: {},
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_snapshot',
    });

    const { result, withheldFrames } = expectResult(outcome, 'expected a snapshot result');

    expect(String(result.value)).toContain('marker-42');
    expect(withheldFrames).toStrictEqual([]);

    // A console entry sourced from another origin the agent may not read is dropped.
    cdp.emit('Runtime.consoleAPICalled', {
      args: [{ value: 'secret from frame' }],
      timestamp: 1_000_000,
      type: 'log',
    });

    const consoleOutcome = await runtime.runTool({
      agent: { authorized: [readGrant] },
      arguments: { all: true, level: 'info' },
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_console_messages',
    });

    expect(consoleOutcome.kind).toBe('result');
  });

  it('reports origin_changed when a navigation redirects to another origin', async () => {
    const { cdp, runtime } = await createHarness();
    const destination = 'https://other.example.com';

    cdp.setFrameUrl('https://accounts.example.org/login');

    const outcome = await runtime.runTool({
      agent: {
        authorized: [readGrant, actGrant, { class: 'navigate', origin: destination }],
      },
      arguments: { url: `${destination}/home` },
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_navigate',
    });

    expect(outcome).toMatchObject({
      from: destination,
      kind: 'origin_changed',
      to: 'https://accounts.example.org',
    });
    expect(originChangedResultOf(outcome)).toBeDefined();
  });

  it('completes a redirect that lands on an origin the call was granted', async () => {
    const { cdp, runtime } = await createHarness();
    const destination = 'https://other.example.com';

    cdp.setFrameUrl('https://accounts.example.org/login');

    const outcome = await runtime.runTool({
      agent: {
        authorized: [
          readGrant,
          actGrant,
          { class: 'navigate', origin: destination },
          { class: 'read', origin: 'https://accounts.example.org' },
        ],
      },
      arguments: { url: `${destination}/home` },
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_navigate',
    });

    expect(outcome.kind).toBe('result');
  });

  it('needs a step token for a password field and accepts the retry that carries it', async () => {
    const { cdp, runtime } = await createHarness();

    cdp.setProbe({ fields: [{ kind: 'password' }], paymentFormSubmit: false });

    const args = { target: '#cc', text: 'hunter2' };
    const refused = await runtime.runTool({
      agent: { authorized: [readGrant, actGrant] },
      arguments: args,
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_type',
    });

    expect(refused).toMatchObject({
      items: [{ class: 'sensitive', origin: MAIN_ORIGIN, reason: SENSITIVE_REASON.password }],
      kind: 'needs_permission',
      result: { error: NEEDS_PERMISSION_ERROR, ok: false },
    });

    const stepToken = expectStepToken(refused);

    const allowed = await runtime.runTool({
      agent: { authorized: [readGrant, actGrant], sensitive: [stepToken] },
      arguments: args,
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_type',
    });

    expect(allowed.kind).toBe('result');
    expect(cdp.commands()).toContain('Input.insertText');

    // The token is single use: a second call with the same token is refused again.
    const replayed = await runtime.runTool({
      agent: { authorized: [readGrant, actGrant], sensitive: [stepToken] },
      arguments: args,
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_type',
    });

    expect(replayed.kind).toBe('needs_permission');
  });

  it('cancels a download an unapproved act call started and asks for a step token', async () => {
    const { cdp, runtime } = await createHarness();

    cdp.setHandlers({
      'Input.dispatchMouseEvent': () => {
        cdp.emit('Browser.downloadWillBegin', {
          guid: 'download-9',
          suggestedFilename: 'invoice.pdf',
          url: `${MAIN_ORIGIN}/invoice.pdf`,
        });

        return {};
      },
    });

    const outcome = await runtime.runTool({
      agent: { authorized: [readGrant, actGrant] },
      arguments: { target: '#pay' },
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_click',
    });

    expect(outcome).toMatchObject({
      afterAction: true,
      items: [{ class: 'sensitive', origin: MAIN_ORIGIN, reason: SENSITIVE_REASON.download }],
      kind: 'needs_permission',
    });
    // The refusal names the file the announcement named, so the one approval is for a file the model can point at.
    expect(
      outcome.kind === 'needs_permission' && !outcome.result.ok ? outcome.result.error : ''
    ).toContain('invoice.pdf');
    // The click ran once: a click is a press and a release, and nothing ran the action a second time.
    expect(cdp.commands().filter(method => method === 'Input.dispatchMouseEvent')).toHaveLength(2);
    // Denying is what stops an unapproved file; restoring puts the profile back as the human had it.
    expect([cdp.downloadsDenied(), cdp.downloadsRestored()]).toStrictEqual([1, 1]);

    expect(expectStepToken(outcome)).toBeDefined();
  });

  it('cancels the file through chrome.downloads, which a tab target cannot do itself', async () => {
    const downloads = createFakeDownloads();
    const { cdp, runtime } = await createHarness({ downloadsApi: downloads.api });
    let emitting = true;

    cdp.setHandlers({
      'Input.dispatchMouseEvent': () => {
        // A click is a press and a release; the browser names the download once, while the command is still in flight.
        if (emitting) {
          emitting = false;
          downloads.emit({ id: 41, tabId: TAB_ID });
        }

        return {};
      },
    });

    const click = (sensitive: readonly string[]) =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant], sensitive: [...sensitive] },
        arguments: { target: '#pay' },
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_click',
      });

    const refused = await click([]);

    expect(refused).toMatchObject({
      afterAction: true,
      items: [{ class: 'sensitive', origin: MAIN_ORIGIN, reason: SENSITIVE_REASON.download }],
      kind: 'needs_permission',
    });
    // The unapproved file is cancelled and the listener does not outlive the call.
    expect([downloads.cancelled, downloads.removed, downloads.live()]).toStrictEqual([[41], [], 0]);

    const approved = await click([expectStepToken(refused)]);

    // The approval keeps its download: nothing is cancelled on the unguarded run.
    expect(approved.kind).toBe('result');
    const { cancelled } = downloads;
    expect(cancelled).toStrictEqual([41]);
  });

  it('keeps only the approved file when the approved call starts a second download', async () => {
    const downloads = createFakeDownloads();
    const { cdp, runtime } = await createHarness({ downloadsApi: downloads.api });
    let commands = 0;

    cdp.setHandlers({
      'Input.dispatchMouseEvent': () => {
        const click = Math.floor(commands / 2);

        commands += 1;

        if (commands % 2 === 0) {
          if (click === 0) {
            downloads.emit({ id: 41, tabId: TAB_ID, url: `${MAIN_ORIGIN}/invoice.pdf` });
          } else if (click === 1) {
            downloads.emit({ id: 42, tabId: TAB_ID, url: `${MAIN_ORIGIN}/invoice.pdf` });
            downloads.emit({ id: 43, tabId: TAB_ID, url: `${MAIN_ORIGIN}/other.pdf` });
          }
        }

        return {};
      },
    });

    const click = (sensitive: readonly string[]) =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant], sensitive: [...sensitive] },
        arguments: { target: '#pay' },
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_click',
      });

    const refused = await click([]);

    expect(refused.kind).toBe('needs_permission');
    expect(downloads.cancelled).toStrictEqual([41]);

    const approved = await click([expectStepToken(refused)]);

    expect(approved).toMatchObject({
      afterAction: true,
      items: [{ class: 'sensitive', origin: MAIN_ORIGIN, reason: SENSITIVE_REASON.download }],
    });
    expect(expectStepToken(approved)).toBeDefined();
    expect([downloads.cancelled, downloads.removed]).toStrictEqual([[41, 43], []]);
  });

  it('reports the browser blocking an approved download, and keeps the approval unspent', async () => {
    const downloads = createFakeDownloads();
    const { cdp, runtime } = await createHarness({ downloadsApi: downloads.api });
    let clicks = 0;

    cdp.setHandlers({
      'Input.dispatchMouseEvent': () => {
        clicks += 1;

        // Only the press runs the step: the release is the second command of the same click.
        if (clicks === 1) {
          // The browser names the file first, and the item it creates is stamped well before either call: the
          // Refusal is built from the announcement, and neither guard claims the pre-existing item as its own.
          // No item is created for the approved repeat, which is what Chrome's multiple-downloads limiter does.
          cdp.emit('Browser.downloadWillBegin', {
            guid: 'blocked-1',
            suggestedFilename: 'invoice.pdf',
            url: `${MAIN_ORIGIN}/invoice.pdf`,
          });
          downloads.emit({
            id: 41,
            startTime: new Date(Date.now() - 60_000).toISOString(),
            tabId: TAB_ID,
            url: `${MAIN_ORIGIN}/invoice.pdf`,
          });
        }

        return {};
      },
    });

    const click = (sensitive: readonly string[]) =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant], sensitive: [...sensitive] },
        arguments: { target: '#pay' },
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_click',
      });

    const refused = await click([]);

    expect(refused.kind).toBe('needs_permission');

    const approved = await click([expectStepToken(refused)]);

    // Never a plain success: the file the human approved never arrived, and the text says who blocked it.
    expect(approved).toMatchObject({
      afterAction: true,
      items: [{ class: 'sensitive', origin: MAIN_ORIGIN, reason: SENSITIVE_REASON.download }],
      kind: 'needs_permission',
    });
    expect(
      approved.kind === 'needs_permission' && !approved.result.ok ? approved.result.error : ''
    ).toBe(DOWNLOAD_BLOCKED_BY_BROWSER_ERROR);

    // The approval is unspent and a fresh token is offered, so the repeat needs no second decision once the site
    // Is allowed: a human is never asked again for a file the browser itself refused.
    expect(expectStepToken(approved)).not.toBe('');

    // The site is still not allowed, so the next repeat is blocked the same way — and still offers an unspent token.
    const retried = await click([expectStepToken(approved)]);

    expect(
      retried.kind === 'needs_permission' && !retried.result.ok ? retried.result.error : ''
    ).toBe(DOWNLOAD_BLOCKED_BY_BROWSER_ERROR);
  });

  it('names the file in the refusal and in the approval text, and keeps the file it named', async () => {
    const downloads = createFakeDownloads();
    const { cdp, runtime } = await createHarness({ downloadsApi: downloads.api });
    let clicks = 0;

    cdp.setHandlers({
      'Input.dispatchMouseEvent': () => {
        clicks += 1;

        // One press per click: the release is the second command of the same click, and it starts nothing.
        if (clicks % 2 === 1) {
          cdp.emit('Browser.downloadWillBegin', {
            guid: `download-${String(clicks)}`,
            suggestedFilename: 'quarterly-report.txt',
            url: `${MAIN_ORIGIN}/statement`,
          });
          downloads.emit({
            filename: '/home/me/Downloads/quarterly-report.txt',
            id: clicks === 1 ? 41 : 42,
            tabId: TAB_ID,
            url: `${MAIN_ORIGIN}/statement`,
          });
        }

        return {};
      },
    });

    const click = (sensitive: readonly string[]) =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant], sensitive: [...sensitive] },
        arguments: { target: '#pay' },
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_click',
      });

    const refused = await click([]);
    const refusalText =
      refused.kind === 'needs_permission' && !refused.result.ok ? refused.result.error : '';

    // The refusal names the file the announcement named, not the url's last segment.
    expect(refusalText).toContain('quarterly-report.txt');

    const approved = await click([expectStepToken(refused)]);

    // The success names the same file, once, and it is the item the approval kept.
    expect(approved).toMatchObject({ kind: 'result', result: { ok: true } });
    const approvedText =
      approved.kind === 'result' && approved.result.ok ? String(approved.result.value) : '';

    expect(approvedText).toContain('quarterly-report.txt');
    expect(approvedText).toContain('The file was downloaded; the page did not change.');
    // The second item is the approved file; the first was the refused one.
    expect([downloads.cancelled, downloads.removed]).toStrictEqual([[41], []]);
  });

  it('never touches a download on another tab while an approved call runs', async () => {
    const downloads = createFakeDownloads();
    const { cdp, runtime } = await createHarness({ downloadsApi: downloads.api });
    const otherTab = TAB_ID + 1;
    let commands = 0;

    cdp.setHandlers({
      'Input.dispatchMouseEvent': () => {
        const click = Math.floor(commands / 2);

        commands += 1;

        if (commands % 2 === 0 && click === 0) {
          downloads.emit({ id: 41, tabId: TAB_ID, url: `${MAIN_ORIGIN}/invoice.pdf` });
        } else if (commands % 2 === 0) {
          downloads.emit({ id: 42, tabId: TAB_ID, url: `${MAIN_ORIGIN}/invoice.pdf` });
          // The user's own download, in another tab: no approval of this session covers it.
          downloads.emit({ id: 90, tabId: otherTab, url: `${MAIN_ORIGIN}/user.pdf` });
        }

        return {};
      },
    });

    const click = (sensitive: readonly string[]) =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant], sensitive: [...sensitive] },
        arguments: { target: '#pay' },
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_click',
      });

    const refused = await click([]);

    expect(refused.kind).toBe('needs_permission');

    const approved = await click([expectStepToken(refused)]);

    // The approved call keeps its file and answers with its own result: the other tab's download is not reported.
    expect(approved.kind).toBe('result');
    expect([downloads.cancelled, downloads.removed]).toStrictEqual([[41], []]);
  });

  it('keeps the approved file when the human approves thirty seconds later', async () => {
    const downloads = createFakeDownloads();
    const { cdp, runtime } = await createHarness({ downloadsApi: downloads.api });
    const invoice = `${MAIN_ORIGIN}/invoice.pdf`;
    let events = 0;
    let presses = 0;

    cdp.setHandlers({
      'Input.dispatchMouseEvent': () => {
        // A click is a press and a release: only a press is a call that really ran the tool.
        const press = events % 2 === 0;

        events += 1;

        if (press) {
          presses += 1;
        }

        // The first press is the refused click: its file is stopped by the guard the call runs.
        if (press && presses === 1) {
          downloads.emit({ id: 41, tabId: TAB_ID, url: invoice });
        }

        // The second press is the approved repeat. Its page starts the approved file — under a regenerated url, as
        // A page that counts its clicks does — and a second, different file that is nobody's approval.
        if (press && presses === 2) {
          downloads.emit({ id: 42, tabId: TAB_ID, url: `${invoice}?click=2` });
          downloads.emit({ id: 43, tabId: TAB_ID, url: `${MAIN_ORIGIN}/statement.pdf` });
        }

        return {};
      },
    });

    const click = (sensitive: readonly string[]) =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant], sensitive: [...sensitive] },
        arguments: { target: '#pay' },
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_click',
      });

    vi.useFakeTimers();

    try {
      const refused = await runTimed(click([]));

      if (refused.kind !== 'needs_permission') {
        throw new Error(`expected a refusal, got ${JSON.stringify(refused)}`);
      }

      // The refused click's own file: stopped, and the only stop until the approval.
      expect(downloads.cancelled).toStrictEqual([41]);

      // A human takes their time, and the model keeps working meanwhile: the next call prunes the reported record,
      // So only the token can still name the file.
      await vi.advanceTimersByTimeAsync(20_000);
      await runTimed(
        runtime.runTool({
          agent: { authorized: [readGrant, actGrant] },
          arguments: {},
          caller: agent(),
          tabId: TAB_ID,
          toolName: 'browser_take_screenshot',
        }),
        0
      );
      await vi.advanceTimersByTimeAsync(10_000);

      const approved = await runTimed(click([expectStepToken(refused)]), 300);

      // The token's need is what keeps 42 and stops 43: without it the repeat runs unguarded, keeps both files and
      // Reports neither, so this pair of assertions is the test.
      expect(downloads.cancelled).toStrictEqual([41, 43]);
      expect(downloads.removed).toStrictEqual([]);

      if (approved.kind !== 'needs_permission') {
        throw new Error(`expected the second file to be reported, got ${JSON.stringify(approved)}`);
      }

      expect(approved.afterAction).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops and reports a download the approved call starts after it returned', async () => {
    const downloads = createFakeDownloads();
    const { cdp, runtime } = await createHarness({ downloadsApi: downloads.api });
    let commands = 0;

    cdp.setHandlers({
      'Input.dispatchMouseEvent': () => {
        const click = Math.floor(commands / 2);

        commands += 1;

        // The same file both times: the refused click starts it, and the approved repeat starts it again.
        if (commands % 2 === 0) {
          downloads.emit({
            id: click === 0 ? 41 : 42,
            tabId: TAB_ID,
            url: `${MAIN_ORIGIN}/invoice.pdf`,
          });
        }

        return {};
      },
    });

    const click = (sensitive: readonly string[]) =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant], sensitive: [...sensitive] },
        arguments: { target: '#pay' },
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_click',
      });

    const refused = await click([]);

    expect(refused.kind).toBe('needs_permission');

    const approved = await click([expectStepToken(refused)]);

    expect(approved.kind).toBe('result');

    // The page starts a second download after the call answered: the approved call's own linger still owns the tab,
    // And the file it must not keep is stopped rather than left where the user finds it later.
    downloads.emit({ id: 44, tabId: TAB_ID, url: `${MAIN_ORIGIN}/late.pdf` });

    const next = await click([]);

    expect(next.kind).toBe('needs_permission');
    expect(downloads.cancelled).toStrictEqual([41, 44]);
  });

  it('completes an approved browser_tabs new that is refused again for a second download', async () => {
    const downloads = createFakeDownloads();
    const created: Record<string, unknown>[] = [];
    const openedListeners: ((tab: {
      readonly id?: number;
      readonly openerTabId?: number;
    }) => void)[] = [];
    const newTab = TAB_ID + 6;
    let navigations = 0;
    downloads.searched.push({ filename: '/home/me/Downloads/report.txt', id: 72 });

    const tabsApi = {
      create: async (properties: { readonly url?: string } = {}) => {
        created.push({ ...properties });

        for (const listener of openedListeners) {
          listener({ id: newTab, openerTabId: TAB_ID });
        }

        return { id: newTab, title: '', url: properties.url ?? 'about:blank', windowId: 1 };
      },
      get: async (tabId: number) =>
        tabId === newTab
          ? { id: newTab, title: '', url: `${MAIN_ORIGIN}/report.txt`, windowId: 1 }
          : { id: TAB_ID, title: 'Example', url: MAIN_ORIGIN, windowId: 1 },
      onCreated: {
        addListener: (
          listener: (tab: { readonly id?: number; readonly openerTabId?: number }) => void
        ) => {
          openedListeners.push(listener);
        },
        removeListener: (
          listener: (tab: { readonly id?: number; readonly openerTabId?: number }) => void
        ) => {
          const index = openedListeners.indexOf(listener);

          if (index !== -1) {
            openedListeners.splice(index, 1);
          }
        },
      },
      query: async () => [
        { active: true, id: TAB_ID, title: 'Example', url: MAIN_ORIGIN, windowId: 1 },
      ],
    };
    const { controller } = createGroups();
    const { cdp, runtime } = await createHarness({
      downloadsApi: downloads.api,
      tabGroups: controller,
      tabsApi,
    });

    cdp.setHandlers({
      'Page.navigate': () => {
        navigations += 1;

        // The guarded step starts the file; the approved repeat starts it again and the page adds a second one.
        if (navigations === 1) {
          downloads.emit({ id: 71, tabId: newTab, url: `${MAIN_ORIGIN}/report.txt` });
        } else if (navigations === 2) {
          downloads.emit({ id: 72, tabId: newTab, url: `${MAIN_ORIGIN}/report.txt` });
          downloads.emit({ id: 73, tabId: newTab, url: `${MAIN_ORIGIN}/extra.txt` });
        }

        return { errorText: 'net::ERR_ABORTED' };
      },
    });

    const url = `${MAIN_ORIGIN}/report.txt`;
    const openTab = (sensitive: readonly string[]) =>
      runtime.runTool({
        agent: {
          authorized: [readGrant, actGrant, { class: 'navigate', origin: MAIN_ORIGIN }],
          sensitive: [...sensitive],
        },
        arguments: { action: 'new', url },
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_tabs',
      });

    const guarded = await openTab([]);

    if (guarded.kind !== 'needs_permission') {
      throw new Error(`expected a refusal, got ${JSON.stringify(guarded)}`);
    }

    const refusedAgain = await openTab([expectStepToken(guarded)]);

    // The second download is guarded, and the new token names the tab the repeat is driving.
    if (refusedAgain.kind !== 'needs_permission') {
      throw new Error(`expected a second refusal, got ${JSON.stringify(refusedAgain)}`);
    }

    const approved = await openTab([expectStepToken(refusedAgain)]);

    // The approval completes on the tab it already opened: no vanished step tab, and no second tab.
    expect(approved.kind).toBe('result');
    expect([created.length, downloads.cancelled]).toStrictEqual([1, [71, 73]]);

    // The refusal re-recorded that tab, so the repeat navigated it — the tab the step opened, at the approved url —
    // Rather than the caller's tab or a fresh one. A `DOWNLOAD_STEP_TAB_GONE_ERROR` would have been a result too, so
    // The kept-file text is what separates a completed approval from a refused one.
    expect(cdp.sent().findLast(command => command.method === 'Page.navigate')).toStrictEqual({
      method: 'Page.navigate',
      params: { url },
      tabId: newTab,
      url,
    });
    expect(
      approved.kind === 'result' && approved.result.ok ? String(approved.result.value) : ''
    ).toContain('report.txt: The file was downloaded; the page did not change.');
  });

  it('runs a normal navigate without the optional permission and arms only Document pauses', async () => {
    // No downloads API: no item can be held, so the response interceptor is the guard a call has.
    const { cdp, runtime } = await createHarness({ downloadsGranted: false });

    const outcome = await runtime.runTool({
      agent: { authorized: [readGrant, actGrant, { class: 'navigate', origin: MAIN_ORIGIN }] },
      arguments: { url: `${MAIN_ORIGIN}/dashboard` },
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_navigate',
    });

    // An ordinary page load succeeds: a user who declined the permission keeps the browser.
    expect(outcome).toMatchObject({ kind: 'result', result: { ok: true } });
    expect(cdp.commands()).toContain('Page.navigate');

    // A catch-all pattern would pause every image, script and font on the tab: only documents are paused.
    expect(cdp.sent().find(command => command.method === 'Fetch.enable')?.params).toStrictEqual({
      patterns: [{ requestStage: 'Response', resourceType: 'Document' }],
    });
    // The interceptor is released with the call, so an ordinary page keeps its own speed afterwards.
    expect(cdp.commands()).toContain('Fetch.disable');
  });

  it('fails a download response and reports the file by the name the response asked for', async () => {
    const { cdp, runtime } = await createHarness({ downloadsGranted: false });

    cdp.setHandlers({
      'Page.navigate': () => {
        // The browser pauses the response that would become a file, before any byte reaches the disk.
        cdp.emit('Fetch.requestPaused', {
          requestId: 'interception-1',
          responseHeaders: [
            { name: 'Content-Disposition', value: 'attachment; filename="report.txt"' },
            { name: 'Content-Type', value: 'text/plain' },
          ],
          responseStatusCode: 200,
        });

        return { errorText: 'net::ERR_ABORTED' };
      },
    });

    const outcome = await runtime.runTool({
      agent: { authorized: [readGrant, actGrant, { class: 'navigate', origin: MAIN_ORIGIN }] },
      arguments: { url: `${MAIN_ORIGIN}/download` },
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_navigate',
    });

    // The response is failed, never continued: continuing it would write the file the human never approved.
    const answers = cdp
      .sent()
      .filter(
        command =>
          command.method === 'Fetch.failRequest' || command.method === 'Fetch.continueResponse'
      )
      .map(command => [command.method, command.params?.['requestId']]);

    expect(answers).toStrictEqual([['Fetch.failRequest', 'interception-1']]);

    // Without the optional permission no approval can be redeemed, so the text names the file and the grant.
    expect(outcome).toMatchObject({
      afterAction: true,
      items: [{ class: 'sensitive', origin: MAIN_ORIGIN, reason: SENSITIVE_REASON.download }],
      kind: 'needs_permission',
    });
    expect(
      outcome.kind === 'needs_permission' && !outcome.result.ok ? outcome.result.error : ''
    ).toContain('report.txt');
    // The token is offered only where it can be spent: without `downloads` nothing can honour it.
    expect(outcome.kind === 'needs_permission' ? outcome.stepToken : 'unexpected').toBeUndefined();
  });

  it('continues a pdf document response, which is a page Chrome renders rather than a file', async () => {
    const { cdp, runtime } = await createHarness({ downloadsGranted: false });

    cdp.setHandlers({
      'Page.navigate': () => {
        cdp.emit('Fetch.requestPaused', {
          requestId: 'interception-2',
          responseHeaders: [{ name: 'Content-Type', value: 'application/pdf' }],
          responseStatusCode: 200,
        });

        return { frameId: 'main' };
      },
    });

    const outcome = await runtime.runTool({
      agent: { authorized: [readGrant, actGrant, { class: 'navigate', origin: MAIN_ORIGIN }] },
      arguments: { url: `${MAIN_ORIGIN}/file.pdf` },
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_navigate',
    });

    expect(
      cdp
        .sent()
        .filter(
          command =>
            command.method === 'Fetch.failRequest' || command.method === 'Fetch.continueResponse'
        )
        .map(command => [command.method, command.params?.['requestId']])
    ).toStrictEqual([['Fetch.continueResponse', 'interception-2']]);
    // A rendered document is a page load, and it answers as one.
    expect(outcome).toMatchObject({ kind: 'result', result: { ok: true } });
  });

  it('reports a blob download, which no response can stop, as possibly saved', async () => {
    const { cdp, runtime } = await createHarness({ downloadsGranted: false });

    cdp.setHandlers({
      'Input.dispatchMouseEvent': () => {
        // No network response exists for a blob: the announcement is the only thing that names the file.
        cdp.emit('Browser.downloadWillBegin', {
          guid: 'blob-1',
          suggestedFilename: 'blob.txt',
          url: 'blob:https://app.example.com/6f1a',
        });

        return {};
      },
    });

    const outcome = await runtime.runTool({
      agent: { authorized: [readGrant, actGrant] },
      arguments: { target: '#export' },
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_click',
    });

    expect(outcome).toMatchObject({
      afterAction: true,
      items: [{ class: 'sensitive', origin: MAIN_ORIGIN, reason: SENSITIVE_REASON.download }],
      kind: 'needs_permission',
    });
    const message =
      outcome.kind === 'needs_permission' && !outcome.result.ok ? outcome.result.error : '';

    // Honest, not a claim that nothing was written: the file may exist under the name the page gave it.
    expect(message).toContain('blob.txt');
    expect(message).toContain('may have been saved');
  });

  it('leaves no tab listener behind when the optional permission is missing', async () => {
    const created = new Set<(tab: { readonly id?: number }) => void>();
    const tabsApi: BrowserTabsApi = {
      get: async () => ({ id: TAB_ID, title: 'Example', url: `${MAIN_ORIGIN}/dashboard` }),
      onCreated: {
        addListener: listener => created.add(listener),
        removeListener: listener => created.delete(listener),
      },
      query: async () => [{ id: TAB_ID, title: 'Example', url: `${MAIN_ORIGIN}/dashboard` }],
    };
    const { cdp, runtime } = await createHarness({ downloadsGranted: false, tabsApi });

    const click = () =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant] },
        arguments: { target: '#pay' },
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_click',
      });

    // The response interceptor is the guard, so nothing subscribes to the item stream it cannot read.
    await expect(click()).resolves.toMatchObject({ kind: 'result', result: { ok: true } });
    expect(created.size).toBe(0);
    expect(cdp.commands()).toContain('Fetch.disable');
  });

  it('runs a download call unguarded once with the approval token, then burns it', async () => {
    const { cdp, runtime } = await createHarness();
    // Chrome names every download with its own guid, so each click's announcement is a new download.
    let announced = 0;

    cdp.setHandlers({
      'Input.dispatchMouseEvent': () => {
        announced += 1;
        cdp.emit('Browser.downloadWillBegin', {
          guid: `download-9-${String(announced)}`,
          suggestedFilename: 'invoice.pdf',
          url: `${MAIN_ORIGIN}/invoice.pdf`,
        });

        return {};
      },
    });

    const click = (sensitive: readonly string[]) =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant], sensitive: [...sensitive] },
        arguments: { target: '#pay' },
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_click',
      });

    const refused = await click([]);
    const token = expectStepToken(refused);

    const approved = await click([token]);

    // The next identical call runs with the guard off and keeps its download.
    expect(approved.kind).toBe('result');
    expect(cdp.downloadsDenied()).toBe(1);

    const replay = await click([token]);

    expect(replay).toMatchObject({ afterAction: true, kind: 'needs_permission' });
    expect(cdp.downloadsDenied()).toBe(2);
  });

  it('leaves a download another tab or the user started alone', async () => {
    const downloads = createFakeDownloads();
    const { cdp, runtime } = await createHarness({ downloadsApi: downloads.api });
    let emitting = true;

    cdp.setHandlers({
      'Input.dispatchMouseEvent': () => {
        if (emitting) {
          emitting = false;
          // The user's own download in another tab: another tab id and another referrer.
          downloads.emit({ id: 77, referrer: `${MAIN_ORIGIN}/elsewhere`, tabId: TAB_ID + 1 });
          downloads.emit({ id: 78, referrer: `${MAIN_ORIGIN}/other-page` });
        }

        return {};
      },
    });

    const outcome = await runtime.runTool({
      agent: { authorized: [readGrant, actGrant] },
      arguments: { target: '#pay' },
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_click',
    });

    // Nothing was cancelled and nothing was refused: the call started no download of its own.
    expect(outcome.kind).toBe('result');
    expect([downloads.cancelled, downloads.erased]).toStrictEqual([[], []]);
  });

  it('leaves another tab\u2019s download of the navigate\u2019s destination alone', async () => {
    const downloads = createFakeDownloads();
    const { cdp, runtime } = await createHarness({ downloadsApi: downloads.api });

    cdp.setHandlers({
      'Page.navigate': () => {
        // The same attachment in the user's own tab: the url matches this navigate's destination, the tab does not.
        downloads.emit({
          finalUrl: `${MAIN_ORIGIN}/invoice.pdf`,
          id: 79,
          tabId: TAB_ID + 1,
          url: `${MAIN_ORIGIN}/invoice.pdf`,
        });

        return {};
      },
    });

    const outcome = await runtime.runTool({
      agent: { authorized: [readGrant, { class: 'navigate', origin: MAIN_ORIGIN }] },
      arguments: { url: `${MAIN_ORIGIN}/invoice.pdf` },
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_navigate',
    });

    // The url alone is not ownership: nothing of another tab's is cancelled or reported as this call's.
    expect(outcome.kind).toBe('result');
    expect([downloads.cancelled, downloads.erased]).toStrictEqual([[], []]);
  });

  it('cancels a download a tab this call opened started, and leaves the session\u2019s other tabs alone', async () => {
    const downloads = createFakeDownloads();
    const openedListeners: ((tab: {
      readonly id?: number;
      readonly openerTabId?: number;
    }) => void)[] = [];
    const tab: BrowserTabInfo = { id: TAB_ID, title: 'Example', url: `${MAIN_ORIGIN}/dashboard` };
    const tabsApi: BrowserTabsApi = {
      get: async () => tab,
      onCreated: {
        addListener: listener => {
          openedListeners.push(listener);
        },
        removeListener: listener => {
          const index = openedListeners.indexOf(listener);

          if (index !== -1) {
            openedListeners.splice(index, 1);
          }
        },
      },
      query: async () => [tab],
    };
    const { controller } = createGroups();
    const { cdp, runtime } = await createHarness({
      downloadsApi: downloads.api,
      tabGroups: controller,
      tabsApi,
    });
    // A second tab the session holds before the call: the user shared it, so its downloads are the user's.
    await runtime.shareActiveTab({ sessionHandle: 'session-1', tabId: TAB_ID + 4 });
    const opened = (id: number, openerTabId?: number): void => {
      for (const listener of openedListeners) {
        listener(openerTabId === undefined ? { id } : { id, openerTabId });
      }
    };
    let emitting = true;

    cdp.setHandlers({
      'Input.dispatchMouseEvent': () => {
        // A click is a press and a release; the browser opens the tab and names each download once.
        if (emitting) {
          emitting = false;
          // A link with a target opens a tab this call owns; the session's own tab is not this call's.
          opened(TAB_ID + 3, TAB_ID);
          downloads.emit({ id: 64, tabId: TAB_ID + 3 });
          downloads.emit({ id: 65, tabId: TAB_ID + 4 });
        }

        return {};
      },
    });

    const outcome = await runtime.runTool({
      agent: { authorized: [readGrant, actGrant] },
      arguments: { target: '#pay' },
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_click',
    });

    expect(outcome).toMatchObject({ afterAction: true, kind: 'needs_permission' });
    // Only the tab this call opened is the call's; the listener does not outlive the call either.
    expect([downloads.cancelled, openedListeners.length]).toStrictEqual([[64], 0]);
  });

  it('arms the download guard for a select-option call', async () => {
    const { cdp, runtime } = await createHarness();

    await runtime.runTool({
      agent: { authorized: [readGrant, actGrant] },
      arguments: { target: '#export', values: ['pdf'] },
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_select_option',
    });

    // The call runs with downloads denied: an export-style `change` handler is cancelled like a click.
    expect([cdp.downloadsDenied(), cdp.downloadsRestored()]).toStrictEqual([1, 1]);
  });

  it('cancels the download whose referrer is this tab\u2019s page', async () => {
    const downloads = createFakeDownloads();
    const { cdp, runtime } = await createHarness({ downloadsApi: downloads.api });
    let emitting = true;

    cdp.setHandlers({
      'Input.dispatchMouseEvent': () => {
        if (emitting) {
          emitting = false;
          downloads.emit({ id: 42, referrer: `${MAIN_ORIGIN}/dashboard` });
        }

        return {};
      },
    });

    const outcome = await runtime.runTool({
      agent: { authorized: [readGrant, actGrant] },
      arguments: { target: '#pay' },
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_click',
    });

    expect(outcome).toMatchObject({ afterAction: true, kind: 'needs_permission' });
    expect(downloads.cancelled).toStrictEqual([42]);
  });

  it('asks for approval for a download the browser created after the click returned', async () => {
    const downloads = createFakeDownloads();
    const { cdp, runtime } = await createHarness({ downloadsApi: downloads.api });
    let announcing = true;

    cdp.setHandlers({
      'Input.dispatchMouseEvent': () => {
        if (announcing) {
          announcing = false;
          // The item is created once the click's own command has returned, so the stream never names it in time.
          // By the time the guard looks for it, the small file is already complete.
          downloads.record({
            filename: '/home/me/Downloads/report.txt',
            id: 47,
            state: 'complete',
            tabId: TAB_ID,
          });
        }

        return {};
      },
    });

    const outcome = await runtime.runTool({
      agent: { authorized: [readGrant, actGrant] },
      arguments: { target: '#pay' },
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_click',
    });

    // The model must be told a download happened, and the file the browser finished before the cancel is deleted.
    expect(outcome).toMatchObject({ afterAction: true, kind: 'needs_permission' });
    expect(downloads.removed).toStrictEqual([47]);
  });

  it('deletes a download it stopped while the browser was still writing it', async () => {
    const downloads = createFakeDownloads({ cancelRejects: true });
    const { cdp, runtime } = await createHarness({ downloadsApi: downloads.api });
    let announcing = true;

    cdp.setHandlers({
      'Input.dispatchMouseEvent': () => {
        if (announcing) {
          announcing = false;
          downloads.record({
            filename: '/home/me/Downloads/slow.bin',
            id: 48,
            state: 'in_progress',
            tabId: TAB_ID,
          });
        }

        return {};
      },
    });

    const outcome = await runtime.runTool({
      agent: { authorized: [readGrant, actGrant] },
      arguments: { target: '#pay' },
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_click',
    });

    // The call reports the download and answers; the file that lands is deleted after the call, not inside it.
    expect(outcome).toMatchObject({ afterAction: true, kind: 'needs_permission' });

    await vi.waitFor(
      () => {
        expect(downloads.removed).toStrictEqual([48]);
      },
      { timeout: 4000 }
    );
  });

  it('deletes the file of a download that completed before the cancel', async () => {
    const downloads = createFakeDownloads({ cancelRejects: true });
    const { cdp, runtime } = await createHarness({ downloadsApi: downloads.api });
    let emitting = true;

    cdp.setHandlers({
      'Input.dispatchMouseEvent': () => {
        if (emitting) {
          emitting = false;
          downloads.emit({
            filename: '/home/me/Downloads/report.txt',
            id: 43,
            state: 'complete',
            tabId: TAB_ID,
          });
        }

        return {};
      },
    });

    const outcome = await runtime.runTool({
      agent: { authorized: [readGrant, actGrant] },
      arguments: { target: '#pay' },
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_click',
    });

    // `cancel` lost the race: `removeFile` deletes the file and `erase` drops the history entry; the call still reports the real stop.
    expect([downloads.removed, downloads.erased]).toStrictEqual([[43], [{ id: 43 }]]);
    expect(outcome).toMatchObject({ afterAction: true, kind: 'needs_permission' });
  });

  it('names a file it could not delete instead of claiming it was removed', async () => {
    const downloads = createFakeDownloads({ cancelRejects: true, removeRejects: true });
    const { cdp, runtime } = await createHarness({ downloadsApi: downloads.api });
    let emitting = true;

    cdp.setHandlers({
      'Input.dispatchMouseEvent': () => {
        if (emitting) {
          emitting = false;
          // The file finished before the cancel and the browser refuses to delete it, so the guard has to admit it.
          downloads.emit({
            filename: '/home/me/Downloads/report.txt',
            id: 44,
            state: 'complete',
            tabId: TAB_ID,
          });
        }

        return {};
      },
    });

    const outcome = await runtime.runTool({
      agent: { authorized: [readGrant, actGrant] },
      arguments: { target: '#pay' },
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_click',
    });

    // The call is still refused as a sensitive step, and the refusal names the file the browser kept.
    expect(outcome).toMatchObject({ afterAction: true, kind: 'needs_permission' });
    const message =
      outcome.kind === 'needs_permission' && !outcome.result.ok ? outcome.result.error : '';
    expect(message).toContain('report.txt');
    expect(message).not.toContain('Nothing was changed');
    expect(downloads.removed).toStrictEqual([]);
  });

  it('deletes a file whose cancel resolved but whose item finished first', async () => {
    const downloads = createFakeDownloads();
    const { cdp, runtime } = await createHarness({ downloadsApi: downloads.api });
    let emitting = true;

    cdp.setHandlers({
      'Input.dispatchMouseEvent': () => {
        if (emitting) {
          emitting = false;
          // `cancel` resolves for an item that already completed; only its terminal state proves a file exists.
          downloads.emit({
            filename: '/home/me/Downloads/report.txt',
            id: 46,
            state: 'complete',
            tabId: TAB_ID,
          });
        }

        return {};
      },
    });

    const outcome = await runtime.runTool({
      agent: { authorized: [readGrant, actGrant] },
      arguments: { target: '#pay' },
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_click',
    });

    expect([downloads.cancelled, downloads.removed, downloads.erased]).toStrictEqual([
      [46],
      [46],
      [{ id: 46 }],
    ]);
    expect(outcome).toMatchObject({ afterAction: true, kind: 'needs_permission' });
  });

  it('returns without a settle window and still deletes a download that starts late', async () => {
    const downloads = createFakeDownloads();
    const { cdp, runtime } = await createHarness({ downloadsApi: downloads.api });

    cdp.setHandlers({ 'Input.dispatchMouseEvent': () => ({}) });

    const outcome = await runtime.runTool({
      agent: { authorized: [readGrant, actGrant] },
      arguments: { target: '#pay' },
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_click',
    });

    // The click started nothing, so the call pays no wait; the guard stays armed briefly for a late item.
    expect([outcome.kind, downloads.live()]).toStrictEqual(['result', 1]);

    downloads.emit({ id: 71, tabId: TAB_ID });

    await vi.waitFor(() => {
      expect(downloads.cancelled).toStrictEqual([71]);
    });
  });

  it('keeps the file of an approved repeat that starts inside an earlier call\u2019s linger', async () => {
    const downloads = createFakeDownloads();
    const { cdp, runtime } = await createHarness({ downloadsApi: downloads.api });
    const pending: { id: number | undefined } = { id: undefined };

    cdp.setHandlers({
      'Input.dispatchMouseEvent': () => {
        // A click is a press and a release; the browser names the download once, while the command is in flight.
        if (pending.id !== undefined) {
          downloads.emit({
            filename: '/home/me/Downloads/report.txt',
            id: pending.id,
            tabId: TAB_ID,
          });
          pending.id = undefined;
        }

        return {};
      },
    });

    const click = (sensitive: readonly string[] = []) =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant], sensitive: [...sensitive] },
        arguments: { target: '#pay' },
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_click',
      });

    // A guarded click that starts nothing leaves its listener armed for a late download.
    await click();
    expect(downloads.live()).toBe(1);

    // The next call starts inside that window, and its own guard refuses the download it started.
    pending.id = 72;
    const refused = await click();

    expect(refused).toMatchObject({ afterAction: true, kind: 'needs_permission' });

    // The approved repeat starts inside the earlier call's window too: its file must be nobody's to cancel.
    pending.id = 73;
    const approved = await click([expectStepToken(refused)]);

    expect(approved.kind).toBe('result');
    // Only the refused call's file was cancelled, and no file was deleted: one file remains, the approved one.
    expect([downloads.cancelled, downloads.removed]).toStrictEqual([[72], []]);
  });

  it('reports a download the tab announced after the click’s own command returned', async () => {
    const downloads = createFakeDownloads();
    const { cdp, runtime } = await createHarness({ downloadsApi: downloads.api });
    const announcing: { pending: boolean } = { pending: true };

    cdp.setHandlers({
      'Input.dispatchMouseEvent': () => {
        if (announcing.pending) {
          announcing.pending = false;
          // The tab names the download a moment after the click's own command returned, before the item exists.
          cdp.emit('Browser.downloadWillBegin', {
            guid: 'download-77',
            suggestedFilename: 'report.txt',
            url: `${MAIN_ORIGIN}/report.txt`,
          });
        }

        return {};
      },
    });

    const outcome = await runtime.runTool({
      agent: { authorized: [readGrant, actGrant] },
      arguments: { target: '#pay' },
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_click',
    });

    // The call reports what it caused even though the item itself is created after it answered.
    expect(outcome).toMatchObject({ afterAction: true, kind: 'needs_permission' });
    expect(downloads.cancelled).toStrictEqual([]);

    downloads.emit({ id: 77, tabId: TAB_ID });

    // The listener it left behind deletes the file that lands, so nothing is kept unapproved.
    await vi.waitFor(() => {
      expect(downloads.cancelled).toStrictEqual([77]);
    });
  });

  it('still deletes a late file that lands after the call, when no later call interrupts', async () => {
    // `cancel` is too late for an item the browser already finished, so only a deleted file proves the guard acted.
    const downloads = createFakeDownloads({ cancelRejects: true });
    const { cdp, runtime } = await createHarness({ downloadsApi: downloads.api });

    cdp.setHandlers({ 'Input.dispatchMouseEvent': () => ({}) });

    const outcome = await runtime.runTool({
      agent: { authorized: [readGrant, actGrant] },
      arguments: { target: '#pay' },
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_click',
    });

    expect([outcome.kind, downloads.live()]).toStrictEqual(['result', 1]);

    downloads.emit({
      filename: '/home/me/Downloads/late.bin',
      id: 75,
      state: 'complete',
      tabId: TAB_ID,
    });

    await vi.waitFor(() => {
      expect(downloads.removed).toStrictEqual([75]);
    });
  });

  it('leaves an earlier call\u2019s linger on duty when a read starts, and reports the download it stops', async () => {
    const downloads = createFakeDownloads();
    const { cdp, runtime } = await createHarness({ downloadsApi: downloads.api });

    cdp.setHandlers({ 'Input.dispatchMouseEvent': () => ({}) });

    const click = () =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant] },
        arguments: { target: '#pay' },
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_click',
      });
    const shot = () =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant] },
        arguments: {},
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_take_screenshot',
      });

    await click();

    const first = await shot();

    // A read arms no guard of its own, and it must not drop the earlier one's duty either: the listener still
    // Runs, so a download the click started that lands late is still deleted.
    expect(first.kind).toBe('result');
    expect(downloads.live()).toBe(1);

    // The download the click started lands after the read answered: the linger cancels it, and the next call on
    // The tab tells the model rather than letting a deleted file vanish silently.
    downloads.emit({ id: 76, tabId: TAB_ID });

    await vi.waitFor(() => {
      expect(downloads.cancelled).toStrictEqual([76]);
    });

    const reported = await shot();

    // The next call reports the download the linger stopped, so the model can approve it with a step token.
    expect(reported).toMatchObject({
      afterAction: true,
      kind: 'needs_permission',
      stepToken: expectStepToken(reported),
    });
  });

  /**
   * Runs one call while the fake clock advances: every window a guard keeps is a
   * timer, so a call that waits on one only settles after the clock moves.
   */
  const runTimed = async (
    call: Promise<BrowserToolRunOutcome>,
    ms = 300
  ): Promise<BrowserToolRunOutcome> => {
    await vi.advanceTimersByTimeAsync(ms);

    return call;
  };

  it('reports a download that lands after the click on the very next call, whatever tool it is', async () => {
    const downloads = createFakeDownloads();
    const { cdp, runtime } = await createHarness({ downloadsApi: downloads.api });

    // The fixture's attachment response is delayed: the browser creates the item after the click has answered.
    cdp.setHandlers({ 'Input.dispatchMouseEvent': () => ({}) });

    const click = () =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant] },
        arguments: { target: '#pay' },
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_click',
      });
    const shot = () =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant] },
        arguments: {},
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_take_screenshot',
      });

    vi.useFakeTimers();

    try {
      const clicked = await runTimed(click());

      // The click started nothing it could see: it answers plainly and leaves the linger on duty.
      expect(clicked.kind).toBe('result');

      // 1.5 s later the response arrives and the browser creates the download, inside the linger's window.
      await vi.advanceTimersByTimeAsync(1500);
      downloads.emit({ filename: '/home/me/Downloads/report.txt', id: 91, tabId: TAB_ID });
      await vi.advanceTimersByTimeAsync(0);
      expect(downloads.cancelled).toStrictEqual([91]);

      // The very next call reports it, whatever tool it is, and does not run: the report is its answer.
      await vi.advanceTimersByTimeAsync(900);
      const before = cdp.commands().length;
      const reported = await runTimed(shot());

      expect(reported).toMatchObject({
        afterAction: true,
        items: [{ class: 'sensitive', origin: MAIN_ORIGIN, reason: SENSITIVE_REASON.download }],
        kind: 'needs_permission',
        result: {
          error:
            "The click on '#pay' started a download of report.txt, which was stopped: downloading a file needs your approval. Repeat that click after the download is approved to receive the file.",
          ok: false,
        },
      });
      // A refusal without a token leaves the human nothing to approve: this throws when it has none.
      expectStepToken(reported);
      // The read never reached the page: an unanswered download is the whole answer.
      expect(cdp.commands()).toHaveLength(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('binds a late download\u2019s token to the click that started it, not to the call that reported it', async () => {
    const downloads = createFakeDownloads();
    const { cdp, runtime } = await createHarness({ downloadsApi: downloads.api });
    /** The replayed click's own download, created while its command runs. */
    let inCall: number | null = null;

    cdp.setHandlers({
      'Input.dispatchMouseEvent': () => {
        if (inCall !== null) {
          const id = inCall;

          inCall = null;
          downloads.emit({ id, tabId: TAB_ID });
        }

        return {};
      },
    });

    const click = (sensitive: readonly string[] = []) =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant], sensitive: [...sensitive] },
        arguments: { target: '#pay' },
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_click',
      });
    const shot = () =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant] },
        arguments: {},
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_take_screenshot',
      });

    vi.useFakeTimers();

    try {
      await runTimed(click());
      await vi.advanceTimersByTimeAsync(1500);
      downloads.emit({ id: 92, tabId: TAB_ID });
      await vi.advanceTimersByTimeAsync(900);

      const reported = await runTimed(shot());
      const stepToken = expectStepToken(reported);

      // Repeating the click — the step the report named — runs unguarded: the token is bound to it.
      const approved = await runTimed(click([stepToken]));

      // The guard never denied downloads on the repeat, so the token really bought this one unguarded run.
      expect([approved.kind, cdp.downloadsDenied(), downloads.cancelled]).toStrictEqual([
        'result',
        1,
        [92],
      ]);

      // The token was burned, so the identical click again is guarded: its own download is cancelled.
      inCall = 94;

      const again = await runTimed(click([stepToken]));

      expect(again).toMatchObject({ afterAction: true, kind: 'needs_permission' });
      expect(downloads.cancelled).toStrictEqual([92, 94]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the file an approved click starts after it answered, and guards the next identical call', async () => {
    const downloads = createFakeDownloads();
    const { cdp, runtime } = await createHarness({ downloadsApi: downloads.api });
    /** The next click's own download, created while its command runs. */
    let inCall: number | null = null;

    cdp.setHandlers({
      'Input.dispatchMouseEvent': () => {
        if (inCall !== null) {
          const id = inCall;

          inCall = null;
          downloads.emit({ id, startTime: new Date(Date.now()).toISOString(), tabId: TAB_ID });
        }

        return {};
      },
    });

    const click = (sensitive: readonly string[] = []) =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant], sensitive: [...sensitive] },
        arguments: { target: '#pay' },
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_click',
      });

    vi.useFakeTimers();

    try {
      // 1. A guarded click starts a download that only arrives 1.5 s after the call answered.
      await runTimed(click());
      await vi.advanceTimersByTimeAsync(1500);
      downloads.emit({ id: 101, tabId: TAB_ID });
      await vi.advanceTimersByTimeAsync(100);

      // 2. The next call reports it, and its token is bound to the click.
      const reported = await runTimed(click([]));
      const stepToken = expectStepToken(reported);

      expect(reported).toMatchObject({ afterAction: true, kind: 'needs_permission' });

      // 3. The approved repeat keeps the file it starts late: it answers, the file lands in the late window.
      const approved = await runTimed(click([stepToken]));

      expect(approved.kind).toBe('result');

      await vi.advanceTimersByTimeAsync(1400);
      downloads.emit({ id: 102, startTime: new Date(Date.now()).toISOString(), tabId: TAB_ID });
      await vi.advanceTimersByTimeAsync(0);

      // The approved repeat ran unguarded and its late file was never cancelled or deleted: exactly one is kept.
      expect([cdp.downloadsDenied(), downloads.cancelled, downloads.removed]).toStrictEqual([
        1,
        [101],
        [],
      ]);

      // 4. The identical call again, with the burned token, is guarded: its own download is cancelled.
      inCall = 103;

      const reguarded = await runTimed(click([stepToken]));

      expect(reguarded).toMatchObject({ afterAction: true, kind: 'needs_permission' });
      expect(downloads.cancelled).toStrictEqual([101, 103]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('guards a late download’s approved repeat, keeping its one file and reporting a second', async () => {
    const downloads = createFakeDownloads();
    const { cdp, runtime } = await createHarness({ downloadsApi: downloads.api });
    const invoice = `${MAIN_ORIGIN}/invoice.pdf`;
    /** How many times the button was really pressed: the reporting call never runs the tool. */
    let presses = 0;
    let events = 0;

    cdp.setHandlers({
      'Input.dispatchMouseEvent': () => {
        // A click is a press and a release; counting presses keeps the mapping independent of that pair.
        const press = events % 2 === 0;

        events += 1;

        if (press) {
          presses += 1;
        }

        // The second real press is the approved repeat: its page starts the file the human approved plus a second.
        // The approved file's url is regenerated with a fresh query, as a page that counts its clicks does.
        if (press && presses === 2) {
          downloads.emit({ id: 102, tabId: TAB_ID, url: `${invoice}?click=2` });
          downloads.emit({ id: 103, tabId: TAB_ID, url: `${MAIN_ORIGIN}/statement.pdf` });
        }

        return {};
      },
    });

    const click = (sensitive: readonly string[] = []) =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant], sensitive: [...sensitive] },
        arguments: { target: '#pay' },
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_click',
      });

    vi.useFakeTimers();

    try {
      // 1. A guarded click answers, and its download only arrives 1.5 s later: the linger stops it.
      await runTimed(click());
      await vi.advanceTimersByTimeAsync(1500);
      downloads.emit({ id: 101, tabId: TAB_ID, url: invoice });
      await vi.advanceTimersByTimeAsync(100);
      expect(downloads.cancelled).toStrictEqual([101]);

      // 2. The next call reports it and runs nothing: its token names the file the approval buys.
      const dispatchesBeforeReport = cdp
        .commands()
        .filter(method => method === 'Input.dispatchMouseEvent').length;
      const reported = await runTimed(click());
      const stepToken = expectStepToken(reported);

      expect(reported).toMatchObject({ afterAction: true, kind: 'needs_permission' });
      // The reporting call is not a second click: the button was pressed once so far, and this call pressed it never.
      expect(presses).toBe(1);
      expect(cdp.commands().filter(method => method === 'Input.dispatchMouseEvent')).toHaveLength(
        dispatchesBeforeReport
      );

      // 3. The approved repeat runs guarded and is the call that presses the button: only the second file is
      // Stopped, so exactly one file is kept and the second is reported on this very call.
      const approved = await runTimed(click([stepToken]));

      if (approved.kind !== 'needs_permission') {
        throw new Error(`expected the second file to be reported, got ${JSON.stringify(approved)}`);
      }

      // Two presses, one stop of the approved file (102 is untouched), nothing deleted, and a refusal that says the
      // Earlier call's step is what to repeat.
      expect({
        afterAction: approved.afterAction,
        cancelled: downloads.cancelled,
        presses,
        removed: downloads.removed,
      }).toStrictEqual({
        afterAction: true,
        cancelled: [101, 103],
        presses: 2,
        removed: [],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('queues a download at its announcement, so the very next call reports it before the item exists', async () => {
    const downloads = createFakeDownloads();
    const { cdp, runtime } = await createHarness({ downloadsApi: downloads.api });

    // The click starts nothing it can see; the tab announces the download a second and a half later, and the item
    // Exists only after that.
    cdp.setHandlers({ 'Input.dispatchMouseEvent': () => ({}) });

    vi.useFakeTimers();

    try {
      await runTimed(
        runtime.runTool({
          agent: { authorized: [readGrant, actGrant] },
          arguments: { target: '#pay' },
          caller: agent(),
          tabId: TAB_ID,
          toolName: 'browser_click',
        })
      );

      await vi.advanceTimersByTimeAsync(1500);
      cdp.emit('Browser.downloadWillBegin', {
        guid: 'download-late',
        suggestedFilename: 'report.txt',
        url: `${MAIN_ORIGIN}/report.txt`,
      });
      await vi.advanceTimersByTimeAsync(0);

      // A call in between answers without waiting: the announcement alone already names the step and the file, so it
      // Needs no clock. Advancing the default 300 ms here would pass the linger's own 2 s window, and the item below
      // Would land with no guard on duty.
      const reported = await runTimed(
        runtime.runTool({
          agent: { authorized: [readGrant, actGrant] },
          arguments: {},
          caller: agent(),
          tabId: TAB_ID,
          toolName: 'browser_snapshot',
        }),
        0
      );

      expect(reported).toMatchObject({
        afterAction: true,
        kind: 'needs_permission',
        result: {
          error:
            "The click on '#pay' started a download of report.txt, which was stopped: downloading a file needs your approval. Repeat that click after the download is approved to receive the file.",
          ok: false,
        },
        stepToken: expectStepToken(reported),
      });

      // The item the announcement promised appears later, and the guard stops it: the file is never kept.
      downloads.emit({ id: 121, tabId: TAB_ID, url: `${MAIN_ORIGIN}/report.txt` });
      await vi.advanceTimersByTimeAsync(0);

      expect([downloads.cancelled, downloads.removed]).toStrictEqual([[121], []]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a late file it could not delete as kept, not as stopped', async () => {
    const downloads = createFakeDownloads({ cancelRejects: true, removeRejects: true });
    const { cdp, runtime } = await createHarness({ downloadsApi: downloads.api });

    cdp.setHandlers({ 'Input.dispatchMouseEvent': () => ({}) });

    const click = () =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant] },
        arguments: { target: '#pay' },
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_click',
      });
    const shot = () =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant] },
        arguments: {},
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_take_screenshot',
      });

    vi.useFakeTimers();

    try {
      await runTimed(click());

      // The file lands inside the guard's window, but the browser had already written it and will not delete it: the
      // Report must repeat that outcome instead of claiming the file was stopped and deleted.
      await vi.advanceTimersByTimeAsync(1500);
      downloads.emit({
        filename: '/home/me/Downloads/late.bin',
        id: 81,
        state: 'complete',
        tabId: TAB_ID,
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(900);

      const reported = await runTimed(shot(), 0);

      expect(reported).toMatchObject({
        afterAction: true,
        kind: 'needs_permission',
        result: {
          error:
            "The click on '#pay' started a download of late.bin, which was stopped: downloading a file needs your approval. Repeat that click after the download is approved to receive the file. The browser had already saved late.bin before the download could be stopped.",
          ok: false,
        },
      });
      expectStepToken(reported);
      // Only a delete that never happened leaves the file: the report names it instead of hiding it.
      expect(downloads.removed).toStrictEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves an earlier linger\u2019s announcement to the step that started it, and reports it once', async () => {
    const downloads = createFakeDownloads();
    const { cdp, runtime } = await createHarness({ downloadsApi: downloads.api });

    cdp.setHandlers({ 'Input.dispatchMouseEvent': () => ({}) });

    const click = (target: string) =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant] },
        arguments: { target },
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_click',
      });
    const shot = () =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant] },
        arguments: {},
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_take_screenshot',
      });

    vi.useFakeTimers();

    try {
      await runTimed(click('#pay'));

      // The tab names a download after that call answered, while the guard it left behind is still watching.
      await vi.advanceTimersByTimeAsync(1500);
      cdp.emit('Browser.downloadWillBegin', {
        guid: 'late-1',
        suggestedFilename: 'late.txt',
        url: `${MAIN_ORIGIN}/late.txt`,
      });
      await vi.advanceTimersByTimeAsync(0);

      // The next guarded call started nothing of its own: it reports the earlier download and names that click, so
      // The repeat it asks for is the one the model already ran and not itself. It answers without advancing the
      // Clock past the guard's window, which is still what stops the file that lands next.
      const reported = await runTimed(click('#other'), 0);

      expect(reported).toMatchObject({ afterAction: true, kind: 'needs_permission' });

      if (reported.kind !== 'needs_permission') {
        throw new Error(`expected a refusal, got ${reported.kind}`);
      }

      expect(reported.result.ok ? '' : reported.result.error).toContain(
        "The click on '#pay' started a download of late.txt"
      );
      expectStepToken(reported);
      // Its own download never happened: the call refused before it ran.
      expect(downloads.cancelled).toStrictEqual([]);

      // The item the announcement promised lands later and is stopped exactly once; the call after is plain, so the
      // File was not named a second time.
      downloads.emit({ id: 131, tabId: TAB_ID, url: `${MAIN_ORIGIN}/late.txt` });
      await vi.advanceTimersByTimeAsync(0);

      expect(downloads.cancelled).toStrictEqual([131]);

      const plain = await runTimed(shot(), 400);

      expect(plain.kind).toBe('result');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a searched item on the record it already reported, without naming the file a second time', async () => {
    const downloads = createFakeDownloads();
    const { cdp, runtime } = await createHarness({ downloadsApi: downloads.api });

    cdp.setHandlers({ 'Input.dispatchMouseEvent': () => ({}) });

    const click = () =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant] },
        arguments: { target: '#pay' },
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_click',
      });
    const shot = () =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant] },
        arguments: {},
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_take_screenshot',
      });

    vi.useFakeTimers();

    try {
      await runTimed(click());
      await vi.advanceTimersByTimeAsync(1500);
      // The tab names a download after that call answered: its record is open, and no file exists yet.
      cdp.emit('Browser.downloadWillBegin', {
        guid: 'already-named',
        suggestedFilename: 'late.txt',
        url: `${MAIN_ORIGIN}/late.txt`,
      });
      await vi.advanceTimersByTimeAsync(0);

      // The next call reports that announcement: from here the file is the model's, and no later call may name it.
      const reported = await runTimed(click(), 0);

      expect(reported.kind).toBe('needs_permission');

      // The browser creates the item, and only the search finds it: it links to the record that was already reported,
      // Whose settlement must leave that record reported rather than turning it back into a second refusal.
      downloads.record({ id: 141, tabId: TAB_ID, url: `${MAIN_ORIGIN}/late.txt` });

      const plain = await runTimed(shot(), 0);

      expect([plain.kind, downloads.cancelled]).toStrictEqual(['result', [141]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an agent\u2019s late download for its own session when the panel reads the tab', async () => {
    const downloads = createFakeDownloads();
    const { cdp, runtime } = await createHarness({ downloadsApi: downloads.api });

    cdp.setHandlers({ 'Input.dispatchMouseEvent': () => ({}) });

    const shot = () =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant] },
        arguments: {},
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_take_screenshot',
      });

    vi.useFakeTimers();

    try {
      await runTimed(
        runtime.runTool({
          agent: { authorized: [readGrant, actGrant] },
          arguments: { target: '#pay' },
          caller: agent(),
          tabId: TAB_ID,
          toolName: 'browser_click',
        })
      );
      runtime.releaseTab({ caller: agent(), tabId: TAB_ID });
      cdp.emit('Browser.downloadWillBegin', {
        guid: 'late-panel',
        suggestedFilename: 'late.txt',
        url: `${MAIN_ORIGIN}/late.txt`,
      });
      await vi.advanceTimersByTimeAsync(0);

      // A read from the panel can start nothing, so it must neither end the guard nor take the model's report.
      const panelRead = await runTimed(
        runtime.runTool({
          arguments: {},
          caller: panel(),
          tabId: TAB_ID,
          takeOver: true,
          toolName: 'browser_snapshot',
        }),
        0
      );

      expect(panelRead.kind).toBe('result');
      runtime.releaseTab({ caller: panel(), tabId: TAB_ID });

      // The file the click started lands after the panel read: the guard the panel left alone still stops it.
      downloads.emit({ id: 141, tabId: TAB_ID, url: `${MAIN_ORIGIN}/late.txt` });
      await vi.advanceTimersByTimeAsync(0);

      expect(downloads.cancelled).toStrictEqual([141]);

      // The session's first call after the take-over re-reads the page; the report waits for the call after it.
      await expect(runTimed(shot(), 0)).resolves.toStrictEqual({
        kind: 'result',
        result: { error: TAB_TAKEN_ERROR, ok: false },
      });

      const reported = await runTimed(shot(), 0);

      expect(reported).toMatchObject({
        afterAction: true,
        kind: 'needs_permission',
        result: { ok: false },
      });
      expectStepToken(reported);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says a stopped download needs approval instead of claiming it already had one', async () => {
    const downloads = createFakeDownloads();
    const { cdp, runtime } = await createHarness({ downloadsApi: downloads.api });

    cdp.setHandlers({ 'Input.dispatchMouseEvent': () => ({}) });

    vi.useFakeTimers();

    try {
      await runTimed(
        runtime.runTool({
          agent: { authorized: [readGrant, actGrant] },
          arguments: { target: '#pay' },
          caller: agent(),
          tabId: TAB_ID,
          toolName: 'browser_click',
        })
      );
      await vi.advanceTimersByTimeAsync(1500);
      cdp.emit('Browser.downloadWillBegin', {
        guid: 'late-words',
        suggestedFilename: 'late.txt',
        url: `${MAIN_ORIGIN}/late.txt`,
      });
      await vi.advanceTimersByTimeAsync(0);

      const reported = await runTimed(
        runtime.runTool({
          agent: { authorized: [readGrant, actGrant] },
          arguments: {},
          caller: agent(),
          tabId: TAB_ID,
          toolName: 'browser_snapshot',
        }),
        0
      );

      if (reported.kind !== 'needs_permission') {
        throw new Error(`expected a refusal, got ${reported.kind}`);
      }

      const message = reported.result.ok ? '' : reported.result.error;

      // The stop happened before any approval: the text must say so, because the CLI prints "Approved." only after
      // The human grants, and a contradiction there would tell the model the download was already approved.
      expect(message).toContain('which was stopped: downloading a file needs your approval.');
      expect(message).toContain(
        'Repeat that click after the download is approved to receive the file.'
      );
      expect(message).not.toContain('Approved.');
    } finally {
      vi.useRealTimers();
    }
  });

  it('binds a late refusal to the click that started the file, not the call carrying it', async () => {
    const downloads = createFakeDownloads();
    const { cdp, runtime } = await createHarness({ downloadsApi: downloads.api });

    cdp.setHandlers({ 'Input.dispatchMouseEvent': () => ({}) });

    vi.useFakeTimers();

    try {
      await runTimed(
        runtime.runTool({
          agent: { authorized: [readGrant, actGrant] },
          arguments: { target: '#pay' },
          caller: agent(),
          tabId: TAB_ID,
          toolName: 'browser_click',
        })
      );
      await vi.advanceTimersByTimeAsync(1500);
      cdp.emit('Browser.downloadWillBegin', {
        guid: 'late-step',
        suggestedFilename: 'late.txt',
        url: `${MAIN_ORIGIN}/late.txt`,
      });
      await vi.advanceTimersByTimeAsync(0);

      // A read carries the news. The CLI stores a step token under the call it read it from, so the need has to
      // Name the click itself, or the repeated click would be refused for a token it never bound.
      const reported = await runTimed(
        runtime.runTool({
          agent: { authorized: [readGrant, actGrant] },
          arguments: {},
          caller: agent(),
          tabId: TAB_ID,
          toolName: 'browser_snapshot',
        }),
        0
      );

      if (reported.kind !== 'needs_permission') {
        throw new Error(`expected a refusal, got ${reported.kind}`);
      }

      expect(reported.step).toStrictEqual({
        argumentsHash: hashBrowserToolArguments({ target: '#pay' }),
        tool: 'browser_click',
      });
      // Never the carrying call's own name: a token bound to it approves a step that started nothing.
      expect(reported.step?.argumentsHash).not.toBe(hashBrowserToolArguments({}));
    } finally {
      vi.useRealTimers();
    }
  });

  it('names browser_tabs new as the step, and its approved repeat navigates the tab it opened', async () => {
    const downloads = createFakeDownloads();
    const created: Record<string, unknown>[] = [];
    const openedListeners: ((tab: {
      readonly id?: number;
      readonly openerTabId?: number;
    }) => void)[] = [];
    const newTab = TAB_ID + 6;
    let navigating = true;
    // The file the approved repeat keeps, as the browser reports it once it is written.
    downloads.searched.push({ filename: '/home/me/Downloads/report.txt', id: 72 });

    const tabsApi = {
      create: async (properties: { readonly url?: string } = {}) => {
        created.push({ ...properties });

        // The browser opens the tab, so the call owns it.
        for (const listener of openedListeners) {
          listener({ id: newTab, openerTabId: TAB_ID });
        }

        return { id: newTab, title: '', url: properties.url ?? 'about:blank', windowId: 1 };
      },
      get: async (tabId: number) =>
        tabId === newTab
          ? { id: newTab, title: '', url: `${MAIN_ORIGIN}/report.txt`, windowId: 1 }
          : { id: TAB_ID, title: 'Example', url: MAIN_ORIGIN },
      onCreated: {
        addListener: (
          listener: (tab: { readonly id?: number; readonly openerTabId?: number }) => void
        ) => {
          openedListeners.push(listener);
        },
        removeListener: (
          listener: (tab: { readonly id?: number; readonly openerTabId?: number }) => void
        ) => {
          const index = openedListeners.indexOf(listener);

          if (index !== -1) {
            openedListeners.splice(index, 1);
          }
        },
      },
      query: async () => [
        { active: true, id: TAB_ID, title: 'Example', url: MAIN_ORIGIN, windowId: 1 },
      ],
    };
    const { controller } = createGroups();
    const { cdp, runtime } = await createHarness({
      downloadsApi: downloads.api,
      tabGroups: controller,
      tabsApi,
    });

    // The navigate answers with an aborted load, and the guarded one names the download it started.
    cdp.setHandlers({
      'Page.navigate': () => {
        if (navigating) {
          navigating = false;
          downloads.emit({ id: 71, tabId: newTab });
        }

        return { errorText: 'net::ERR_ABORTED' };
      },
    });

    const url = `${MAIN_ORIGIN}/report.txt`;
    const openTab = (sensitive: readonly string[]) =>
      runtime.runTool({
        agent: {
          authorized: [readGrant, actGrant, { class: 'navigate', origin: MAIN_ORIGIN }],
          sensitive: [...sensitive],
        },
        arguments: { action: 'new', url },
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_tabs',
      });

    const guarded = await openTab([]);

    if (guarded.kind !== 'needs_permission') {
      throw new Error(`expected a refusal, got ${JSON.stringify(guarded)}`);
    }

    // The token binds the call the model made, and the tab never opens at the destination.
    expect(guarded.step).toStrictEqual({
      argumentsHash: hashBrowserToolArguments({ action: 'new', url }),
      tool: 'browser_tabs',
    });
    expect([created.length, created[0]?.['url'], downloads.cancelled]).toStrictEqual([
      1,
      'about:blank',
      [71],
    ]);

    const approved = await openTab([expectStepToken(guarded)]);

    // The approved repeat navigates the tab the refused step opened — that tab, at that url — not the caller's.
    // The last navigate is the repeat's: the guarded call's own navigate came first.
    expect(cdp.sent().findLast(command => command.method === 'Page.navigate')).toStrictEqual({
      method: 'Page.navigate',
      params: { url },
      tabId: newTab,
      url,
    });
    // No second tab, and the kept file is the result.
    expect([created.length, downloads.cancelled]).toStrictEqual([1, [71]]);
    expect(
      approved.kind === 'result' && approved.result.ok ? String(approved.result.value) : ''
    ).toContain('report.txt: The file was downloaded; the page did not change.');
  });

  it('leaves a later download of the same url alone when the record for it is stale', async () => {
    const downloads = createFakeDownloads();
    const { cdp, runtime } = await createHarness({ downloadsApi: downloads.api });

    cdp.setHandlers({ 'Input.dispatchMouseEvent': () => ({}) });

    const click = () =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant] },
        arguments: { target: '#pay' },
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_click',
      });
    const shot = () =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant] },
        arguments: {},
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_take_screenshot',
      });

    vi.useFakeTimers();

    try {
      // The click leaves an announcement behind, which the next call reports: the record keeps its url.
      await runTimed(click());
      await vi.advanceTimersByTimeAsync(1500);
      cdp.emit('Browser.downloadWillBegin', {
        guid: 'stale',
        suggestedFilename: 'same.bin',
        url: `${MAIN_ORIGIN}/same.bin`,
      });
      await vi.advanceTimersByTimeAsync(0);

      const carried = await runTimed(shot(), 0);

      expect(carried.kind).toBe('needs_permission');

      // Long after that window an approved repeat downloads the same url again and the browser writes a file.
      await vi.advanceTimersByTimeAsync(10_000);
      downloads.record({
        id: 161,
        startTime: new Date(Date.now()).toISOString(),
        tabId: TAB_ID,
        url: `${MAIN_ORIGIN}/same.bin`,
      });

      const after = await runTimed(shot(), 400);

      // The stale record speaks only for its own window: the approved file stays where the human kept it.
      expect(after.kind).toBe('result');
      expect([downloads.cancelled, downloads.removed]).toStrictEqual([[], []]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the file an approved call started alone, under an older record for the same url', async () => {
    const downloads = createFakeDownloads();
    const { cdp, runtime } = await createHarness({ downloadsApi: downloads.api });

    cdp.setHandlers({ 'Input.dispatchMouseEvent': () => ({}) });

    const click = (sensitive: readonly string[]) =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant], sensitive: [...sensitive] },
        arguments: { target: '#pay' },
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_click',
      });
    const shot = () =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant] },
        arguments: {},
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_take_screenshot',
      });

    vi.useFakeTimers();

    try {
      // The guarded click leaves an announcement record behind, reported by the very next call.
      await runTimed(click([]));
      await vi.advanceTimersByTimeAsync(1500);
      cdp.emit('Browser.downloadWillBegin', {
        guid: 'approved',
        suggestedFilename: 'same.bin',
        url: `${MAIN_ORIGIN}/same.bin`,
      });
      await vi.advanceTimersByTimeAsync(0);

      const carried = await runTimed(shot(), 0);

      // The approved repeat runs with its downloads approved, and the browser writes the file it was for.
      await runTimed(click([expectStepToken(carried)]));
      downloads.record({
        id: 170,
        startTime: new Date(Date.now()).toISOString(),
        tabId: TAB_ID,
        url: `${MAIN_ORIGIN}/same.bin`,
      });

      const after = await runTimed(shot(), 400);

      // The approval is the file's owner: the older record may not delete it or report it as stopped.
      expect([after.kind, downloads.cancelled, downloads.removed]).toStrictEqual([
        'result',
        [],
        [],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops a late download the search finds without a tab, by the page that started it', async () => {
    const downloads = createFakeDownloads();
    const { cdp, runtime } = await createHarness({ downloadsApi: downloads.api });

    cdp.setHandlers({ 'Input.dispatchMouseEvent': () => ({}) });

    const click = () =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant] },
        arguments: { target: '#pay' },
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_click',
      });
    const shot = () =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant] },
        arguments: {},
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_take_screenshot',
      });

    vi.useFakeTimers();

    try {
      // The click stops nothing and leaves its window open on the tab whose page is the guard's.
      await runTimed(click());
      await vi.advanceTimersByTimeAsync(1500);
      // The browser reports the file without a tab: only the referrer ties it to this call's page.
      downloads.record({
        id: 91,
        // The guard tab's page, as the tab reported it when the guard armed.
        referrer: `${MAIN_ORIGIN}/dashboard`,
        startTime: new Date(Date.now()).toISOString(),
        url: `${MAIN_ORIGIN}/late.bin`,
      });

      const reported = await runTimed(shot(), 400);

      expect(reported.kind).toBe('needs_permission');
      expect(downloads.cancelled).toStrictEqual([91]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops a tab-less download on the tab that owns it when an earlier matching tab does not', async () => {
    const downloads = createFakeDownloads();
    // Both tabs sit on the same page, so the item's referrer matches both and only the second one holds it.
    const secondTab = TAB_ID + 14;
    const tabAt = (id: number) => ({
      id,
      title: 'Example',
      url: `${MAIN_ORIGIN}/report.txt`,
      windowId: 1,
    });
    const tabsApi: BrowserTabsApi = {
      get: async (id: number) => tabAt(id),
      query: async () => [tabAt(TAB_ID), tabAt(secondTab)],
    };
    const { controller } = createGroups();
    const { cdp, runtime } = await createHarness({
      downloadsApi: downloads.api,
      share: false,
      tabGroups: controller,
      tabsApi,
    });

    await runtime.openSession({
      controllerId: 'controller-1',
      sessionHandle: 'session-1',
      title: 'Work',
    });
    await runtime.shareActiveTab({ sessionHandle: 'session-1', tabId: TAB_ID });
    await runtime.shareActiveTab({ sessionHandle: 'session-1', tabId: secondTab });

    let clicks = 0;
    cdp.setHandlers({
      'Input.dispatchMouseEvent': () => {
        clicks += 1;

        if (clicks === 1) {
          // The first tab announces a file the browser never creates, and stops another: a record, and no watch.
          cdp.emit('Browser.downloadWillBegin', {
            guid: 'first',
            suggestedFilename: 'announced.bin',
            url: `${MAIN_ORIGIN}/announced.bin`,
          });
          downloads.emit({ id: 81, tabId: TAB_ID, url: `${MAIN_ORIGIN}/one.bin` });
        }

        return {};
      },
    });

    const click = (tabId: number, target: string) =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant] },
        arguments: { target },
        caller: agent(),
        tabId,
        toolName: 'browser_click',
      });
    const shot = () =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant] },
        arguments: {},
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_take_screenshot',
      });

    vi.useFakeTimers();

    try {
      // The first tab leaves a record for another url and no watch; the second leaves a watch and no record.
      await runTimed(click(TAB_ID, '#first'));
      await runTimed(click(secondTab, '#second'));

      // The browser reports the file without a tab: the page ties it to both tabs, and only the second owns it.
      downloads.record({
        id: 90,
        referrer: `${MAIN_ORIGIN}/report.txt`,
        startTime: new Date(Date.now()).toISOString(),
        url: `${MAIN_ORIGIN}/late.bin`,
      });

      const reported = await runTimed(shot(), 0);

      // The file is stopped, and the step the report asks to repeat is the second tab's own call.
      expect([
        reported.kind,
        downloads.cancelled.includes(90),
        reported.kind === 'needs_permission' ? reported.step : undefined,
      ]).toStrictEqual([
        'needs_permission',
        true,
        { argumentsHash: hashBrowserToolArguments({ target: '#second' }), tool: 'browser_click' },
      ]);

      if (reported.kind !== 'needs_permission') {
        throw new Error(`expected a refusal, got ${reported.kind}`);
      }

      expect(reported.result.ok ? '' : reported.result.error).toContain('late.bin');
    } finally {
      vi.useRealTimers();
    }
  });

  it('links a tab-less download to the record that named it, though a newer watch sits on another tab', async () => {
    const downloads = createFakeDownloads();
    // Both tabs sit on the same page, so the item's referrer matches both.
    const secondTab = TAB_ID + 14;
    const tabAt = (id: number) => ({
      id,
      title: 'Example',
      url: `${MAIN_ORIGIN}/report.txt`,
      windowId: 1,
    });
    const tabsApi: BrowserTabsApi = {
      get: async (id: number) => tabAt(id),
      query: async () => [tabAt(TAB_ID), tabAt(secondTab)],
    };
    const { controller } = createGroups();
    const { cdp, runtime } = await createHarness({
      downloadsApi: downloads.api,
      share: false,
      tabGroups: controller,
      tabsApi,
    });

    await runtime.openSession({
      controllerId: 'controller-1',
      sessionHandle: 'session-1',
      title: 'Work',
    });
    await runtime.shareActiveTab({ sessionHandle: 'session-1', tabId: TAB_ID });
    await runtime.shareActiveTab({ sessionHandle: 'session-1', tabId: secondTab });

    const preflightGate = Promise.withResolvers<void>();
    const preflightReached = Promise.withResolvers<void>();
    let parkedPreflights = 0;
    let parking = false;

    cdp.setHandlers({
      'Input.dispatchMouseEvent': () => ({}),
      // The second tab's click is held in its preflight, so the first tab's announcement lands before this call's
      // Guard exists: its watch is then genuinely newer than the record that named the file.
      'Page.getFrameTree': async (
        _params: Record<string, unknown> | undefined,
        target?: { readonly tabId: number }
      ) => {
        if (parking && parkedPreflights === 0 && target?.tabId === secondTab) {
          parkedPreflights += 1;
          preflightReached.resolve();
          await preflightGate.promise;
        }

        return {
          frameTree: {
            childFrames: [],
            frame: { id: 'main', securityOrigin: MAIN_ORIGIN, url: `${MAIN_ORIGIN}/report.txt` },
          },
        };
      },
    });

    const click = (tabId: number, target: string) =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant] },
        arguments: { target },
        caller: agent(),
        tabId,
        toolName: 'browser_click',
      });
    const read = () =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant] },
        arguments: {},
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_snapshot',
      });

    vi.useFakeTimers();

    try {
      // The first tab's click answers without a file, and its linger names one a moment later: the record is the step.
      await runTimed(click(TAB_ID, '#first'));
      await vi.advanceTimersByTimeAsync(1500);

      parking = true;

      const second = click(secondTab, '#second');

      await preflightReached.promise;
      cdp.emit('Browser.downloadWillBegin', {
        guid: 'owner-late',
        suggestedFilename: 'late.bin',
        url: `${MAIN_ORIGIN}/late.bin`,
      });
      await vi.advanceTimersByTimeAsync(1);

      // The click now runs its own guard: the announcement above landed before that guard existed, so the watch it
      // Arms is genuinely newer than the record that named the file. This call reports that announcement itself.
      preflightGate.resolve();

      const secondOutcome = await runTimed(second, 300);

      expect([
        secondOutcome.kind,
        secondOutcome.kind === 'needs_permission' && !secondOutcome.result.ok
          ? secondOutcome.result.error.includes(
              "The click on '#first' started a download of late.bin"
            )
          : false,
      ]).toStrictEqual(['needs_permission', true]);

      // The browser reports the file with no tab: the page ties it to both tabs, and only the first tab named it.
      downloads.record({
        id: 151,
        referrer: `${MAIN_ORIGIN}/report.txt`,
        startTime: new Date(Date.now()).toISOString(),
        url: `${MAIN_ORIGIN}/late.bin`,
      });

      const reported = await runTimed(read(), 0);

      // The record that already named the file wins over the newer watch: the item links to it, so the file is
      // Stopped once and no second record is opened — nothing is reported again, and the next call is plain.
      expect([reported.kind, downloads.cancelled]).toStrictEqual(['result', [151]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('names the requested path, not the whole url, when the kept item has no name yet', async () => {
    const downloads = createFakeDownloads();
    // The browser reports the item while it is still writing, so it has no file name of its own.
    downloads.searched.push({ filename: '/home/me/Downloads/', id: 54 });
    const { cdp, runtime } = await createHarness({ downloadsApi: downloads.api });

    cdp.setHandlers({ 'Page.navigate': () => ({ errorText: 'net::ERR_ABORTED' }) });

    const navigate = (sensitive: readonly string[]) =>
      runtime.runTool({
        agent: {
          authorized: [readGrant, { class: 'navigate', origin: MAIN_ORIGIN }],
          sensitive: [...sensitive],
        },
        arguments: { url: `${MAIN_ORIGIN}/files/report%20one.pdf?token=1` },
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_navigate',
      });

    const guarded = await navigate([]);

    vi.useFakeTimers();

    try {
      const pending = navigate([expectStepToken(guarded)]);

      await vi.advanceTimersByTimeAsync(4000);
      const approved = await pending;
      const text =
        approved.kind === 'result' && approved.result.ok ? String(approved.result.value) : '';

      // The path's last segment, decoded and without the query: a name the model can look for.
      expect(text).toContain('report one.pdf');
      expect(text).not.toContain('token=1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds a stop whose outcome is unknown, then names the file it kept', async () => {
    const downloads = createFakeDownloads({ removeRejects: true });
    const held = Promise.withResolvers<readonly BrowserDownloadItem[]>();
    let holding = true;
    const api: BrowserDownloadsApi = {
      ...downloads.api,
      search: query => {
        if (holding && query.id === 71) {
          holding = false;

          return held.promise;
        }

        return downloads.api.search?.(query);
      },
    };
    const { cdp, runtime } = await createHarness({ downloadsApi: api });

    cdp.setHandlers({ 'Input.dispatchMouseEvent': () => ({}) });

    const click = () =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant] },
        arguments: { target: '#pay' },
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_click',
      });
    const shot = () =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant] },
        arguments: {},
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_take_screenshot',
      });

    vi.useFakeTimers();

    try {
      await runTimed(click());
      await vi.advanceTimersByTimeAsync(1500);
      // The linger stops the file, and its own read of the item has not answered yet: the outcome is unknown.
      downloads.emit({
        filename: '/home/me/Downloads/kept.bin',
        id: 71,
        state: 'complete',
        tabId: TAB_ID,
      });
      await vi.advanceTimersByTimeAsync(0);

      const early = await runTimed(shot(), 0);

      // Nothing is reported while the stop is unsettled: it may yet keep the file, and the report must say so.
      expect(early.kind).toBe('result');

      held.resolve([
        { filename: '/home/me/Downloads/kept.bin', id: 71, state: 'complete', tabId: TAB_ID },
      ]);
      await vi.advanceTimersByTimeAsync(50);

      const reported = await runTimed(shot(), 0);

      if (reported.kind !== 'needs_permission') {
        throw new Error(`expected a refusal, got ${reported.kind}`);
      }

      // The file the browser had already written is named, not reported as deleted.
      expect(reported.result.ok ? '' : reported.result.error).toContain('already saved kept.bin');
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles and names a stop that outlived its window instead of forgetting the record', async () => {
    const downloads = createFakeDownloads({ removeRejects: true });
    const held = Promise.withResolvers<readonly BrowserDownloadItem[]>();
    const snapshotGate = Promise.withResolvers<void>();
    const snapshotReached = Promise.withResolvers<void>();
    let holding = true;
    let parkedSnapshots = 0;
    let parking = false;
    const api: BrowserDownloadsApi = {
      ...downloads.api,
      search: query => {
        if (holding && query.id === 72) {
          holding = false;

          // The stop's own read of the item never answers: the stop stays running past its window.
          return held.promise;
        }

        return downloads.api.search?.(query);
      },
    };
    const { cdp, runtime } = await createHarness({ downloadsApi: api });

    cdp.setHandlers({
      'Input.dispatchMouseEvent': () => ({}),
      // The read is held inside its frame read, so the record falls behind its window while this call is running.
      'Page.getFrameTree': async () => {
        if (parking && parkedSnapshots === 0) {
          parkedSnapshots += 1;
          snapshotReached.resolve();
          await snapshotGate.promise;
        }

        return {
          frameTree: {
            childFrames: [],
            frame: { id: 'main', securityOrigin: MAIN_ORIGIN, url: MAIN_ORIGIN },
          },
        };
      },
    });

    const click = () =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant] },
        arguments: { target: '#pay' },
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_click',
      });
    const read = () =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant] },
        arguments: {},
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_snapshot',
      });

    vi.useFakeTimers();

    try {
      await runTimed(click());
      await vi.advanceTimersByTimeAsync(1500);
      // The linger stops the file, and its own read does not answer: the stop is still running, and unsettled.
      downloads.emit({
        filename: '/home/me/Downloads/overdue.bin',
        id: 72,
        state: 'complete',
        tabId: TAB_ID,
      });

      // Only this read parks: the click before it has to answer.
      parking = true;

      const slow = read();

      // This read started inside the stop's window and outlives it: its own drain of the records must not forget a
      // Stop it cannot settle yet, or the file the browser kept is never named.
      await snapshotReached.promise;
      await vi.advanceTimersByTimeAsync(3000);

      snapshotGate.resolve();

      const ran = await slow;

      expect(ran.kind).toBe('result');

      // The next call settles the overdue stop with the truth — the browser would not delete the file — and names it.
      const reported = await runTimed(read(), 0);

      if (reported.kind !== 'needs_permission') {
        throw new Error(`expected the kept file to be named, got ${reported.kind}`);
      }

      expect(reported.result.ok ? '' : reported.result.error).toContain(
        'already saved overdue.bin'
      );

      // The refusal's own drain reported the record and then pruned it, so this late outcome lands on no record at
      // All: the stop cannot resurrect a file the model was already told about, and nothing new is named.
      held.resolve([
        { filename: '/home/me/Downloads/overdue.bin', id: 72, state: 'complete', tabId: TAB_ID },
      ]);
      await vi.advanceTimersByTimeAsync(50);

      const again = await runTimed(read(), 0);

      expect(again.kind).toBe('result');
    } finally {
      vi.useRealTimers();
    }
  });

  it('never calls an overdue file stopped while the browser cannot search, and names it kept once the attempts are spent', async () => {
    const downloads = createFakeDownloads();
    const held = Promise.withResolvers<readonly BrowserDownloadItem[]>();
    let reading = true;
    const api: BrowserDownloadsApi = {
      ...downloads.api,
      search: query => {
        if (query.id !== 72) {
          return downloads.api.search?.(query);
        }

        if (reading) {
          reading = false;

          // The stop's own read of the item never answers: the stop is still running when its window closes.
          return held.promise;
        }

        // Every later lookup throws: the browser never says whether the file is still there.
        throw new Error('the downloads API is unavailable');
      },
    };
    const { cdp, runtime } = await createHarness({ downloadsApi: api });

    cdp.setHandlers({ 'Input.dispatchMouseEvent': () => ({}) });

    const click = () =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant] },
        arguments: { target: '#pay' },
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_click',
      });
    const read = () =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant] },
        arguments: {},
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_snapshot',
      });

    vi.useFakeTimers();

    try {
      await runTimed(click());
      await vi.advanceTimersByTimeAsync(1500);
      downloads.emit({
        filename: '/home/me/Downloads/unknowable.bin',
        id: 72,
        state: 'complete',
        tabId: TAB_ID,
      });
      await vi.advanceTimersByTimeAsync(3000);

      const first = await runTimed(read(), 0);
      const second = await runTimed(read(), 0);
      const third = await runTimed(read(), 0);
      const thirdText =
        third.kind === 'needs_permission' && !third.result.ok ? third.result.error : '';

      // A search that failed is not a missing file: the first two calls report nothing rather than a stop, and the
      // Third spends the bound and names the file the record holds as kept.
      expect([
        first.kind,
        second.kind,
        third.kind,
        thirdText.includes('already saved unknowable.bin'),
      ]).toStrictEqual(['result', 'result', 'needs_permission', true]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('deletes a file whose item left the history before it calls that file removed', async () => {
    const downloads = createFakeDownloads();
    const held = Promise.withResolvers<readonly BrowserDownloadItem[]>();
    let reading = true;
    const api: BrowserDownloadsApi = {
      ...downloads.api,
      search: query => {
        if (query.id !== 72) {
          return downloads.api.search?.(query);
        }

        if (reading) {
          reading = false;

          // The stop's own read of the item never answers: the stop is still running when its window closes.
          return held.promise;
        }

        // The browser erased the item from its history, which says nothing about the file it wrote.
        return Promise.resolve([]);
      },
    };
    const { cdp, runtime } = await createHarness({ downloadsApi: api });

    cdp.setHandlers({ 'Input.dispatchMouseEvent': () => ({}) });

    const click = () =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant] },
        arguments: { target: '#pay' },
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_click',
      });
    const read = () =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant] },
        arguments: {},
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_snapshot',
      });

    vi.useFakeTimers();

    try {
      await runTimed(click());
      await vi.advanceTimersByTimeAsync(1500);
      downloads.emit({
        filename: '/home/me/Downloads/gone.bin',
        id: 72,
        state: 'complete',
        tabId: TAB_ID,
      });
      await vi.advanceTimersByTimeAsync(3000);

      const reported = await runTimed(read(), 0);

      if (reported.kind !== 'needs_permission') {
        throw new Error(`expected the stopped file to be reported, got ${reported.kind}`);
      }

      // The record deleted the file by id before it answered, so the report says stopped and never "already saved".
      expect([
        downloads.removed,
        downloads.erased,
        (reported.result.ok ? '' : reported.result.error).includes('already saved'),
      ]).toStrictEqual([[72], [{ id: 72 }], false]);
    } finally {
      vi.useRealTimers();
    }
  });

  /** A tabs-new harness whose opened tab can be closed, with the download and frame fakes of the group. */
  const tabsNewFixture = async (
    options: {
      /** The opened tab stays `about:blank`, so a navigate it drives never lands and the guard has to search for the file. */
      readonly blankTab?: boolean;
      readonly deferredCreate?: boolean;
      readonly deferredNavigate?: boolean;
      /** A frame read the test answers by hand, so a call can be parked before it opens its tab. */
      readonly deferredPreflight?: boolean;
      /** The guard's url search parks: the test decides when the call's settle runs on. */
      readonly gatedSearch?: boolean;
      readonly granted?: boolean;
      readonly leases?: TabLeaseRegistry;
      /** A navigate that loads a page instead of becoming the download the guard stops. */
      readonly plain?: boolean;
      /** Extra grants for a case about an origin the step may already open or read. */
      readonly extraGrants?: readonly BrowserGrant[];
      /** The url the opened tab reports, when a case's navigation lands somewhere other than the step's destination. */
      readonly tabUrl?: () => string;
      /** The Downloads permission is gone by the time the guard is armed: revoked after the pre-open check. */
      readonly revokeAfterOpen?: boolean;
      /** The opened tab reports an empty url, as Chrome does without the `tabs` permission. */
      readonly unreadableTabUrl?: boolean;
      /** No file is in the browser's download history, so the guard's search cannot claim one. */
      readonly noSeededFile?: boolean;
    } = {}
  ) => {
    const downloads = createFakeDownloads();
    const created: Record<string, unknown>[] = [];
    const openedListeners: ((tab: {
      readonly id?: number;
      readonly openerTabId?: number;
    }) => void)[] = [];
    const newTab = TAB_ID + 11;
    let closed = false;
    const removed: number[] = [];
    const createGate = Promise.withResolvers<void>();
    const createReached = Promise.withResolvers<void>();
    /** What happened on the two tabs, in order: the guard's search returning, and the panel driving the tab. */
    const events: string[] = [];
    const preflightGate = Promise.withResolvers<void>();
    const preflightReached = Promise.withResolvers<void>();
    const searchGate = Promise.withResolvers<void>();
    const searchReached = Promise.withResolvers<void>();
    let parkedSearches = 0;

    const tabsApi: BrowserTabsApi & {
      readonly create: (properties: { readonly url?: string }) => Promise<BrowserTabInfo>;
    } = {
      create: async (properties: { readonly url?: string }) => {
        createReached.resolve();
        await (options.deferredCreate === true ? createGate.promise : Promise.resolve());
        created.push({ ...properties });

        for (const listener of openedListeners) {
          listener({ id: newTab, openerTabId: TAB_ID });
        }

        return { id: newTab, title: '', url: properties.url ?? 'about:blank', windowId: 1 };
      },
      get: async (tabId: number) => {
        if (tabId !== newTab) {
          return { id: TAB_ID, title: 'Example', url: MAIN_ORIGIN };
        }

        // A closed step tab is one the browser no longer has: no id is how the runtime reads that.
        if (closed) {
          return { title: '', url: '' };
        }

        // A blank tab is one whose navigate never committed a document: the guard cannot see the page move.
        if (options.blankTab === true) {
          return { id: newTab, title: '', url: 'about:blank' };
        }

        // A tab Chrome will not describe without the `tabs` permission: the url is empty, not `about:blank`.
        if (options.unreadableTabUrl === true) {
          return { id: newTab, title: '', url: '' };
        }

        // A case whose navigation lands elsewhere: the tab reports the url it really committed, once that has happened.
        return {
          id: newTab,
          title: '',
          url: options.tabUrl?.() ?? `${MAIN_ORIGIN}/report.txt`,
        };
      },
      onCreated: {
        addListener: (
          listener: (tab: { readonly id?: number; readonly openerTabId?: number }) => void
        ) => {
          openedListeners.push(listener);
        },
        removeListener: () => {},
      },
      query: async () => [
        { active: true, id: TAB_ID, title: 'Example', url: MAIN_ORIGIN, windowId: 1 },
      ],
      remove: async (tabId: number) => {
        removed.push(tabId);
      },
    };
    // The guard looks the file up by the url it navigated to: that search is the one a test can park, and it answers
    // With nothing rather than the seeded history, so the call stays parked instead of finding the kept file at once.
    const stepDownloads: BrowserDownloadsApi = {
      ...downloads.api,
      search: async query => {
        if (options.gatedSearch === true && query.url !== undefined) {
          if (parkedSearches === 0) {
            parkedSearches += 1;
            searchReached.resolve();
            await searchGate.promise;
            events.push('search-returned');
          }

          return [];
        }

        return (await downloads.api.search?.(query)) ?? [];
      },
    };
    const { controller } = createGroups();
    const downloadsDependency =
      options.granted === false ? { downloadsGranted: false } : { downloadsApi: stepDownloads };
    const harness = await createHarness({
      ...(options.revokeAfterOpen === true
        ? { downloadsResolver: () => (created.length === 0 ? stepDownloads : undefined) }
        : downloadsDependency),
      ...(options.leases === undefined ? {} : { leases: options.leases }),
      tabGroups: controller,
      tabsApi,
    });

    // The file the approved repeat keeps, as the browser reports it once it is written. A case about the answer's
    // Text rather than the download leaves the history empty, so the guard's search cannot claim a file.
    if (options.noSeededFile !== true) {
      downloads.searched.push({ filename: '/home/me/Downloads/report.txt', id: 72 });
    }

    /**
     * A navigate the test answers by hand, so two calls can be interleaved on purpose. One waiter per navigate, in
     * dispatch order: a test that drives the tab twice parks the second navigate without touching the first.
     */
    interface NavigateWait {
      readonly gate: Promise<void>;
      readonly markReached: () => void;
      readonly reached: Promise<void>;
      readonly release: () => void;
    }

    const navigateWaits = new Map<number, NavigateWait>();
    const navigateWaitFor = (index: number): NavigateWait => {
      const existing = navigateWaits.get(index);

      if (existing !== undefined) {
        return existing;
      }

      const reached = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      const wait: NavigateWait = {
        gate: gate.promise,
        markReached: () => {
          reached.resolve();
        },
        reached: reached.promise,
        release: () => {
          gate.resolve();
        },
      };

      navigateWaits.set(index, wait);

      return wait;
    };
    let navigateCalls = 0;

    harness.cdp.setHandlers({
      ...(options.deferredPreflight === true
        ? {
            'Page.getFrameTree': async (
              _params: Record<string, unknown> | undefined,
              target?: { readonly tabId: number }
            ) => {
              if (target?.tabId === TAB_ID) {
                preflightReached.resolve();
                await preflightGate.promise;
              }

              return {
                frameTree: {
                  childFrames: [],
                  frame: { id: 'main', securityOrigin: MAIN_ORIGIN, url: MAIN_ORIGIN },
                },
              };
            },
          }
        : {}),
      'Page.navigate': async () => {
        const index = navigateCalls;

        navigateCalls += 1;

        if (options.deferredNavigate === true) {
          const wait = navigateWaitFor(index);

          wait.markReached();
          await wait.gate;
        }

        if (options.plain === true) {
          return { frameId: 'main' };
        }

        // The destination became a download, which the guard stops and reports as the step to approve.
        downloads.emit({ id: 75, tabId: newTab });

        return { errorText: 'net::ERR_ABORTED' };
      },
    });

    const url = `${MAIN_ORIGIN}/report.txt`;
    const run = (caller: BrowserCaller, sensitive: readonly string[] = [], tabId = TAB_ID) =>
      harness.runtime.runTool({
        agent: {
          authorized: [
            readGrant,
            actGrant,
            { class: 'navigate', origin: MAIN_ORIGIN },
            ...(options.extraGrants ?? []),
          ],
          sensitive: [...sensitive],
        },
        arguments: { action: 'new', url },
        caller,
        tabId,
        toolName: 'browser_tabs',
      });

    return {
      ...harness,
      closeTab: (next: boolean) => {
        closed = next;
      },
      created,
      downloads,
      events,
      newTab,
      reachedCreate: () => createReached.promise,
      reachedNavigate: (index = 0) => navigateWaitFor(index).reached,
      reachedPreflight: () => preflightReached.promise,
      reachedSearch: () => searchReached.promise,
      releaseCreate: () => {
        createGate.resolve();
      },
      releaseNavigate: (index = 0) => {
        navigateWaitFor(index).release();
      },
      releasePreflight: () => {
        preflightGate.resolve();
      },
      releaseSearch: () => {
        searchGate.resolve();
      },
      removed,
      run,
    };
  };

  it('ends the call on the driven tab when that tab is taken over, after its guard settles', async () => {
    vi.useFakeTimers();

    try {
      const fixture = await tabsNewFixture({ deferredNavigate: true });
      const pending = fixture.run(agent());

      await fixture.reachedNavigate();

      // A panel takes the opened tab over while the agent is parked in the navigate.
      const panelCall = fixture.runtime.runTool({
        arguments: {},
        caller: panel(),
        tabId: fixture.newTab,
        takeOver: true,
        toolName: 'browser_snapshot',
      });

      await vi.advanceTimersByTimeAsync(1000);

      const outcome = await pending;

      // The take-over ended the agent's call on that tab.
      expect(outcome).toMatchObject({ kind: 'result', result: { error: TAB_TAKEN_ERROR } });

      await panelCall;

      // The panel's frame read on that tab comes after the guard put the download behaviour back, so the guard the
      // Finished call left cannot cancel the panel's download.
      const onTab = fixture.cdp
        .sent()
        .filter(command => command.tabId === fixture.newTab)
        .map(command => command.method);
      const restoreAt = onTab.lastIndexOf('Page.setDownloadBehavior');
      const frameReadAt = onTab.indexOf('Accessibility.getFullAXTree');

      expect([restoreAt !== -1, frameReadAt === -1 || restoreAt < frameReadAt]).toStrictEqual([
        true,
        true,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the call running when the caller tab is taken over', async () => {
    vi.useFakeTimers();

    try {
      const fixture = await tabsNewFixture({ deferredNavigate: true });
      const pending = fixture.run(agent());

      await fixture.reachedNavigate();

      // The panel takes the caller's tab, which this call is not driving.
      const callerTakeOver = fixture.runtime.runTool({
        arguments: {},
        caller: panel(),
        tabId: TAB_ID,
        takeOver: true,
        toolName: 'browser_snapshot',
      });

      fixture.releaseNavigate();
      await vi.advanceTimersByTimeAsync(1000);

      const [panelOutcome, survived] = await Promise.all([callerTakeOver, pending]);

      expect([panelOutcome.kind, survived.kind]).toStrictEqual(['result', 'needs_permission']);

      if (survived.kind === 'needs_take_over') {
        throw new Error('expected a call outcome, got a take-over request');
      }

      expect(survived.result.ok ? '' : survived.result.error).not.toBe(TAB_TAKEN_ERROR);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a repeat while a panel holds the step tab, and the token still redeems', async () => {
    const fixture = await tabsNewFixture();
    const guarded = await fixture.run(agent());
    const token = expectStepToken(guarded);

    // A panel holds an idle lease on the tab the step opened.
    await fixture.leases.acquire(fixture.newTab, panel());

    const busy = await fixture.run(agent(), [token]);

    // The approval is not spent on a call that cannot run.
    expect(busy).toMatchObject({ kind: 'result', result: { error: TAB_BUSY_ERROR } });

    fixture.leases.release(fixture.newTab, panel());

    const approved = await fixture.run(agent(), [token]);

    expect(
      approved.kind === 'result' && approved.result.ok ? String(approved.result.value) : ''
    ).toContain('The file was downloaded; the page did not change.');
  });

  it('releases only the lease it took, and keeps a lease the session already held', async () => {
    const fixture = await tabsNewFixture();
    const guarded = await fixture.run(agent());

    await fixture.run(agent(), [expectStepToken(guarded)]);

    // A call that took the step tab's lease gives it back when it ends.
    expect(fixture.leases.holder(fixture.newTab)).toBeUndefined();

    const second = await tabsNewFixture();
    const guardedAgain = await second.run(agent());

    // The session already holds that tab: the repeat must not free a lease it never took.
    await second.leases.acquire(second.newTab, agent());
    await second.run(agent(), [expectStepToken(guardedAgain)]);

    expect(second.leases.holder(second.newTab)).toBeDefined();
  });

  it('opens no tab when the caller tab is taken over before the tab is opened', async () => {
    vi.useFakeTimers();

    try {
      const fixture = await tabsNewFixture({ deferredPreflight: true });
      const pending = fixture.run(agent());

      await fixture.reachedPreflight();

      // The take-over lands while the call is still reading the caller tab, before any tab exists.
      const takeover = fixture.runtime.runTool({
        arguments: {},
        caller: panel(),
        tabId: TAB_ID,
        takeOver: true,
        toolName: 'browser_snapshot',
      });

      await vi.advanceTimersByTimeAsync(100);
      fixture.releasePreflight();

      const outcome = await pending;

      await takeover;

      // The call is over and no tab was opened for it.
      expect(outcome).toMatchObject({ kind: 'result', result: { error: TAB_TAKEN_ERROR } });
      expect(fixture.created).toStrictEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes the tab it opened when the caller tab is taken over while that tab is being created', async () => {
    vi.useFakeTimers();

    try {
      const fixture = await tabsNewFixture({ deferredCreate: true });
      const pending = fixture.run(agent());

      await fixture.reachedCreate();

      // The take-over lands while the new tab exists in the browser but not yet in this call's hands.
      const takeover = fixture.runtime.runTool({
        arguments: {},
        caller: panel(),
        tabId: TAB_ID,
        takeOver: true,
        toolName: 'browser_snapshot',
      });

      await vi.advanceTimersByTimeAsync(100);
      fixture.releaseCreate();

      const outcome = await pending;

      await takeover;

      // The call is over and the tab it opened is closed again rather than left for the next call.
      expect(outcome).toMatchObject({ kind: 'result', result: { error: TAB_TAKEN_ERROR } });
      expect(fixture.removed).toStrictEqual([fixture.newTab]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes the tab it opened when its lease is not granted', async () => {
    const real = createTabLeaseRegistry({});
    const refused: TabLeaseRegistry = {
      ...real,
      acquire: async (tabId, caller, options) =>
        tabId === TAB_ID
          ? real.acquire(tabId, caller, options)
          : { holder: { key: 'panel', tabId }, kind: 'busy' },
    };
    const fixture = await tabsNewFixture({ leases: refused });

    const outcome = await fixture.run(agent());

    // Another holder's tab is refused, and the tab this call opened is not left in the session's group.
    expect(outcome).toMatchObject({ kind: 'result', result: { error: TAB_BUSY_ERROR } });
    expect(fixture.removed).toStrictEqual([fixture.newTab]);
  });

  it('ends a call taken over while its tab lease was being acquired, and closes the tab', async () => {
    vi.useFakeTimers();

    try {
      const acquired = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      const real = createTabLeaseRegistry({});
      const parked: TabLeaseRegistry = {
        ...real,
        acquire: async (tabId, caller, options) => {
          if (tabId !== TAB_ID) {
            acquired.resolve();
            await gate.promise;
          }

          return real.acquire(tabId, caller, options);
        },
      };
      const fixture = await tabsNewFixture({ leases: parked });
      const pending = fixture.run(agent());

      await acquired.promise;

      const takeover = fixture.runtime.runTool({
        arguments: {},
        caller: panel(),
        tabId: TAB_ID,
        takeOver: true,
        toolName: 'browser_snapshot',
      });

      await vi.advanceTimersByTimeAsync(100);
      gate.resolve();

      const outcome = await pending;

      await takeover;

      // The take-over that landed during the acquire is not ignored: the call is over and the tab is closed.
      expect(outcome).toMatchObject({ kind: 'result', result: { error: TAB_TAKEN_ERROR } });
      expect(fixture.removed).toStrictEqual([fixture.newTab]);
      // The lease it took while the take-over landed went back with the tab, so nothing is left holding it.
      expect(fixture.leases.holder(fixture.newTab)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens the tab and intercepts its document when the permission is revoked before the guard', async () => {
    // The pre-open check and the guard read the same permission, so the call runs with the response interceptor
    // Instead of refusing: the tab it opened is the call's, not a leftover for the next call to inherit.
    const fixture = await tabsNewFixture({ revokeAfterOpen: true });

    await fixture.run(agent());

    expect(fixture.created).toHaveLength(1);
    expect(fixture.cdp.commands()).toStrictEqual(
      expect.arrayContaining(['Fetch.enable', 'Fetch.disable'])
    );
    expect(fixture.removed).toStrictEqual([]);
  });

  it('holds the driven tab until its guard has settled, so the panel download survives', async () => {
    vi.useFakeTimers();

    try {
      const fixture = await tabsNewFixture({
        blankTab: true,
        deferredNavigate: true,
        gatedSearch: true,
        plain: true,
      });
      const marker = 'MARKER_OF_THE_PANEL_CALL';

      // The panel's own call on the driven tab: its marker command is what a guard left listening would react to.
      fixture.cdp.setHandlers({
        'Runtime.evaluate': (params, target) => {
          const carriesMarker =
            target?.tabId === fixture.newTab && JSON.stringify(params ?? {}).includes(marker);

          if (!carriesMarker) {
            return;
          }

          fixture.events.push('panel-cdp');
          fixture.downloads.emit({ id: 90, tabId: fixture.newTab });

          return { result: { value: marker } };
        },
      });

      const pending = fixture.run(agent());

      await fixture.reachedNavigate();

      // The panel takes the tab the agent opened, while the agent is still parked in its navigate.
      const panelCall = fixture.runtime.runTool({
        arguments: { function: `() => "${marker}"` },
        caller: panel(),
        tabId: fixture.newTab,
        takeOver: true,
        toolName: 'browser_evaluate',
      });

      // The tab reports itself still blank, so the guard never sees its page land and searches for the file instead.
      fixture.releaseNavigate();
      await fixture.reachedSearch();
      await vi.advanceTimersByTimeAsync(50);

      // The panel waits outside the tab until this call's guard has settled: it sent nothing yet.
      expect(
        fixture.cdp
          .sent()
          .filter(
            command =>
              command.tabId === fixture.newTab &&
              JSON.stringify(command.params ?? {}).includes(marker)
          )
          .map(command => command.method)
      ).toStrictEqual([]);

      fixture.releaseSearch();
      await vi.advanceTimersByTimeAsync(1000);

      const [outcome, panelOutcome] = await Promise.all([pending, panelCall]);
      const refused =
        outcome.kind === 'result' && !outcome.result.ok ? outcome.result.error : outcome.kind;
      // The guard's search returned before the panel's command went out — and that command really went out — so the
      // Guard the taken call left listening never saw the file the panel's own call started.
      expect([
        refused,
        panelOutcome.kind,
        fixture.events,
        fixture.cdp
          .sent()
          .filter(
            command =>
              command.tabId === fixture.newTab &&
              JSON.stringify(command.params ?? {}).includes(marker)
          )
          .map(command => command.method),
        fixture.downloads.cancelled.includes(90),
      ]).toStrictEqual([
        TAB_TAKEN_ERROR,
        'result',
        ['search-returned', 'panel-cdp'],
        ['Runtime.evaluate'],
        false,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('grants a panel the tab a call is still acquiring, without ending that call', async () => {
    const real = createTabLeaseRegistry({});
    const acquireGate = Promise.withResolvers<void>();
    const acquireReached = Promise.withResolvers<void>();
    let parked = false;
    const parkedLeases: TabLeaseRegistry = {
      ...real,
      acquire: async (tabId, caller, options) => {
        if (parked && tabId !== TAB_ID && caller.kind === 'agent') {
          acquireReached.resolve();
          await acquireGate.promise;
        }

        return real.acquire(tabId, caller, options);
      },
    };
    const fixture = await tabsNewFixture({ leases: parkedLeases });
    // The approval this repeat carries, from the call that stopped the file.
    const token = expectStepToken(await fixture.run(agent()));

    parked = true;

    const pending = fixture.run(agent(), [token]);

    // Parked in the acquire: the precheck passed, the token is spent, and this call holds no lease on that tab yet.
    await acquireReached.promise;

    const panelOutcome = await fixture.runtime.runTool({
      arguments: { function: '() => 1' },
      caller: panel(),
      tabId: fixture.newTab,
      takeOver: true,
      toolName: 'browser_evaluate',
    });

    // The panel's call is granted the tab and fires nothing: no hook of the acquiring call is installed yet.
    expect(panelOutcome.kind).toBe('result');

    real.release(fixture.newTab, panel());
    acquireGate.resolve();

    const outcome = await pending;

    // The call survives the panel's call, and its approval still buys the file the browser kept.
    expect(outcome).toMatchObject({ kind: 'result', result: { ok: true } });
    expect(
      outcome.kind === 'result' && outcome.result.ok ? String(outcome.result.value) : ''
    ).toContain('The file was downloaded; the page did not change.');
  });

  it('ends a call parked in its navigate when a panel takes the driven tab over', async () => {
    vi.useFakeTimers();

    try {
      const fixture = await tabsNewFixture({ deferredNavigate: true });
      const guarded = fixture.run(agent());

      await fixture.reachedNavigate();
      fixture.releaseNavigate();

      const token = expectStepToken(await guarded);
      const pending = fixture.run(agent(), [token]);

      // The approved repeat drives the tab the step opened, and is parked in its navigate there.
      await fixture.reachedNavigate(1);

      const takeover = fixture.runtime.runTool({
        arguments: {},
        caller: panel(),
        tabId: fixture.newTab,
        takeOver: true,
        toolName: 'browser_snapshot',
      });

      await vi.advanceTimersByTimeAsync(100);

      const outcome = await pending;

      await takeover;

      // The hook this call installed on the tab it leased ends it, even though the caller's tab was never taken.
      expect(outcome).toMatchObject({ kind: 'result', result: { error: TAB_TAKEN_ERROR } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps its in-flight hook when an earlier call on the driven tab finishes', async () => {
    vi.useFakeTimers();

    try {
      const fixture = await tabsNewFixture({ deferredNavigate: true });
      const guarded = fixture.run(agent());

      await fixture.reachedNavigate();
      fixture.releaseNavigate();
      await vi.advanceTimersByTimeAsync(1000);

      const token = expectStepToken(await guarded);

      // An earlier call on the tab the step opened is still running: the panel is parked inside its snapshot there.
      const snapshotGate = Promise.withResolvers<void>();
      const snapshotReached = Promise.withResolvers<void>();
      let parkedSnapshots = 0;

      fixture.cdp.setHandlers({
        'Accessibility.getFullAXTree': async (
          params: Record<string, unknown> | undefined,
          target?: { readonly tabId: number }
        ): Promise<Record<string, unknown>> => {
          if (parkedSnapshots === 0 && target?.tabId === fixture.newTab) {
            parkedSnapshots += 1;
            snapshotReached.resolve();
            await snapshotGate.promise;

            // The parked read is the main frame's tree, which is the fake's own answer for it.
            return MAIN_TREE;
          }

          const { frameId } = params ?? {};

          return frameId === undefined || frameId === 'main' ? MAIN_TREE : FRAME_TREE;
        },
      });

      const earlier = fixture.runtime.runTool({
        arguments: {},
        caller: panel(),
        tabId: fixture.newTab,
        takeOver: true,
        toolName: 'browser_snapshot',
      });

      await snapshotReached.promise;

      // Its lease is given back while its body is still running, so the next call may take the tab over.
      fixture.leases.release(fixture.newTab, panel());

      const pending = fixture.run(agent(), [token]);

      await fixture.reachedNavigate(1);

      // The earlier call's cleanup must not remove the hook this call installed on that tab.
      snapshotGate.resolve();
      await earlier;

      const takeover = fixture.runtime.runTool({
        arguments: {},
        caller: panel(),
        tabId: fixture.newTab,
        takeOver: true,
        toolName: 'browser_snapshot',
      });

      await vi.advanceTimersByTimeAsync(100);
      // Nothing would end this call on its own: let the navigate answer so a lost hook shows up as a kept file.
      fixture.releaseNavigate(1);

      const outcome = await pending;

      await takeover;

      // A later take-over of that tab still ends the call, because its hook survived the earlier call's cleanup.
      expect(outcome).toMatchObject({ kind: 'result', result: { error: TAB_TAKEN_ERROR } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs a guarded tabs-new without the downloads permission under the response interceptor', async () => {
    const fixture = await tabsNewFixture({ granted: false });

    await fixture.run(agent());

    // The tab is opened and its document paused rather than the call being refused: a user who declined the
    // Permission keeps the browser, and a page that starts no download answers as it always did.
    expect(fixture.created).toHaveLength(1);
    // The intercept is armed for the call and released with it, so the tab keeps its own speed afterwards.
    expect(fixture.cdp.commands()).toStrictEqual(
      expect.arrayContaining(['Fetch.enable', 'Fetch.disable'])
    );
  });

  it('refuses a repeat whose step tab was closed, without burning its token', async () => {
    const fixture = await tabsNewFixture();
    const guarded = await fixture.run(agent());

    if (guarded.kind !== 'needs_permission') {
      throw new Error(`expected a refusal, got ${guarded.kind}`);
    }

    const token = expectStepToken(guarded);

    // The tab is gone: the repeat is the gone refusal, and the same token still buys the approval once it is back.
    fixture.closeTab(true);
    const gone = await fixture.run(agent(), [token]);

    if (gone.kind !== 'result' || gone.result.ok) {
      throw new Error(`expected the gone refusal, got ${JSON.stringify(gone)}`);
    }

    expect(gone.result.error).toBe(DOWNLOAD_STEP_TAB_GONE_ERROR);

    fixture.closeTab(false);
    const approved = await fixture.run(agent(), [token]);

    expect(
      approved.kind === 'result' && approved.result.ok ? String(approved.result.value) : ''
    ).toContain('The file was downloaded; the page did not change.');
  });

  it('reports the withheld frames after a guarded tabs-new navigation', async () => {
    const fixture = await tabsNewFixture({ plain: true });
    const outcome = await fixture.run(agent());

    // The navigate landed a page, and the frames the agent may not read are named on the tabs-new answer too.
    if (outcome.kind !== 'result') {
      throw new Error(`expected a result, got ${outcome.kind}`);
    }

    expect(outcome.withheldFrames).toStrictEqual([FRAME_ORIGIN]);
  });

  it('answers the opened tab for a tabs-new that settles on its approved destination', async () => {
    const fixture = await tabsNewFixture({ plain: true });
    const outcome = await fixture.run(agent());

    // The tab the step opened is the answer, at the url the step navigated to.
    expect(expectResult(outcome).result.value).toStrictEqual({
      selected: true,
      tabId: fixture.newTab,
      title: '',
      url: `${MAIN_ORIGIN}/report.txt`,
    });
  });

  it('reports origin_changed for a tabs-new that redirects to another origin', async () => {
    const fixture = await tabsNewFixture({ plain: true });

    // The approved destination answered with a redirect: the tab commits on another origin than the one the step was approved for.
    fixture.cdp.setFrameUrl('https://accounts.example.org/login');

    const outcome = await fixture.run(agent());

    expect(outcome).toMatchObject({
      from: MAIN_ORIGIN,
      kind: 'origin_changed',
      to: 'https://accounts.example.org',
    });
    // The step's own answer is the refusal, not a claim that the tab opened where it was asked to.
    expect(originChangedResultOf(outcome)).toMatchObject({ ok: true });
  });

  it('completes a tabs-new redirect that lands on an origin the step may already read', async () => {
    const landing = 'https://accounts.example.org';
    // The tab reports the landing url only once its navigation has committed it, as a browser does.
    let committed = `${MAIN_ORIGIN}/report.txt`;
    const fixture = await tabsNewFixture({
      extraGrants: [{ class: 'read', origin: landing }],
      // The step loads a page, so no file exists for the guard to claim from the browser's history.
      noSeededFile: true,
      plain: true,
      tabUrl: () => committed,
    });

    fixture.cdp.setHandlers({
      'Page.navigate': () => {
        committed = `${landing}/login`;
        fixture.cdp.setFrameUrl(committed);

        return { frameId: 'main' };
      },
    });

    const outcome = await fixture.run(agent());

    // `postAgentNavigate` is the only judge: a landing origin the session may read is the redirect's answer, and the
    // Tab the step opened is what the caller gets back, at the url it really committed.
    expect(outcome.kind).toBe('result');
    expect(expectResult(outcome).result.value).toStrictEqual({
      selected: true,
      tabId: fixture.newTab,
      title: '',
      url: `${landing}/login`,
    });
  });

  it('names the tab a guarded tabs-new opened when the navigation leaves a dialog open on it', async () => {
    const fixture = await tabsNewFixture({ plain: true });

    // The destination page opens a dialog as it loads, and nothing answers it.
    fixture.cdp.setHandlers({
      'Page.navigate': () => {
        // The document commits, then its script opens the dialog: the frame tree reports the origin it committed with.
        fixture.cdp.emitOn(fixture.newTab, 'Page.frameNavigated', {
          frame: { id: 'main', securityOrigin: MAIN_ORIGIN, url: `${MAIN_ORIGIN}/report.txt` },
        });
        fixture.cdp.emitOn(fixture.newTab, 'Page.javascriptDialogOpening', {
          // The frame that opened it is the tab's own document; the harness's frame tree reports its origin.
          frameId: 'main',
          message: 'Saved',
          type: 'alert',
          // `url` is required by the protocol: the page that opened the dialog.
          url: `${MAIN_ORIGIN}/report.txt`,
        });

        return { frameId: 'main' };
      },
    });

    const outcome = await fixture.run(agent());

    if (outcome.kind !== 'result') {
      throw new Error(`expected a result, got ${outcome.kind}`);
    }

    // The dialog is what the caller acts on next, and the tab it acted on stays named: its id and url are how the
    // Caller answers the dialog on that tab.
    expect(outcome.result.ok ? outcome.result.value : '').toBe(
      '### Modal state\n- ["alert" dialog with message "Saved"]: can be handled by browser_handle_dialog\n\n' +
        `The call opened tab ${String(fixture.newTab)} (${MAIN_ORIGIN}/report.txt).`
    );
    // The page cannot report its frames while its dialog is open, so this answer claims nothing about them.
    expect(outcome).not.toHaveProperty('withheldFrames');
  });

  it('falls back to the url the step opened when the tab reports an empty one under its dialog', async () => {
    const fixture = await tabsNewFixture({
      noSeededFile: true,
      plain: true,
      unreadableTabUrl: true,
    });

    fixture.cdp.setHandlers({
      'Page.navigate': () => {
        fixture.cdp.emitOn(fixture.newTab, 'Page.javascriptDialogOpening', {
          message: 'Saved',
          type: 'alert',
          url: `${MAIN_ORIGIN}/report.txt`,
        });

        return { frameId: 'main' };
      },
    });

    const outcome = await fixture.run(agent());

    if (outcome.kind !== 'result') {
      throw new Error(`expected a result, got ${outcome.kind}`);
    }

    const text = outcome.result.ok ? String(outcome.result.value) : '';

    // A tab Chrome reports without a url must not print an empty pair of brackets: the guarded step opens it blank,
    // And that url is what the branch below already falls back to.
    expect(text).toContain(`The call opened tab ${String(fixture.newTab)} (about:blank).`);
    expect(text).not.toContain('()');
  });

  const refusalSchema = z.object({
    code: z.number(),
    data: z.record(z.string(), z.unknown()).optional(),
    message: z.string(),
  });

  /** The bridge's RPC failure for one call: the protocol error the hub would relay to the CLI. */
  const refusalOf = async (call: Promise<unknown>): Promise<z.infer<typeof refusalSchema>> => {
    try {
      await call;
    } catch (error) {
      return refusalSchema.parse(error);
    }

    throw new Error('expected the call to be refused');
  };

  it('binds a bridge-level tabs-new download to the tabs call, and its token drives the tab it opened', async () => {
    const downloads = createFakeDownloads();
    downloads.searched.push({ filename: '/home/me/Downloads/report.txt', id: 72 });
    const created: Record<string, unknown>[] = [];
    const openedListeners: ((tab: {
      readonly id?: number;
      readonly openerTabId?: number;
    }) => void)[] = [];
    const newTab = TAB_ID + 7;
    let navigating = true;

    const tabsApi = {
      create: async (properties: { readonly url?: string } = {}) => {
        created.push({ ...properties });

        for (const listener of openedListeners) {
          listener({ id: newTab, openerTabId: TAB_ID });
        }

        return { id: newTab, title: '', url: properties.url ?? 'about:blank', windowId: 1 };
      },
      get: async (tabId: number) =>
        tabId === newTab
          ? { id: newTab, title: '', url: `${MAIN_ORIGIN}/report.txt`, windowId: 1 }
          : { id: TAB_ID, title: 'Example', url: MAIN_ORIGIN },
      onCreated: {
        addListener: (
          listener: (tab: { readonly id?: number; readonly openerTabId?: number }) => void
        ) => {
          openedListeners.push(listener);
        },
        removeListener: (
          listener: (tab: { readonly id?: number; readonly openerTabId?: number }) => void
        ) => {
          const index = openedListeners.indexOf(listener);

          if (index !== -1) {
            openedListeners.splice(index, 1);
          }
        },
      },
      query: async () => [
        { active: true, id: TAB_ID, title: 'Example', url: MAIN_ORIGIN, windowId: 1 },
      ],
    };
    const { controller } = createGroups();
    // No tab at first: the call opens the session's own, exactly as the hub's first call does.
    const { cdp, runtime } = await createHarness({
      downloadsApi: downloads.api,
      share: false,
      tabGroups: controller,
      tabsApi,
    });

    cdp.setHandlers({
      'Page.navigate': () => {
        if (navigating) {
          navigating = false;
          downloads.emit({ id: 71, tabId: newTab });
        }

        return { errorText: 'net::ERR_ABORTED' };
      },
    });

    const bridge = createRuntimeBrowserBridge({ runtime: () => runtime });

    await bridge.openSession({
      controllerId: 'controller-1',
      sessionHandle: 'session-1',
      title: 'Work',
    });

    const url = `${MAIN_ORIGIN}/report.txt`;
    const params = {
      arguments: { action: 'new', url },
      authorized: [readGrant, actGrant, { class: 'navigate' as const, origin: MAIN_ORIGIN }],
      name: 'browser_tabs',
      sessionHandle: 'session-1',
    };

    const guarded = await refusalOf(bridge.callTool('controller-1', params));

    // The CLI keys its token by the call it sent, so the step must name that call, not the navigate it ran as.
    expect([guarded.code, guarded.data?.['step']]).toStrictEqual([
      LOCAL_AGENT_ERROR_CODES.needsPermission,
      { argumentsHash: hashBrowserToolArguments({ action: 'new', url }), tool: 'browser_tabs' },
    ]);

    const token = String(guarded.data?.['stepToken']);

    expect([token === '', created.length, created[0]?.['url'], downloads.cancelled]).toStrictEqual([
      false,
      1,
      'about:blank',
      [71],
    ]);

    const approved = await bridge.callTool('controller-1', { ...params, sensitive: [token] });

    // The repeat redeems the token on the tab the step opened: one tab, and the kept file is the answer.
    expect([created.length, downloads.cancelled]).toStrictEqual([1, [71]]);
    expect(JSON.stringify(approved)).toContain(
      'report.txt: The file was downloaded; the page did not change.'
    );
  });

  it('guards a tabs-new download on a session that already has a tab, so the file is never kept', async () => {
    const downloads = createFakeDownloads();
    // The file the approved repeat keeps, as the browser reports it once it is written.
    downloads.searched.push({ filename: '/home/me/Downloads/report.txt', id: 74 });
    const created: Record<string, unknown>[] = [];
    const openedListeners: ((tab: {
      readonly id?: number;
      readonly openerTabId?: number;
    }) => void)[] = [];
    const newTab = TAB_ID + 8;

    const tabsApi = {
      create: async (properties: { readonly url?: string } = {}) => {
        created.push({ ...properties });

        for (const listener of openedListeners) {
          listener({ id: newTab, openerTabId: TAB_ID });
        }

        return { id: newTab, title: '', url: properties.url ?? 'about:blank', windowId: 1 };
      },
      get: async (tabId: number) =>
        tabId === newTab
          ? { id: newTab, title: '', url: `${MAIN_ORIGIN}/report.txt`, windowId: 1 }
          : { id: TAB_ID, title: 'Example', url: MAIN_ORIGIN },
      onCreated: {
        addListener: (
          listener: (tab: { readonly id?: number; readonly openerTabId?: number }) => void
        ) => {
          openedListeners.push(listener);
        },
        removeListener: (
          listener: (tab: { readonly id?: number; readonly openerTabId?: number }) => void
        ) => {
          const index = openedListeners.indexOf(listener);

          if (index !== -1) {
            openedListeners.splice(index, 1);
          }
        },
      },
      query: async () => [
        { active: true, id: TAB_ID, title: 'Example', url: MAIN_ORIGIN, windowId: 1 },
      ],
    };
    // The session already has its tab: only the guard's own window can stop the new tab's file.
    const { controller } = createGroups();
    const { cdp, runtime } = await createHarness({
      downloadsApi: downloads.api,
      tabGroups: controller,
      tabsApi,
    });

    let navigating = true;

    cdp.setHandlers({
      'Page.navigate': () => {
        if (navigating) {
          navigating = false;
          downloads.emit({ id: 73, tabId: newTab });
        }

        return { errorText: 'net::ERR_ABORTED' };
      },
    });

    const bridge = createRuntimeBrowserBridge({ runtime: () => runtime });
    const url = `${MAIN_ORIGIN}/report.txt`;

    const guarded = await refusalOf(
      bridge.callTool('controller-1', {
        arguments: { action: 'new', url },
        authorized: [readGrant, actGrant, { class: 'navigate' as const, origin: MAIN_ORIGIN }],
        name: 'browser_tabs',
        sessionHandle: 'session-1',
      })
    );

    // The tab opens blank and the navigate runs under the guard: nothing is created at the destination.
    expect([guarded.code, created.length, created[0]?.['url']]).toStrictEqual([
      LOCAL_AGENT_ERROR_CODES.needsPermission,
      1,
      'about:blank',
    ]);
    // The file is cancelled before it is written, so the folder keeps nothing and nothing is named as saved.
    expect([
      downloads.cancelled,
      downloads.removed,
      guarded.message.includes('already saved'),
    ]).toStrictEqual([[73], [], false]);

    // The repeat carries the token even though the session now holds the opened tab: it keeps the file there.
    const approved = await bridge.callTool('controller-1', {
      arguments: { action: 'new', url },
      authorized: [readGrant, actGrant, { class: 'navigate' as const, origin: MAIN_ORIGIN }],
      name: 'browser_tabs',
      sensitive: [String(guarded.data?.['stepToken'])],
      sessionHandle: 'session-1',
    });

    expect([created.length, downloads.cancelled]).toStrictEqual([1, [73]]);
    expect(JSON.stringify(approved)).toContain(
      'report.txt: The file was downloaded; the page did not change.'
    );
  });

  it('matches an announcement to its own item, never by order', async () => {
    const downloads = createFakeDownloads();
    const { cdp, runtime } = await createHarness({ downloadsApi: downloads.api });
    let announced = true;

    // The click's own command announces a download the browser has not created yet.
    cdp.setHandlers({
      'Input.dispatchMouseEvent': () => {
        if (announced) {
          announced = false;
          cdp.emit('Browser.downloadWillBegin', {
            guid: 'late-one',
            suggestedFilename: 'one.txt',
            url: `${MAIN_ORIGIN}/one.txt`,
          });
        }

        return {};
      },
    });

    const shot = () =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant] },
        arguments: {},
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_take_screenshot',
      });

    vi.useFakeTimers();

    try {
      const clicked = await runTimed(
        runtime.runTool({
          agent: { authorized: [readGrant, actGrant] },
          arguments: { target: '#pay' },
          caller: agent(),
          tabId: TAB_ID,
          toolName: 'browser_click',
        }),
        500
      );

      // The call reports the announcement itself; the item it promised lands later.
      expect(clicked).toMatchObject({ afterAction: true, kind: 'needs_permission' });

      // A second file nothing announced lands first: it must not consume the announcement's report.
      downloads.emit({ id: 151, tabId: TAB_ID, url: `${MAIN_ORIGIN}/two.txt` });
      downloads.emit({ id: 150, tabId: TAB_ID, url: `${MAIN_ORIGIN}/one.txt` });
      await vi.advanceTimersByTimeAsync(0);

      const reported = await runTimed(shot(), 400);

      if (reported.kind !== 'needs_permission') {
        throw new Error(`expected the unannounced file to be reported, got ${reported.kind}`);
      }

      const message = reported.result.ok ? '' : reported.result.error;

      // The unannounced file is named; the announced one was reported by its own call and is not named twice.
      expect(message).toContain('two.txt');
      expect(message).not.toContain('one.txt');
      // Both files were stopped, each once.
      expect(downloads.cancelled).toStrictEqual([151, 150]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles a closed session\u2019s late download instead of reporting it to the next session', async () => {
    const { controller } = createGroups();
    const downloads = createFakeDownloads();
    const { cdp, runtime } = await createHarness({
      downloadsApi: downloads.api,
      share: false,
      tabGroups: controller,
    });

    cdp.setHandlers({ 'Input.dispatchMouseEvent': () => ({}) });

    vi.useFakeTimers();

    try {
      await runtime.openSession({
        controllerId: 'controller-1',
        sessionHandle: 'session-1',
        title: 'Work',
      });
      await runtime.shareActiveTab({ sessionHandle: 'session-1' });

      await runTimed(
        runtime.runTool({
          agent: { authorized: [readGrant, actGrant] },
          arguments: { target: '#pay' },
          caller: agent(),
          tabId: TAB_ID,
          toolName: 'browser_click',
        })
      );
      cdp.emit('Browser.downloadWillBegin', {
        guid: 'late-closed',
        suggestedFilename: 'late.txt',
        url: `${MAIN_ORIGIN}/late.txt`,
      });
      await vi.advanceTimersByTimeAsync(0);

      // The session ends with a download still owed: there is no model left to tell, and its token died with it.
      runtime.disposeCaller(agent());
      await runtime.closeSession({ sessionHandle: 'session-1' });

      // The next session takes the tab: nothing the closed one stopped is its to answer for.
      await runtime.openSession({
        controllerId: 'controller-2',
        sessionHandle: 'session-2',
        title: 'Next',
      });
      await runtime.shareActiveTab({ sessionHandle: 'session-2' });

      const next = await runTimed(
        runtime.runTool({
          agent: { authorized: [readGrant, actGrant] },
          arguments: {},
          caller: agent('session-2'),
          tabId: TAB_ID,
          toolName: 'browser_snapshot',
        }),
        0
      );

      expect(next).toMatchObject({ kind: 'result', result: { ok: true } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('pays the announce grace, not the whole poll bound, for a download the browser does not name', async () => {
    const downloads = createFakeDownloads();
    const { cdp, runtime } = await createHarness({ downloadsApi: downloads.api });

    cdp.setHandlers({
      'Input.dispatchMouseEvent': () => {
        // The tab announces a download the browser never names: the guard waits the short grace for the item.
        cdp.emit('Browser.downloadWillBegin', {
          guid: 'download-81',
          suggestedFilename: 'slow.bin',
          url: `${MAIN_ORIGIN}/slow.bin`,
        });

        return {};
      },
    });

    vi.useFakeTimers();

    try {
      const call = runtime.runTool({
        agent: { authorized: [readGrant, actGrant] },
        arguments: { target: '#pay' },
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_click',
      });

      // The announce grace is 250 ms; the whole bound is 1.2 s. The call settles inside the grace — with the
      // Grace unreachable this await never resolves under fake timers, and the test fails on its own timeout.
      await vi.advanceTimersByTimeAsync(400);

      await expect(call).resolves.toMatchObject({ afterAction: true, kind: 'needs_permission' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('disarms the guard when the tool fails', async () => {
    const downloads = createFakeDownloads();
    const { cdp, runtime } = await createHarness({ downloadsApi: downloads.api });

    cdp.setHandlers({
      'Input.dispatchMouseEvent': () => {
        throw new Error('browser refused the click');
      },
    });

    const outcome = await runtime.runTool({
      agent: { authorized: [readGrant, actGrant] },
      arguments: { target: '#pay' },
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_click',
    });

    // The dispatch refused the command and the call reported it; the guard still comes off, and the linger
    // (armed because the call started no download) releases its listener on its own.
    expect(outcome).toMatchObject({ kind: 'result', result: { ok: false } });
    await vi.waitFor(
      () => {
        expect(downloads.live()).toBe(0);
      },
      { timeout: 4000 }
    );
  });

  it('reads the downloads permission on every call, so a grant after construction counts', async () => {
    const downloads = createFakeDownloads();
    const holder: { api?: BrowserDownloadsApi } = {};

    const { cdp, runtime } = await createHarness({ downloadsResolver: () => holder.api });
    let emitting = true;

    cdp.setHandlers({
      'Input.dispatchMouseEvent': () => {
        if (emitting) {
          emitting = false;
          downloads.emit({ id: 45, tabId: TAB_ID });
        }

        return {};
      },
    });

    const click = () =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant] },
        arguments: { target: '#pay' },
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_click',
      });

    // Before the grant the guard is the response interception: the download stream saw nothing.
    await click();
    expect(downloads.cancelled).toStrictEqual([]);

    // The user grants the optional permission while the worker keeps running: the next call uses it.
    holder.api = downloads.api;
    emitting = true;
    await click();
    expect(downloads.cancelled).toStrictEqual([45]);
  });

  it('reports an approved navigate that kept its file as a success, not an aborted page load', async () => {
    const downloads = createFakeDownloads();
    downloads.searched.push({ filename: '/home/me/Downloads/report.txt', id: 51 });
    const { cdp, runtime } = await createHarness({ downloadsApi: downloads.api });

    cdp.setHandlers({
      // The browser answers a download navigation with an aborted page load and the tab never moves.
      'Page.navigate': () => ({ errorText: 'net::ERR_ABORTED' }),
    });

    const navigate = (sensitive: readonly string[]) =>
      runtime.runTool({
        agent: {
          authorized: [readGrant, { class: 'navigate', origin: MAIN_ORIGIN }],
          sensitive: [...sensitive],
        },
        arguments: { url: `${MAIN_ORIGIN}/invoice.pdf` },
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_navigate',
      });

    const guarded = await navigate([]);

    expect(guarded).toMatchObject({ afterAction: true, kind: 'needs_permission' });
    // The step is the model's own call, never a tab the runtime opened for it.
    expect(guarded).toMatchObject({
      step: {
        argumentsHash: hashBrowserToolArguments({ url: `${MAIN_ORIGIN}/invoice.pdf` }),
        tool: 'browser_navigate',
      },
    });

    // The approved repeat keeps the file: the model must read that as a success that changed no page.
    const approved = await navigate([expectStepToken(guarded)]);

    expect(approved).toMatchObject({ kind: 'result', result: { ok: true } });
    const approvedText =
      approved.kind === 'result' && approved.result.ok ? String(approved.result.value) : '';

    // The success names the file the browser wrote and says the page did not change.
    expect(approvedText).toContain('report.txt');
    expect(approvedText).toContain('The file was downloaded; the page did not change.');
  });

  it('names the requested file when the kept item has no file name yet', async () => {
    const downloads = createFakeDownloads();
    // A download the browser is still writing reports its target directory, which has no last segment to name.
    downloads.searched.push({ filename: '/home/me/Downloads/', id: 53 });
    const { cdp, runtime } = await createHarness({ downloadsApi: downloads.api });

    cdp.setHandlers({ 'Page.navigate': () => ({ errorText: 'net::ERR_ABORTED' }) });

    const navigate = (sensitive: readonly string[]) =>
      runtime.runTool({
        agent: {
          authorized: [readGrant, { class: 'navigate', origin: MAIN_ORIGIN }],
          sensitive: [...sensitive],
        },
        arguments: { url: `${MAIN_ORIGIN}/invoice.pdf` },
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_navigate',
      });

    const guarded = await navigate([]);

    expect(guarded).toMatchObject({ afterAction: true, kind: 'needs_permission' });

    vi.useFakeTimers();

    try {
      const pending = navigate([expectStepToken(guarded)]);

      // The browser never finishes naming the item inside the window, so the request itself names the file.
      await vi.advanceTimersByTimeAsync(4000);
      const approved = await pending;

      expect(approved).toMatchObject({ kind: 'result', result: { ok: true } });

      const approvedText =
        approved.kind === 'result' && approved.result.ok ? String(approved.result.value) : '';

      // Never a blank name: the model can still find the file the navigate kept.
      expect(approvedText).toContain('invoice.pdf');
      expect(approvedText).toContain('The file was downloaded; the page did not change.');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the aborted page-load error for an approved navigate that downloaded nothing', async () => {
    const downloads = createFakeDownloads();
    const { cdp, runtime } = await createHarness({ downloadsApi: downloads.api });
    let announcing = true;

    cdp.setHandlers({
      'Page.navigate': () => {
        // The first navigate starts a download, so it earns a token; the approved repeat starts none.
        if (announcing) {
          announcing = false;
          downloads.emit({ id: 52, tabId: TAB_ID });
        }

        return { errorText: 'net::ERR_ABORTED' };
      },
    });

    const navigate = (sensitive: readonly string[]) =>
      runtime.runTool({
        agent: {
          authorized: [readGrant, { class: 'navigate', origin: MAIN_ORIGIN }],
          sensitive: [...sensitive],
        },
        arguments: { url: `${MAIN_ORIGIN}/invoice.pdf` },
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_navigate',
      });

    const guarded = await navigate([]);
    const approved = await navigate([expectStepToken(guarded)]);

    // The token was consumed: the approved repeat runs unguarded, so no second guard was armed to hide a broken approval.
    expect(cdp.downloadsDenied()).toBe(1);
    // No download was found, so the browser's own failure stands: an aborted load for another reason is not a success.
    expect(approved).toMatchObject({ kind: 'result', result: { ok: false } });
    expect(
      approved.kind === 'result' && !approved.result.ok ? approved.result.error : ''
    ).toContain('ERR_ABORTED');
  });

  it('does not let one session\u2019s download token approve another session\u2019s call', async () => {
    const { controller } = createGroups();
    const { cdp, runtime } = await createHarness({ share: false, tabGroups: controller });
    // Chrome names every download with its own guid, so each click's announcement is a new download.
    let announced = 0;

    for (const sessionHandle of ['session-1', 'session-2']) {
      // eslint-disable-next-line no-await-in-loop -- one session per open, in order
      await runtime.openSession({ controllerId: 'controller-1', sessionHandle, title: 'Work' });
    }

    cdp.setHandlers({
      'Input.dispatchMouseEvent': () => {
        announced += 1;
        cdp.emit('Browser.downloadWillBegin', {
          guid: `download-7-${String(announced)}`,
          suggestedFilename: 'invoice.pdf',
          url: `${MAIN_ORIGIN}/invoice.pdf`,
        });

        return {};
      },
    });

    const click = async (sessionHandle: string, sensitive: readonly string[] = []) => {
      const caller = { controllerId: 'controller-1', kind: 'agent' as const, sessionHandle };

      // A tab sits in one session's group at a time: the calling session shares it into its own group first.
      await runtime.shareActiveTab({ sessionHandle, tabId: TAB_ID });

      try {
        return await runtime.runTool({
          agent: { authorized: [readGrant, actGrant], sensitive: [...sensitive] },
          arguments: { target: '#pay' },
          caller,
          tabId: TAB_ID,
          toolName: 'browser_click',
        });
      } finally {
        // The bridge releases at call end; without it the next session would wait for this lease.
        runtime.releaseCaller(caller);
      }
    };

    const token = expectStepToken(await click('session-1'));

    // The other session presents the token: it does not match, so the call is guarded again.
    await expect(click('session-2', [token])).resolves.toMatchObject({
      afterAction: true,
      kind: 'needs_permission',
    });
    expect(cdp.downloadsDenied()).toBe(2);

    // A mismatch burns the token by design (a replay must not probe a valid binding), so even its owner is guarded again.
    const ownerRetry = await click('session-1', [token]);

    expect(ownerRetry).toMatchObject({ afterAction: true, kind: 'needs_permission' });

    // A fresh approval for that session still buys exactly one unguarded run; the guard denied every refused call.
    await expect(click('session-1', [expectStepToken(ownerRetry)])).resolves.toMatchObject({
      kind: 'result',
    });
    expect(cdp.downloadsDenied()).toBe(3);
  });

  it('does not refuse an act call for a download an earlier call started', async () => {
    const { cdp, runtime } = await createHarness();

    cdp.setHandlers({
      // A read tool starts no download, so its stale event must not be charged to the next call.
      'Accessibility.getFullAXTree': () => {
        cdp.emit('Browser.downloadWillBegin', {
          guid: 'download-8',
          suggestedFilename: 'old.pdf',
          url: `${MAIN_ORIGIN}/old.pdf`,
        });

        return MAIN_TREE;
      },
    });

    const snapshot = await runtime.runTool({
      agent: { authorized: [readGrant] },
      arguments: {},
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_snapshot',
    });

    expect(snapshot.kind).toBe('result');

    // The snapshot left a download event behind; this call started none of its own.
    const click = await runtime.runTool({
      agent: { authorized: [readGrant, actGrant] },
      arguments: { target: '#pay' },
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_click',
    });

    expect(click.kind).toBe('result');
  });

  it('refuses an agent call before any session opened a group', async () => {
    const { runtime } = await createHarness({ share: false });

    // There is nothing to compare against only when no session exists; that is no exemption (D9).
    await expect(
      runtime.runTool({
        agent: { authorized: [readGrant] },
        arguments: {},
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_snapshot',
      })
    ).resolves.toStrictEqual({
      kind: 'result',
      result: { error: AGENT_TAB_OUTSIDE_GROUP_ERROR, ok: false },
    });

    // Another session's group is not this session's reach either.
    await runtime.openSession({
      controllerId: 'controller-2',
      sessionHandle: 'session-2',
      title: 'Other',
    });
    await runtime.shareActiveTab({ sessionHandle: 'session-2', tabId: TAB_ID });
    await runtime.openSession({
      controllerId: 'controller-1',
      sessionHandle: 'session-1',
      title: 'Work',
    });

    await expect(
      runtime.runTool({
        agent: { authorized: [readGrant] },
        arguments: {},
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_snapshot',
      })
    ).resolves.toStrictEqual({
      kind: 'result',
      result: { error: AGENT_TAB_OUTSIDE_GROUP_ERROR, ok: false },
    });
  });

  it('opens a session tab inactive in the last focused window and groups it', async () => {
    const created: Record<string, unknown>[] = [];
    const updates: { readonly groupId: number; readonly props: Record<string, unknown> }[] = [];
    const controller = createBrowserTabGroupController({
      api: {
        group: async () => 42,
        tabQuery: async () => [{ active: true, id: TAB_ID, windowId: 1 }],
        update: async (groupId, props) => {
          updates.push({ groupId, props });
        },
      },
    });
    const runtime = createBrowserRuntime({
      debuggerApi: createFakeCdp().api,
      leases: createTabLeaseRegistry({}),
      scriptingApi: undefined,
      tabGroups: controller,
      tabsApi: {
        create: async properties => {
          created.push({ ...properties });

          return { id: 88, title: '', url: properties.url ?? 'about:blank', windowId: 1 };
        },
        get: async tabId => {
          if (tabId !== 88) {
            return { id: TAB_ID, title: 'Example', url: MAIN_ORIGIN };
          }

          const url = z.string().safeParse(created[0]?.['url']);

          return { id: 88, title: '', url: url.success ? url.data : '', windowId: 1 };
        },
        query: async () => [
          { active: true, id: TAB_ID, title: 'Example', url: MAIN_ORIGIN, windowId: 1 },
        ],
      },
    });

    await runtime.openSession({
      controllerId: 'controller-1',
      sessionHandle: 'session-1',
      title: 'Work',
    });

    // The tab opens blank: the call navigates it, so the download guard is armed before any request leaves.
    await expect(runtime.openSessionTab({ sessionHandle: 'session-1' })).resolves.toStrictEqual({
      groupId: 42,
      tabId: 88,
      title: '',
      url: 'about:blank',
    });

    // Inactive, in the window the user is looking at: the agent never takes the foreground tab.
    expect(created).toStrictEqual([{ active: false, url: 'about:blank', windowId: 1 }]);
    expect(controller.tabsForSession('session-1')).toStrictEqual([88]);
    expect(controller.listSessions()[0]?.groupId).toBe(42);
    expect(updates).toContainEqual({
      groupId: 42,
      props: { color: 'grey', title: 'Kilo · Work' },
    });
  });

  it('reaches the blank tab a session opened, which no host permission covers', async () => {
    const cdp = createFakeCdp();
    const controller = createBrowserTabGroupController({
      api: {
        group: async () => 42,
        tabQuery: async () => [{ active: true, id: TAB_ID, windowId: 1 }],
        update: async () => {},
      },
    });
    // A tab no host permission covers reports no url at all, which is every `about:blank` tab an agent opens.
    const blank: BrowserTabInfo = { id: 88, title: '' };
    const runtime = createBrowserRuntime({
      debuggerApi: cdp.api,
      leases: createTabLeaseRegistry({}),
      scriptingApi: undefined,
      tabGroups: controller,
      tabsApi: {
        create: async () => blank,
        get: async () => blank,
        query: async () => [{ active: true, id: TAB_ID, windowId: 1 }],
      },
    });

    await runtime.openSession({
      controllerId: 'controller-1',
      sessionHandle: 'session-1',
      title: 'Work',
    });
    await expect(runtime.openSessionTab({ sessionHandle: 'session-1' })).resolves.toMatchObject({
      tabId: 88,
    });

    // The tab's document really is blank, which is the evidence the voucher is judged by.
    cdp.setFrameUrl('about:blank');

    const outcome = await runtime.runTool({
      agent: { authorized: [readGrant] },
      arguments: {},
      caller: agent(),
      tabId: 88,
      toolName: 'browser_snapshot',
    });

    // The precheck would refuse a tab with no readable url as browser-internal; the attach runs instead.
    expect(cdp.commands().length).toBeGreaterThan(0);
    expect(JSON.stringify(outcome)).not.toContain('not inspectable');
  });

  it('applies the inspectability precheck once the session tab has a page', async () => {
    const cdp = createFakeCdp();
    const { controller } = createGroups();
    const urls = new Map<number, string>([[88, '']]);

    const runtime = createBrowserRuntime({
      debuggerApi: cdp.api,
      leases: createTabLeaseRegistry({}),
      scriptingApi: undefined,
      tabGroups: controller,
      tabsApi: {
        create: async () => ({ id: 88, title: '' }),
        get: async tabId => ({ id: tabId, title: '', url: urls.get(tabId) ?? '' }),
        query: async () => [
          { active: true, id: TAB_ID, title: 'Example', url: MAIN_ORIGIN, windowId: 1 },
        ],
      },
    });
    const snapshot = () =>
      runtime.runTool({
        agent: { authorized: [readGrant] },
        arguments: {},
        caller: agent(),
        tabId: 88,
        toolName: 'browser_snapshot',
      });

    await runtime.openSession({
      controllerId: 'controller-1',
      sessionHandle: 'session-1',
      title: 'Work',
    });
    await runtime.openSessionTab({ sessionHandle: 'session-1' });
    // The tab is the blank document it opened with, which is what keeps the voucher alive.
    cdp.setFrameUrl('about:blank');

    expect(JSON.stringify(await snapshot())).not.toContain('not inspectable');

    // The tab settled on a browser-internal page: it is an ordinary tab now, so the precheck judges it like one.
    urls.set(88, 'chrome://settings');
    cdp.setFrameUrl('chrome://settings');

    expect(JSON.stringify(await snapshot())).toContain('not inspectable');
  });

  it('drops the blank-tab exemption when the session tab closes', async () => {
    const cdp = createFakeCdp();
    const { controller } = createGroups();
    let alive = true;

    const runtime = createBrowserRuntime({
      debuggerApi: cdp.api,
      leases: createTabLeaseRegistry({}),
      scriptingApi: undefined,
      tabGroups: controller,
      tabsApi: {
        create: async () => ({ id: 88, title: '' }),
        get: async tabId => {
          if (!alive) {
            throw new Error(`No tab with id: ${String(tabId)}.`);
          }

          return { id: tabId, title: '', url: '' };
        },
        query: async () => [
          { active: true, id: TAB_ID, title: 'Example', url: MAIN_ORIGIN, windowId: 1 },
        ],
      },
    });

    await runtime.openSession({
      controllerId: 'controller-1',
      sessionHandle: 'session-1',
      title: 'Work',
    });
    await runtime.openSessionTab({ sessionHandle: 'session-1' });
    alive = false;

    const refused = await runtime.runTool({
      agent: { authorized: [readGrant] },
      arguments: {},
      caller: agent(),
      tabId: 88,
      toolName: 'browser_snapshot',
    });

    // A closed tab is not a blank one: the precheck answers instead of an attach against a dead target.
    expect(JSON.stringify(refused)).toContain('not inspectable');
  });

  it('stops vouching for a tab once the session that opened it ends', async () => {
    const cdp = createFakeCdp();
    const { controller } = createGroups();

    const runtime = createBrowserRuntime({
      debuggerApi: cdp.api,
      leases: createTabLeaseRegistry({}),
      scriptingApi: undefined,
      tabGroups: controller,
      tabsApi: {
        create: async () => ({ id: 88, title: '' }),
        get: async tabId => ({ id: tabId, title: '', url: '' }),
        query: async () => [
          { active: true, id: TAB_ID, title: 'Example', url: MAIN_ORIGIN, windowId: 1 },
        ],
      },
    });

    await runtime.openSession({
      controllerId: 'controller-1',
      sessionHandle: 'session-1',
      title: 'Work',
    });
    await runtime.openSessionTab({ sessionHandle: 'session-1' });
    await runtime.closeSession({ sessionHandle: 'session-1' });

    // The tab's own document is still blank and the browser withholds its url, so only the ended session can end
    // The voucher. A panel caller is in no group, which keeps the ended session itself what this call reads.
    cdp.setFrameUrl('about:blank');

    const refused = await runtime.runTool({
      arguments: {},
      caller: { conversationId: 'conversation-a', kind: 'panel', panelId: 'panel-1' },
      tabId: 88,
      toolName: 'browser_snapshot',
    });

    expect(JSON.stringify(refused)).toContain('not inspectable');
  });

  it('stops vouching for a session tab whose document committed a page the browser will not name', async () => {
    const cdp = createFakeCdp();
    const { controller } = createGroups();

    const runtime = createBrowserRuntime({
      debuggerApi: cdp.api,
      leases: createTabLeaseRegistry({}),
      scriptingApi: undefined,
      tabGroups: controller,
      tabsApi: {
        create: async () => ({ id: 88, title: '' }),
        // Without the `tabs` permission Chrome reports no url for a `chrome://` page.
        get: async tabId => ({ id: tabId, title: '', url: '' }),
        query: async () => [
          { active: true, id: TAB_ID, title: 'Example', url: MAIN_ORIGIN, windowId: 1 },
        ],
      },
    });

    await runtime.openSession({
      controllerId: 'controller-1',
      sessionHandle: 'session-1',
      title: 'Work',
    });
    await runtime.openSessionTab({ sessionHandle: 'session-1' });
    // The tab committed a page the extension may not read: the debugger's frame URL is the evidence `tabs.Tab` withholds.
    cdp.setFrameUrl('chrome://settings');

    const refused = await runtime.runTool({
      arguments: {},
      caller: { conversationId: 'conversation-a', kind: 'panel', panelId: 'panel-1' },
      tabId: 88,
      takeOver: true,
      toolName: 'browser_snapshot',
    });

    expect(JSON.stringify(refused)).toContain('not inspectable');
  });

  it('reports no session tab when the browser cannot create tabs', async () => {
    const { runtime } = await createHarness({ share: false });

    await runtime.openSession({
      controllerId: 'controller-1',
      sessionHandle: 'session-1',
      title: 'Work',
    });

    await expect(runtime.openSessionTab({ sessionHandle: 'session-1' })).resolves.toBeUndefined();
  });

  it('keeps a session to its own tab group', async () => {
    const { controller } = createGroups();
    const { runtime } = await createHarness({ share: false, tabGroups: controller });

    await runtime.openSession({
      controllerId: 'controller-1',
      sessionHandle: 'session-1',
      title: 'Work',
    });

    // Nothing shared yet: the agent's tab id is outside its group.
    await expect(
      runtime.runTool({
        agent: { authorized: [readGrant] },
        arguments: {},
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_snapshot',
      })
    ).resolves.toMatchObject({ kind: 'result', result: { ok: false } });

    await expect(runtime.shareActiveTab({ sessionHandle: 'session-1' })).resolves.toStrictEqual({
      groupId: 42,
      kind: 'shared',
      tabId: TAB_ID,
    });

    await expect(
      runtime.runTool({
        agent: { authorized: [readGrant] },
        arguments: {},
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_snapshot',
      })
    ).resolves.toMatchObject({ kind: 'result', result: { ok: true } });
  });

  it('adds a tab opened from a session tab to that session', async () => {
    const { controller } = createGroups();
    const { runtime } = await createHarness({ share: false, tabGroups: controller });

    await runtime.openSession({
      controllerId: 'controller-1',
      sessionHandle: 'session-1',
      title: 'Work',
    });
    await runtime.shareActiveTab({ sessionHandle: 'session-1' });

    await runtime.noteTabCreated(8, TAB_ID);
    await runtime.noteTabCreated(9, 999);

    expect(controller.tabsForSession('session-1')).toStrictEqual([TAB_ID, 8]);
  });

  it('creates the session group with a tab opened before any tab was shared', async () => {
    const updates: { readonly groupId: number; readonly props: Record<string, unknown> }[] = [];
    const groupCalls: { readonly groupId?: number; readonly tabIds: readonly number[] }[] = [];
    const controller = createBrowserTabGroupController({
      api: {
        group: failFirstGroupCall(groupCalls),
        tabQuery: async () => [{ active: true, id: TAB_ID }],
        update: async (groupId, props) => {
          updates.push({ groupId, props });
        },
      },
    });
    const { runtime } = await createHarness({ share: false, tabGroups: controller });

    await runtime.openSession({
      controllerId: 'controller-1',
      sessionHandle: 'session-1',
      title: 'Work',
    });
    await runtime.shareActiveTab({ sessionHandle: 'session-1' });

    expect(controller.listSessions()[0]?.groupId).toBeUndefined();

    await runtime.noteTabCreated(8, TAB_ID);

    // The group was created from the session's own tab plus the opened one.
    expect(groupCalls).toStrictEqual([{ tabIds: [TAB_ID] }, { groupId: 42, tabIds: [8] }]);
    expect(controller.tabsForSession('session-1')).toStrictEqual([TAB_ID, 8]);
    expect(controller.listSessions()[0]?.groupId).toBe(42);
    expect(updates).toContainEqual({ groupId: 42, props: { color: 'grey', title: 'Kilo · Work' } });
  });

  it('ends the group as `Kilo · ended` and stops targeting its tabs', async () => {
    const { controller, updates } = createGroups();
    const { runtime } = await createHarness({ share: false, tabGroups: controller });

    await runtime.openSession({
      controllerId: 'controller-1',
      sessionHandle: 'session-1',
      title: 'Work',
    });
    await runtime.shareActiveTab({ sessionHandle: 'session-1' });

    await runtime.closeSession({ sessionHandle: 'session-1' });

    expect(updates.at(-1)).toStrictEqual({
      groupId: 42,
      props: { collapsed: true, color: 'grey', title: 'Kilo · ended' },
    });
    expect(runtime.listSessions()).toStrictEqual([
      { ended: true, groupId: 42, sessionHandle: 'session-1', tabs: [TAB_ID], title: 'Work' },
    ]);

    // An ended session's tabs stay in the grey group but are no longer targetable.
    await expect(
      runtime.runTool({
        agent: { authorized: [readGrant] },
        arguments: {},
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_snapshot',
      })
    ).resolves.toMatchObject({ kind: 'result', result: { ok: false } });
  });

  it('serves a session from a restarted worker on the tab its group had', async () => {
    // `storage.session` as both workers share it.
    const store: { sessions?: PersistedTabGroupSession[] } = {};
    const persistence: BrowserTabGroupPersistence = {
      read: async () => store.sessions,
      write: async sessions => {
        store.sessions = [...sessions];
      },
    };
    const groupsOfWorker = () =>
      createBrowserTabGroupController({
        api: { tabQuery: async () => [{ active: true, id: TAB_ID }] },
        persistence,
      });
    const before = await createHarness({ share: false, tabGroups: groupsOfWorker() });
    const first = createRuntimeBrowserBridge({ runtime: () => before.runtime });

    await first.openSession({
      controllerId: 'controller-1',
      sessionHandle: 'session-1',
      title: 'Work',
    });
    await first.shareActiveTab({ controllerId: 'controller-1', sessionHandle: 'session-1' });
    await vi.waitFor(() => {
      expect(store.sessions?.[0]?.tabs).toStrictEqual([TAB_ID]);
    });

    // The worker stops: nothing in memory survives, storage.session does.
    const after = await createHarness({ share: false, tabGroups: groupsOfWorker() });
    const second = createRuntimeBrowserBridge({ runtime: () => after.runtime });
    const snapshot = await second.callTool('controller-1', {
      arguments: {},
      authorized: [readGrant],
      name: 'browser_snapshot',
      sessionHandle: 'session-1',
    });

    expect(snapshot).toMatchObject({ content: [{ type: 'text' }] });
    expect(after.runtime.listSessions()).toStrictEqual([
      { ended: false, sessionHandle: 'session-1', tabs: [TAB_ID], title: 'Work' },
    ]);
  });

  it('restores a session without the tab that closed while no worker ran', async () => {
    const stored: PersistedTabGroupSession[] = [
      { ended: false, groupId: 42, sessionHandle: 'session-1', tabs: [TAB_ID, 99], title: 'Work' },
    ];
    const tab: BrowserTabInfo = { id: TAB_ID, title: 'Example', url: `${MAIN_ORIGIN}/dashboard` };
    const { runtime } = await createHarness({
      share: false,
      tabGroups: createBrowserTabGroupController({
        api: {},
        persistence: { read: async () => stored, write: async () => {} },
      }),
      tabsApi: {
        get: async tabId => {
          if (tabId !== TAB_ID) {
            throw new Error(`No tab with id: ${tabId}.`);
          }

          return tab;
        },
        query: async () => [tab],
      },
    });

    await runtime.restoreSessions();

    expect(runtime.listSessions()).toStrictEqual([
      { ended: false, groupId: 42, sessionHandle: 'session-1', tabs: [TAB_ID], title: 'Work' },
    ]);
  });

  it('reads the stored sessions again after a failed read', async () => {
    const stored: PersistedTabGroupSession[] = [
      { ended: false, groupId: 42, sessionHandle: 'session-1', tabs: [TAB_ID], title: 'Work' },
    ];
    let readable = false;
    const tab: BrowserTabInfo = { id: TAB_ID, title: 'Example', url: `${MAIN_ORIGIN}/dashboard` };
    const { runtime } = await createHarness({
      share: false,
      tabGroups: createBrowserTabGroupController({
        api: {},
        persistence: {
          read: () =>
            readable ? Promise.resolve(stored) : Promise.reject(new Error('storage busy')),
          write: async () => {},
        },
      }),
      tabsApi: { get: async () => tab, query: async () => [tab] },
    });

    await runtime.restoreSessions();
    expect(runtime.listSessions()).toStrictEqual([]);

    readable = true;
    await runtime.restoreSessions();
    expect(runtime.listSessions()).toStrictEqual([
      { ended: false, groupId: 42, sessionHandle: 'session-1', tabs: [TAB_ID], title: 'Work' },
    ]);
  });

  it('drops console entries whose source is a withheld frame origin', async () => {
    const { cdp, runtime } = await createHarness();

    // The tab's session subscribes to the debugger events on its first call.
    await runtime.runTool({
      agent: { authorized: [readGrant] },
      arguments: {},
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_snapshot',
    });

    cdp.emit('Log.entryAdded', {
      entry: {
        level: 'error',
        text: 'frame secret',
        timestamp: Date.now(),
        url: `${FRAME_ORIGIN}/widget.js`,
      },
    });
    cdp.emit('Log.entryAdded', {
      entry: {
        level: 'error',
        text: 'page error',
        timestamp: Date.now(),
        url: `${MAIN_ORIGIN}/app.js`,
      },
    });

    const outcome = await runtime.runTool({
      agent: { authorized: [readGrant] },
      arguments: { all: true, level: 'info' },
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_console_messages',
    });

    const { result } = expectResult(outcome, `expected console output: ${JSON.stringify(outcome)}`);
    const text = String(result.value);

    expect(text).toContain('page error');
    expect(text).not.toContain('frame secret');
  });

  it('runs browser_evaluate through the tab debugger, never an extension-privileged context', async () => {
    const { cdp, runtime } = await createHarness();

    const outcome = await runtime.runTool({
      agent: { authorized: [readGrant, actGrant] },
      arguments: { function: '() => document.title' },
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_evaluate',
    });

    expect(outcome.kind).toBe('result');
    expect(cdp.commands()).toContain('Runtime.evaluate');
  });

  it('offers no cookie or storage tool to an agent', async () => {
    const { BROWSER_TOOL_CONTRACT } = await import('./browser-tool-contract');
    const names = BROWSER_TOOL_CONTRACT.map(entry => entry.name);

    expect(
      names.filter(name => /cookie|storage|localStorage|sessionStorage/u.test(name))
    ).toStrictEqual([]);
  });

  it('keeps the panel caller unfiltered: its snapshot includes the iframe content', async () => {
    const { runtime } = await createHarness({ share: false });

    const outcome = await runtime.runTool({
      arguments: {},
      caller: { conversationId: 'conversation-a', kind: 'panel', panelId: 'panel-1' },
      tabId: TAB_ID,
      toolName: 'browser_snapshot',
    });

    const { result, withheldFrames } = expectResult(outcome, 'expected a snapshot result');

    expect(String(result.value)).toContain('leaked frame text');
    expect(withheldFrames).toBeUndefined();
    expect(ORIGIN_CHANGED_ERROR).toBeTruthy();
  });
});

/** Page commands the renderer cannot answer while a JavaScript dialog is open, as measured on Chromium. */
const RENDERER_COMMANDS = [
  'Accessibility.getFullAXTree',
  'DOM.describeNode',
  'DOM.getBoxModel',
  'DOM.getDocument',
  'DOM.querySelectorAll',
  'DOM.resolveNode',
  'DOM.scrollIntoViewIfNeeded',
  'Emulation.setFocusEmulationEnabled',
  'Page.captureScreenshot',
  'Page.getFrameTree',
  'Page.getLayoutMetrics',
  'Runtime.callFunctionOn',
  'Runtime.evaluate',
  'Target.setAutoAttach',
] as const;

/**
 * Chrome around a JavaScript dialog: the page opens it from a click's handler
 * (or, with `opener`, from another command), and from then on neither that
 * command nor any renderer command answers until `Page.handleJavaScriptDialog`
 * closes the dialog.
 */
const pageDialog = (
  cdp: FakeCdp,
  dialog: {
    /** `null` emits no frame id, the case where the browser named no frame. */
    readonly frameId?: string | null;
    readonly message: string;
    readonly type: string;
    readonly url?: string;
  },
  opener = 'Input.dispatchMouseEvent'
) => {
  // The dialog the page holds open, closed by its answer.
  const page: { open?: PromiseWithResolvers<void> } = {};
  const answers: Record<string, unknown>[] = [];
  const handlers: Record<string, CdpHandler> = {};
  // Declines to answer itself, so the fake's own answer follows once the dialog is closed.
  const blocked: CdpHandler = async () => {
    await page.open?.promise;
  };

  for (const method of RENDERER_COMMANDS) {
    handlers[method] = blocked;
  }

  handlers[opener] = async params => {
    await page.open?.promise;

    // A click's handler runs on the release; any other opener opens the dialog on its own.
    if (opener === 'Input.dispatchMouseEvent' && params?.['type'] !== 'mouseReleased') {
      return;
    }

    const opened = Promise.withResolvers<void>();

    page.open = opened;
    // Chrome reports the frame that opened the dialog; its origin comes from the frame tree the browser computed.
    const { frameId = 'main', ...rest } = dialog;

    cdp.emit('Page.javascriptDialogOpening', {
      ...(frameId === null ? {} : { frameId }),
      url: `${MAIN_ORIGIN}/dashboard`,
      ...rest,
    });
    await opened.promise;
  };
  handlers['Page.handleJavaScriptDialog'] = params => {
    answers.push(params ?? {});
    cdp.emit('Page.javascriptDialogClosed', { result: params?.['accept'] === true });
    page.open?.resolve();
    delete page.open;

    return {};
  };
  cdp.setHandlers(handlers);

  return { answers, blocked };
};

const ALERT_STATE =
  '### Modal state\n- ["alert" dialog with message "Saved"]: can be handled by browser_handle_dialog';

describe('agent browser calls on a page with a JavaScript dialog', () => {
  const call = (runtime: BrowserRuntime, toolName: string, args: Record<string, unknown> = {}) =>
    runtime.runTool({
      agent: { authorized: [readGrant, actGrant] },
      arguments: args,
      caller: agent(),
      tabId: TAB_ID,
      toolName,
    });

  it('answers a click that opens a dialog with the modal state instead of waiting for the click', async () => {
    const { cdp, runtime } = await createHarness();

    pageDialog(cdp, { message: 'Saved', type: 'alert' });

    await expect(call(runtime, 'browser_click', { target: '#save' })).resolves.toStrictEqual({
      kind: 'result',
      result: { ok: true, value: ALERT_STATE },
    });
  });

  it('refuses every other tool on the tab until the dialog is answered, without touching the page', async () => {
    const { cdp, runtime } = await createHarness();

    pageDialog(cdp, { message: 'Saved', type: 'alert' });
    await call(runtime, 'browser_click', { target: '#save' });
    const sentBefore = cdp.commands().length;

    await expect(call(runtime, 'browser_snapshot')).resolves.toStrictEqual({
      kind: 'result',
      result: {
        error: `Tool "browser_snapshot" does not handle the modal state.\n\n${ALERT_STATE}`,
        ok: false,
      },
    });
    await expect(
      call(runtime, 'browser_navigate', { url: `${MAIN_ORIGIN}/next` })
    ).resolves.toMatchObject({ result: { ok: false } });
    expect(cdp.commands()).toHaveLength(sentBefore);
  });

  it('accepts a prompt with the text given, and the tab takes other tools again', async () => {
    const { cdp, runtime } = await createHarness();
    const dialog = pageDialog(cdp, { message: 'Your name?', type: 'prompt' });

    await call(runtime, 'browser_click', { target: '#ask' });

    await expect(
      call(runtime, 'browser_handle_dialog', { accept: true, promptText: 'Ada' })
    ).resolves.toMatchObject({
      kind: 'result',
      result: { ok: true, value: { accepted: true, type: 'prompt' } },
    });
    expect(dialog.answers).toStrictEqual([{ accept: true, promptText: 'Ada' }]);
    expect(String(expectResult(await call(runtime, 'browser_snapshot')).result.value)).toContain(
      'Pay now'
    );
  });

  it('dismisses a confirm', async () => {
    const { cdp, runtime } = await createHarness();
    const dialog = pageDialog(cdp, { message: 'Delete it?', type: 'confirm' });

    await call(runtime, 'browser_click', { target: '#delete' });

    await expect(call(runtime, 'browser_handle_dialog', { accept: false })).resolves.toMatchObject({
      result: { ok: true, value: { accepted: false, type: 'confirm' } },
    });
    expect(dialog.answers).toStrictEqual([{ accept: false }]);
  });

  it('answers any call during which the page opens a dialog, not only a click', async () => {
    const { cdp, runtime } = await createHarness();

    pageDialog(cdp, { message: 'Saved', type: 'alert' }, 'Accessibility.getFullAXTree');

    await expect(call(runtime, 'browser_snapshot')).resolves.toStrictEqual({
      kind: 'result',
      result: { ok: true, value: ALERT_STATE },
    });
  });

  it('withholds the message of a dialog from a frame the agent may not read', async () => {
    const { cdp, runtime } = await createHarness();

    // The widget frame (f1) is cross-origin and the agent holds no read grant for it.
    pageDialog(cdp, {
      frameId: 'f1',
      message: 'Card declined',
      type: 'alert',
      url: `${FRAME_ORIGIN}/widget`,
    });

    await expect(call(runtime, 'browser_click', { target: '#save' })).resolves.toStrictEqual({
      kind: 'result',
      result: {
        ok: true,
        value:
          '### Modal state\n- ["alert" dialog (message withheld: no read permission for the frame that opened it)]: can be handled by browser_handle_dialog',
      },
    });
  });

  it('withholds the message of an about:blank dialog whose creating frame is cross-origin', async () => {
    const { cdp, runtime } = await createHarness();
    const payOrigin = 'https://pay.example.com';

    pageDialog(
      cdp,
      { frameId: 'blank', message: 'Pay now?', type: 'confirm', url: 'about:blank' },
      'Runtime.evaluate'
    );
    // The browser reports the blank frame's origin as the pay frame's, which is what decides both the reading and the answer.
    cdp.setHandlers({
      'Page.getFrameTree': () => ({
        frameTree: {
          childFrames: [
            { frame: { id: 'pay', securityOrigin: payOrigin, url: `${payOrigin}/checkout` } },
            { frame: { id: 'blank', securityOrigin: payOrigin, url: 'about:blank' } },
          ],
          frame: { id: 'main', securityOrigin: MAIN_ORIGIN, url: `${MAIN_ORIGIN}/dashboard` },
        },
      }),
    });

    await expect(call(runtime, 'browser_click', { target: '#pay' })).resolves.toStrictEqual({
      kind: 'result',
      result: {
        ok: true,
        value:
          '### Modal state\n- ["confirm" dialog (message withheld: no read permission for the frame that opened it)]: can be handled by browser_handle_dialog',
      },
    });
  });

  it('shows an about:blank dialog’s message when its creating frame is an origin the agent may read', async () => {
    const { cdp, runtime } = await createHarness();

    // The blank frame the top page created carries the tab's origin, which the harness's read grant covers.
    pageDialog(
      cdp,
      { frameId: 'blank', message: 'Saved', type: 'alert', url: 'about:blank' },
      'Runtime.evaluate'
    );
    cdp.setHandlers({
      'Page.getFrameTree': () => ({
        frameTree: {
          childFrames: [
            { frame: { id: 'blank', securityOrigin: MAIN_ORIGIN, url: 'about:blank' } },
          ],
          frame: { id: 'main', securityOrigin: MAIN_ORIGIN, url: `${MAIN_ORIGIN}/dashboard` },
        },
      }),
    });

    const shown = await call(runtime, 'browser_click', { target: '#save' });

    expect(shown.kind === 'result' && shown.result.ok ? String(shown.result.value) : '').toContain(
      'dialog with message "Saved"'
    );
  });

  it('judges a dialog answer by the origin of the frame that opened it, not the tab’s document', async () => {
    const { cdp, runtime } = await createHarness();
    const payOrigin = 'https://pay.example.com';

    // A confirm opened by a cross-origin frame: its handler resumes in that frame when answered.
    pageDialog(
      cdp,
      { frameId: 'pay', message: 'Pay now?', type: 'confirm', url: `${payOrigin}/checkout` },
      'Runtime.evaluate'
    );
    cdp.setHandlers({
      'Page.getFrameTree': () => ({
        frameTree: {
          childFrames: [
            { frame: { id: 'pay', securityOrigin: payOrigin, url: `${payOrigin}/checkout` } },
          ],
          frame: { id: 'main', securityOrigin: MAIN_ORIGIN, url: `${MAIN_ORIGIN}/dashboard` },
        },
      }),
    });
    await call(runtime, 'browser_click', { target: '#pay' });

    // The tab's own act grant covers nothing here: the answer acts in the frame's origin.
    await expect(call(runtime, 'browser_handle_dialog', { accept: true })).resolves.toStrictEqual({
      items: [{ class: 'act', origin: payOrigin }],
      kind: 'needs_permission',
      result: {
        error: NEEDS_PERMISSION_ERROR,
        ok: false,
      },
      step: {
        argumentsHash: hashBrowserToolArguments({ accept: true }),
        tool: 'browser_handle_dialog',
      },
    });
  });

  it('answers an about:blank dialog from a frame the top page created with the tab’s own grant', async () => {
    const { cdp, runtime } = await createHarness();

    pageDialog(
      cdp,
      { frameId: 'blank', message: 'Saved', type: 'alert', url: 'about:blank' },
      'Runtime.evaluate'
    );
    // A blank frame the top document created inherits the tab's origin; the browser says so in its frame tree.
    cdp.setHandlers({
      'Page.getFrameTree': () => ({
        frameTree: {
          childFrames: [
            { frame: { id: 'blank', securityOrigin: MAIN_ORIGIN, url: 'about:blank' } },
          ],
          frame: { id: 'main', securityOrigin: MAIN_ORIGIN, url: `${MAIN_ORIGIN}/dashboard` },
        },
      }),
    });
    await call(runtime, 'browser_click', { target: '#save' });

    await expect(call(runtime, 'browser_handle_dialog', { accept: true })).resolves.toMatchObject({
      kind: 'result',
      result: { ok: true, value: { accepted: true, type: 'alert' } },
    });
  });

  it('requires the cross-origin creator’s grant for an about:blank dialog it opened, not the tab’s', async () => {
    const { cdp, runtime } = await createHarness();
    const payOrigin = 'https://pay.example.com';

    pageDialog(
      cdp,
      { frameId: 'blank', message: 'Pay now?', type: 'confirm', url: 'about:blank' },
      'Runtime.evaluate'
    );
    // The pay frame created the blank frame, so the browser reports the blank frame's origin as the pay one.
    cdp.setHandlers({
      'Page.getFrameTree': () => ({
        frameTree: {
          childFrames: [
            { frame: { id: 'pay', securityOrigin: payOrigin, url: `${payOrigin}/checkout` } },
            { frame: { id: 'blank', securityOrigin: payOrigin, url: 'about:blank' } },
          ],
          frame: { id: 'main', securityOrigin: MAIN_ORIGIN, url: `${MAIN_ORIGIN}/dashboard` },
        },
      }),
    });
    await call(runtime, 'browser_click', { target: '#pay' });

    // The tab's act grant covers nothing here: the answer resumes a handler in the pay origin.
    await expect(call(runtime, 'browser_handle_dialog', { accept: true })).resolves.toStrictEqual({
      items: [{ class: 'act', origin: payOrigin }],
      kind: 'needs_permission',
      result: { error: NEEDS_PERMISSION_ERROR, ok: false },
      step: {
        argumentsHash: hashBrowserToolArguments({ accept: true }),
        tool: 'browser_handle_dialog',
      },
    });

    // Granted on the creator's origin, the same answer goes through.
    await expect(
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant, { class: 'act', origin: payOrigin }] },
        arguments: { accept: true },
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_handle_dialog',
      })
    ).resolves.toMatchObject({
      kind: 'result',
      result: { ok: true, value: { accepted: true, type: 'confirm' } },
    });
  });

  it('refuses a dialog whose frame the browser never named, rather than guessing from its url', async () => {
    const { cdp, runtime } = await createHarness();

    pageDialog(
      cdp,
      // A blank url alone would look like the tab's own origin; without the frame it is unknowable.
      { frameId: null, message: 'Saved', type: 'alert', url: 'about:blank' },
      'Runtime.evaluate'
    );
    await call(runtime, 'browser_click', { target: '#save' });

    await expect(call(runtime, 'browser_handle_dialog', { accept: true })).resolves.toMatchObject({
      items: [{ class: 'act', origin: 'opaque:null' }],
      kind: 'needs_permission',
    });
  });

  it('still refuses a dialog from a genuinely opaque frame, which inherits nothing', async () => {
    const { cdp, runtime } = await createHarness();

    pageDialog(cdp, {
      frameId: null,
      message: 'Saved',
      type: 'alert',
      url: 'data:text/html,<p>hi</p>',
    });
    await call(runtime, 'browser_click', { target: '#save' });

    await expect(call(runtime, 'browser_handle_dialog', { accept: true })).resolves.toStrictEqual({
      items: [{ class: 'act', origin: 'opaque:null' }],
      kind: 'needs_permission',
      result: { error: NEEDS_PERMISSION_ERROR, ok: false },
      step: {
        argumentsHash: hashBrowserToolArguments({ accept: true }),
        tool: 'browser_handle_dialog',
      },
    });
  });

  it('answers a dialog a granted frame opened once that frame’s origin is granted', async () => {
    const { cdp, runtime } = await createHarness();
    const payOrigin = 'https://pay.example.com';

    pageDialog(
      cdp,
      { frameId: 'pay', message: 'Pay now?', type: 'confirm', url: `${payOrigin}/checkout` },
      'Runtime.evaluate'
    );
    cdp.setHandlers({
      'Page.getFrameTree': () => ({
        frameTree: {
          childFrames: [
            { frame: { id: 'pay', securityOrigin: payOrigin, url: `${payOrigin}/checkout` } },
          ],
          frame: { id: 'main', securityOrigin: MAIN_ORIGIN, url: `${MAIN_ORIGIN}/dashboard` },
        },
      }),
    });
    await call(runtime, 'browser_click', { target: '#pay' });

    const answered = await runtime.runTool({
      agent: { authorized: [readGrant, actGrant, { class: 'act', origin: payOrigin }] },
      arguments: { accept: true },
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_handle_dialog',
    });

    expect(answered).toMatchObject({
      kind: 'result',
      result: { ok: true, value: { accepted: true, type: 'confirm' } },
    });
  });

  it('tells a safe-mode panel the dialog is the user’s to answer, naming no tool it cannot call', async () => {
    const { cdp, runtime } = await createHarness();

    pageDialog(cdp, { message: 'Saved', type: 'alert' });

    await expect(
      runtime.runTool({
        arguments: { target: '#save' },
        caller: panel(),
        safeMode: true,
        tabId: TAB_ID,
        // The agent session holds this tab, so the panel's call is a take-over first.
        takeOver: true,
        toolName: 'kilo_browser_click',
      })
    ).resolves.toStrictEqual({
      kind: 'result',
      result: {
        ok: true,
        value:
          '### Modal state\n- ["alert" dialog with message "Saved"]: answer it on the page; this mode cannot answer dialogs',
      },
    });
  });

  it('names the panel’s own answering tool to the panel', async () => {
    const { cdp, runtime } = await createHarness();

    pageDialog(cdp, { message: 'Saved', type: 'alert' });

    await expect(
      runtime.runTool({
        arguments: { target: '#save' },
        caller: panel(),
        tabId: TAB_ID,
        // The agent session holds this tab, so the panel's call is a take-over first.
        takeOver: true,
        toolName: 'kilo_browser_click',
      })
    ).resolves.toStrictEqual({
      kind: 'result',
      result: {
        ok: true,
        value:
          '### Modal state\n- ["alert" dialog with message "Saved"]: can be handled by kilo_browser_handle_dialog',
      },
    });
  });

  it('refuses, rather than asks about, a call whose page checks a dialog interrupted', async () => {
    const { cdp, runtime } = await createHarness();

    // The page opens the dialog while the call's own checks read it, before the click runs.
    pageDialog(cdp, { message: 'Saved', type: 'alert' }, 'Runtime.callFunctionOn');

    await expect(call(runtime, 'browser_click', { target: '#save' })).resolves.toStrictEqual({
      kind: 'result',
      result: {
        error: `Tool "browser_click" does not handle the modal state.\n\n${ALERT_STATE}`,
        ok: false,
      },
    });
  });

  it('keeps the approval of a sensitive step that an open dialog refused', async () => {
    const { cdp, runtime } = await createHarness();
    const type = (sensitive: readonly string[]) =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant], sensitive: [...sensitive] },
        arguments: { target: '#cc', text: 'hunter2' },
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_type',
      });

    cdp.setProbe({ fields: [{ kind: 'password' }], paymentFormSubmit: false });
    const stepToken = expectStepToken(await type([]));

    cdp.emit('Page.javascriptDialogOpening', {
      frameId: 'main',
      message: 'Saved',
      type: 'alert',
      url: `${MAIN_ORIGIN}/dashboard`,
    });
    await expect(type([stepToken])).resolves.toMatchObject({ result: { ok: false } });
    await call(runtime, 'browser_handle_dialog', { accept: true });

    // The refusal ran no check, so the approval is still there for the step it was given for.
    await expect(type([stepToken])).resolves.toMatchObject({
      kind: 'result',
      result: { ok: true },
    });
  });

  it('turns frame auto-attach on after a dialog that was open at the session’s first call is answered', async () => {
    const { cdp, runtime } = await createHarness();

    // The panel's snapshot meets the dialog, so the agent's first call finds it open.
    const dialog = pageDialog(
      cdp,
      { message: 'Saved', type: 'alert' },
      'Accessibility.getFullAXTree'
    );
    await runtime.runTool({
      arguments: {},
      caller: panel(),
      tabId: TAB_ID,
      toolName: 'kilo_browser_snapshot',
    });
    runtime.releaseCaller(panel());
    await call(runtime, 'browser_handle_dialog', { accept: true });
    cdp.setHandlers({ 'Accessibility.getFullAXTree': dialog.blocked });
    await call(runtime, 'browser_snapshot');

    expect(cdp.commands().filter(method => method === 'Target.setAutoAttach')).toHaveLength(1);
  });
});

describe('the download hold on a real call', () => {
  /** A hold over the fake downloads, with the reports it queued in order. */
  const holdOver = (downloads: FakeDownloads) => {
    const reports: DownloadHoldReport[] = [];
    const hold = createDownloadHold({
      cancel: async itemId => downloads.api.cancel?.(itemId),
      onReport: report => reports.push(report),
      search: async itemId => (await downloads.api.search?.({ id: itemId })) ?? [],
    });

    return { hold, reports };
  };

  it('names browser_tabs new for a file the step’s own tab started, not the earlier navigate on the caller’s', async () => {
    const downloads = createFakeDownloads();
    const { hold } = holdOver(downloads);
    const openedListeners: ((tab: {
      readonly id?: number;
      readonly openerTabId?: number;
    }) => void)[] = [];
    const created: Record<string, unknown>[] = [];
    const newTab = TAB_ID + 6;
    const url = `${MAIN_ORIGIN}/report.txt`;
    const dashboard = `${MAIN_ORIGIN}/dashboard`;
    const tabsApi = {
      create: async (properties: { readonly url?: string } = {}) => {
        created.push({ ...properties });

        for (const listener of openedListeners) {
          listener({ id: newTab, openerTabId: TAB_ID });
        }

        return { id: newTab, title: '', url: properties.url ?? 'about:blank', windowId: 1 };
      },
      get: async (tabId: number) =>
        tabId === newTab
          ? { id: newTab, title: '', url, windowId: 1 }
          : { id: TAB_ID, title: 'Example', url: dashboard, windowId: 1 },
      onCreated: {
        addListener: (
          listener: (tab: { readonly id?: number; readonly openerTabId?: number }) => void
        ) => {
          openedListeners.push(listener);
        },
        removeListener: () => {},
      },
      query: async () => [
        { active: true, id: TAB_ID, title: 'Example', url: dashboard, windowId: 1 },
      ],
    };
    const { controller } = createGroups();
    const { cdp, runtime } = await createHarness({
      downloadHold: hold,
      downloadsApi: downloads.api,
      tabGroups: controller,
      tabsApi,
    });
    const authorized = [readGrant, actGrant, { class: 'navigate' as const, origin: MAIN_ORIGIN }];

    // A navigation downloads with no referrer and no announcement: the item's url, and the call's own
    // Expectation, are the only ties the hold has to the tab that asked for the file.
    cdp.setHandlers({
      'Page.navigate': (_params, target) => {
        if (target?.tabId === newTab) {
          hold.handle({ id: 71, url }, () => {});
        }

        return { frameId: 'main' };
      },
    });

    // The caller's tab navigated a moment ago, so its expectation is still live while the tabs call runs.
    const navigated = await runtime.runTool({
      agent: { authorized },
      arguments: { url: dashboard },
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_navigate',
    });

    expect(navigated.kind).toBe('result');

    const guarded = await runtime.runTool({
      agent: { authorized },
      arguments: { action: 'new', url },
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_tabs',
    });

    if (guarded.kind !== 'needs_permission') {
      throw new Error(`expected a refusal, got ${JSON.stringify(guarded)}`);
    }

    // The file belongs to the tab the step opened, so the step the model repeats is the call it made.
    expect(guarded.step).toStrictEqual({
      argumentsHash: hashBrowserToolArguments({ action: 'new', url }),
      tool: 'browser_tabs',
    });
    expect(downloads.cancelled).toStrictEqual([71]);
    // The tab opens blank, and the url loads through the guarded navigate on it.
    expect([created.length, created[0]?.['url']]).toStrictEqual([1, 'about:blank']);
  });

  it('arms the approval before the tool runs, so its file lands and the second file is refused and reported', async () => {
    const downloads = createFakeDownloads();
    const { hold } = holdOver(downloads);
    const { cdp, runtime } = await createHarness({
      downloadHold: hold,
      downloadsApi: downloads.api,
    });
    const dashboard = `${MAIN_ORIGIN}/dashboard`;
    const first = { filename: 'report.txt', id: 71, url: `${MAIN_ORIGIN}/report.txt` };
    const second = { filename: 'second.txt', id: 72, url: `${MAIN_ORIGIN}/second.txt` };
    const suggested: number[] = [];

    // One click starts two files: the approved target, then the one the approval does not cover. The press is the
    // Event that starts them, and the release that follows starts nothing.
    cdp.setHandlers({
      'Input.dispatchMouseEvent': params => {
        if (params?.['type'] === 'mousePressed') {
          for (const file of [first, second]) {
            hold.handle({ id: file.id, referrer: dashboard, url: file.url }, () => {
              suggested.push(file.id);
            });
          }
        }

        return {};
      },
    });

    const click = (sensitive: readonly string[] = []) =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant], sensitive: [...sensitive] },
        arguments: { target: '#pay' },
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_click',
      });

    const guarded = await click();

    expect(guarded.kind).toBe('needs_permission');
    expect(suggested).toStrictEqual([71, 72]);
    // Both files were stopped, and both are named: the approval is for one of them.
    expect(
      guarded.kind === 'needs_permission' && !guarded.result.ok ? guarded.result.error : ''
    ).toContain('second.txt');

    const token = expectStepToken(guarded);

    suggested.length = 0;

    const approved = await click([token]);

    if (approved.kind !== 'result') {
      throw new Error(`expected the approved file to land, got ${JSON.stringify(approved)}`);
    }

    // The approved file was let through before the tool ran, and the second was stopped in the same gesture.
    expect(hold.needOf('session-1')?.kind).toBe('spent');
    expect(suggested).toStrictEqual([71, 72]);
    expect(String(approved.result.ok ? approved.result.value : '')).toContain('second.txt');
    expect(downloads.cancelled).toStrictEqual([71, 72, 72]);
  });

  it('names the step’s own file when the browser stops a second one first', async () => {
    const downloads = createFakeDownloads();
    const { hold } = holdOver(downloads);
    const { cdp, runtime } = await createHarness({
      downloadHold: hold,
      downloadsApi: downloads.api,
    });
    const dashboard = `${MAIN_ORIGIN}/dashboard`;
    const own = { filename: 'report.txt', id: 61, url: `${MAIN_ORIGIN}/download` };
    const extra = { filename: 'second.txt', id: 62, url: `${MAIN_ORIGIN}/download-second` };
    const suggested: number[] = [];
    let repeat = false;

    // The click navigates the tab to the link's own attachment; the page script starts a second, different file.
    // Measured on real Chrome, that second file is refused 8 ms before the link's, so the stop order says nothing.
    cdp.setHandlers({
      'Input.dispatchMouseEvent': params => {
        if (params?.['type'] === 'mousePressed') {
          const files = repeat
            ? [
                { filename: 'second.txt', id: 64, url: extra.url },
                { filename: 'report.txt', id: 63, url: own.url },
              ]
            : [extra, own];

          cdp.emit('Network.requestWillBeSent', {
            request: { method: 'GET', url: own.url },
            requestId: repeat ? 'repeat-document' : 'click-document',
            type: 'Document',
          });

          for (const file of files) {
            hold.handle(
              { filename: file.filename, id: file.id, referrer: dashboard, url: file.url },
              () => {
                suggested.push(file.id);
              }
            );
          }
        }

        return {};
      },
    });

    const click = (sensitive: readonly string[] = []) =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant], sensitive: [...sensitive] },
        arguments: { target: '#pay' },
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_click',
      });

    const guarded = await click();
    const refused =
      guarded.kind === 'needs_permission' && !guarded.result.ok ? guarded.result.error : '';

    // The one approval is for the link's own file — the document this call asked for — and the second file is named
    // Beside it, so the human is never asked for a file the model did not ask for.
    expect(refused).toContain('The download of report.txt was stopped');
    expect(refused).toContain('second.txt');

    const token = expectStepToken(guarded);

    suggested.length = 0;
    repeat = true;

    const approved = await click([token]);

    if (approved.kind !== 'result') {
      throw new Error(`expected the approved file to land, got ${JSON.stringify(approved)}`);
    }

    // The same gesture again: the approval keeps the link's file and stops the script's, which is reported on this
    // Very call, and the approval is spent on exactly the file it bought.
    expect(hold.needOf('session-1')?.kind).toBe('spent');
    expect(downloads.cancelled).toStrictEqual([62, 61, 64]);
    expect(String(approved.result.ok ? approved.result.value : '')).toContain('second.txt');
  });

  it('names the step’s own file when both files are documents and the sibling arrives first', async () => {
    const downloads = createFakeDownloads();
    const { hold } = holdOver(downloads);
    const { cdp, runtime } = await createHarness({
      downloadHold: hold,
      downloadsApi: downloads.api,
    });
    const dashboard = `${MAIN_ORIGIN}/dashboard`;
    const own = { filename: 'report.txt', id: 81, url: `${MAIN_ORIGIN}/assets/report.txt?click=1` };
    const extra = {
      filename: 'second.txt',
      id: 82,
      url: `${MAIN_ORIGIN}/assets/second.txt?click=1`,
    };
    const suggested: number[] = [];
    let repeat = false;

    // Both files of the measured gesture are `Document` requests, so the set of this call's documents names neither:
    // Only their order does. The click's own link is requested first, and the page script's file follows. Here the
    // Browser stops the script's file first, which is what the failing trace showed.
    cdp.setHandlers({
      'Input.dispatchMouseEvent': params => {
        if (params?.['type'] === 'mousePressed') {
          for (const url of [own.url, extra.url]) {
            cdp.emit('Network.requestWillBeSent', {
              request: { method: 'GET', url },
              requestId: `${repeat ? 'repeat' : 'click'}-document-${url}`,
              type: 'Document',
            });
          }

          const items = repeat
            ? [
                { file: extra, id: 84 },
                { file: own, id: 83 },
              ]
            : [
                { file: extra, id: 82 },
                { file: own, id: 81 },
              ];

          for (const { file, id } of items) {
            hold.handle({ filename: file.filename, id, referrer: dashboard, url: file.url }, () => {
              suggested.push(id);
            });
          }
        }

        return {};
      },
    });

    const click = (sensitive: readonly string[] = []) =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant], sensitive: [...sensitive] },
        arguments: { target: '#pay' },
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_click',
      });

    const guarded = await click();
    const refused =
      guarded.kind === 'needs_permission' && !guarded.result.ok ? guarded.result.error : '';

    // The approval buys the step's own file — the one this call requested first — and the sibling is named beside it.
    expect(refused).toContain('The download of report.txt was stopped');
    expect(refused).toContain('second.txt');

    const token = expectStepToken(guarded);

    suggested.length = 0;
    repeat = true;

    const approved = await click([token]);

    if (approved.kind !== 'result') {
      throw new Error(`expected the approved file to land, got ${JSON.stringify(approved)}`);
    }

    // The approval is spent on the file it named, whichever order the browser stopped the two in.
    expect(hold.needOf('session-1')).toMatchObject({
      filename: 'report.txt',
      kind: 'spent',
      target: { kind: 'url', url: own.url },
    });
    // The sibling was stopped on both gestures; the step's own file was cancelled only on the guarded one.
    expect([...downloads.cancelled].toSorted((left, right) => left - right)).toStrictEqual([
      81, 82, 84,
    ]);
    // The approved file was let through, never stopped, and the sibling was stopped again and reported.
    expect(suggested).toStrictEqual([83, 84]);
    expect(String(approved.result.ok ? approved.result.value : '')).toContain('second.txt');
  });

  it('answers an approved call the browser named no item for, and keeps the approval unspent', async () => {
    const downloads = createFakeDownloads();
    const { hold } = holdOver(downloads);
    const { cdp, runtime } = await createHarness({
      downloadHold: hold,
      downloadsApi: downloads.api,
    });
    const dashboard = `${MAIN_ORIGIN}/dashboard`;
    const url = `${MAIN_ORIGIN}/report.txt`;
    let repeat = false;

    // The guarded click starts the file and the hold stops it. The approved repeat's own file never reaches the
    // Hold at all: Chrome's multiple-downloads limiter refuses it, so no item is ever named for it.
    cdp.setHandlers({
      'Input.dispatchMouseEvent': params => {
        if (params?.['type'] === 'mousePressed' && !repeat) {
          hold.handle({ filename: 'report.txt', id: 51, referrer: dashboard, url }, () => {});
        }

        return {};
      },
    });

    const click = (sensitive: readonly string[] = []) =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant], sensitive: [...sensitive] },
        arguments: { target: '#pay' },
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_click',
      });

    // The guarded click starts the file and the hold stops it, so the refusal asks for the one file an approval buys.
    const guarded = await click();
    const token = expectStepToken(guarded);

    repeat = true;

    // The approved call waits the hold's own bound for the item its approval bought; the browser creates none, and
    // The call answers with what that means.
    const approved = await click([token]);

    // The one approval bought a file the browser never created: the model is told the browser refused it, and the
    // Approval is still unspent, so the repeat needs no second decision once the site is allowed.
    expect(approved).toMatchObject({
      afterAction: true,
      kind: 'needs_permission',
      result: { error: DOWNLOAD_BLOCKED_BY_BROWSER_ERROR, ok: false },
    });
    expect(hold.needOf('session-1')?.kind).toBe('armed');
    expectStepToken(approved);
    expect(downloads.cancelled).toStrictEqual([51]);
  });

  /**
   * The hold's own map of announcements is filled by the start-of-call drains, which are empty for the call that
   * actually starts the file. A page that hides its referrer leaves the item naming no tab at all, so the
   * announcement the tab makes while the tool runs is the only thing that can attribute it.
   */
  it('claims a no-referrer file the tab announces during the call, instead of letting it go as foreign', async () => {
    const downloads = createFakeDownloads();
    const { hold } = holdOver(downloads);
    const { cdp, runtime } = await createHarness({
      downloadHold: hold,
      downloadsApi: downloads.api,
    });
    const url = `${MAIN_ORIGIN}/report.txt`;

    cdp.setHandlers({
      'Input.dispatchMouseEvent': params => {
        // One press per click: the release that follows starts nothing.
        if (params?.['type'] === 'mousePressed') {
          cdp.emit('Browser.downloadWillBegin', {
            guid: 'no-referrer-1',
            suggestedFilename: 'report.txt',
            url,
          });
          // The item carries no referrer at all, which is what a `no-referrer` page produces.
          hold.handle({ id: 61, url }, () => {});
        }

        return {};
      },
    });

    const outcome = await runtime.runTool({
      agent: { authorized: [readGrant, actGrant] },
      arguments: { target: '#pay' },
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_click',
    });

    // The file belongs to this tab, so it is cancelled and reported as the agent's rather than saved as the user's.
    await vi.waitFor(() => {
      expect(downloads.cancelled).toStrictEqual([61]);
    });
    expect(outcome.kind).toBe('needs_permission');
    expect(
      outcome.kind === 'needs_permission' && !outcome.result.ok ? outcome.result.error : ''
    ).toContain('report.txt');
  });

  it('does not blame the browser for an approved repeat whose own tool call failed', async () => {
    const downloads = createFakeDownloads();
    const { hold } = holdOver(downloads);
    const { cdp, runtime } = await createHarness({
      downloadHold: hold,
      downloadsApi: downloads.api,
    });
    const dashboard = `${MAIN_ORIGIN}/dashboard`;
    const url = `${MAIN_ORIGIN}/report.txt`;
    let repeat = false;

    // The guarded click starts the file and the hold stops it. The repeat then fails in the tool itself — the page
    // Is gone when the press is dispatched — which starts no download and says nothing about what the browser allowed.
    cdp.setHandlers({
      'Input.dispatchMouseEvent': params => {
        if (params?.['type'] === 'mousePressed') {
          if (repeat) {
            throw new Error('The page was closed before the click could be dispatched.');
          }

          hold.handle({ filename: 'report.txt', id: 52, referrer: dashboard, url }, () => {});
        }

        return {};
      },
    });

    const click = (sensitive: readonly string[]) =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant], sensitive: [...sensitive] },
        arguments: { target: '#pay' },
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_click',
      });

    const guarded = await click([]);
    const token = expectStepToken(guarded);

    repeat = true;

    const failed = await click([token]);
    const error =
      failed.kind === 'result' && !failed.result.ok
        ? failed.result.error
        : `expected the tool's own failure, got ${JSON.stringify(failed)}`;

    // The model is told what actually failed, and the approval it already received is still unspent.
    expect(error).toContain('The page was closed before the click could be dispatched.');
    expect(error).not.toContain(DOWNLOAD_BLOCKED_BY_BROWSER_ERROR);
    expect(hold.needOf('session-1')?.kind).toBe('armed');
    expect(downloads.cancelled).toStrictEqual([52]);
  });

  /**
   * Chrome names a download up to 25 ms after the tool's own command answered, which is the whole reason the hold's
   * no-referrer wait and the settle's sign grace exist. A watch that stopped with the tool would drop that
   * announcement: the hold's map stays empty, its attribution wait expires, and a no-referrer file is saved.
   */
  it('hears an announcement that lands after the tool answered but inside the settle', async () => {
    const downloads = createFakeDownloads();
    const { hold: real } = holdOver(downloads);
    /** Resolves the first time the runtime opens a settle, so the announcement lands squarely inside it. */
    const { promise: settling, resolve: settleOpened } = Promise.withResolvers<void>();
    const hold: DownloadHold = {
      ...real,
      settle: async (session, window) => {
        settleOpened();

        return real.settle(session, window);
      },
    };
    const { cdp, runtime } = await createHarness({
      downloadHold: hold,
      downloadsApi: downloads.api,
    });
    const url = `${MAIN_ORIGIN}/report.txt`;

    // The tool answers without naming a file: on real Chrome the announcement follows the command it caused.
    cdp.setHandlers({ 'Input.dispatchMouseEvent': () => ({}) });

    const call = runtime.runTool({
      agent: { authorized: [readGrant, actGrant] },
      arguments: { target: '#pay' },
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_click',
    });

    // Once the call is in its settle, the browser names the file — the late case a watch stopped with the tool drops.
    await settling;

    try {
      cdp.emit('Browser.downloadWillBegin', {
        guid: 'late-announcement',
        suggestedFilename: 'report.txt',
        url,
      });

      // The item carries no referrer, so the announcement just emitted is the only attribution it has.
      hold.handle({ filename: 'report.txt', id: 71, url }, () => {});

      const outcome = await call;

      // The hold claimed the late announcement, so the file was stopped and named rather than saved as the user's.
      expect(downloads.cancelled).toStrictEqual([71]);
      expect(outcome.kind).toBe('needs_permission');
      expect(
        outcome.kind === 'needs_permission' && !outcome.result.ok ? outcome.result.error : ''
      ).toContain('report.txt');
    } finally {
      await call;
    }
  });
});

/**
 * A call that took longer than the window its own download was given. The tool is held open while the wall clock
 * moves past the span, so a bound counted from the call's start would already be spent by the time the settle runs.
 */
describe('a download call slower than its settle window', () => {
  /** A hold that only records what the runtime tells it: the window is the runtime's own decision. */
  const recordingHold = () => {
    /** What this stub was asked to remember: an approval it was armed with, and one item it was handed. */
    const needs = new Map<string, ApprovalNeed>();
    const items = new Map<number, TrackedDownload>();
    const settled: SettleWindow[] = [];
    const navigations: DownloadHoldNavigation[] = [];
    const at: number[] = [];
    const hold: DownloadHold = {
      announce: () => {},
      arm: need => {
        needs.set(need.session, need);
      },
      closeSession: session => {
        needs.delete(session);
      },
      drain: () => [],
      handle: () => false,
      navigate: navigation => {
        navigations.push(navigation);
        at.push(Date.now());
      },
      needOf: session => needs.get(session),
      settle: async (_session, window) => {
        settled.push(window);

        return 'no_sign';
      },
      tab: () => {},
      tracked: itemId => items.get(itemId),
    };

    return { at, hold, navigations, settled };
  };

  it('re-dates the navigation expectation when the tool answers, so a slow navigation still claims its file', async () => {
    const { at, hold, navigations, settled } = recordingHold();
    const { cdp, runtime } = await createHarness({
      downloadHold: hold,
      downloadsApi: createFakeDownloads().api,
    });
    const { promise: gated, resolve: answered } = Promise.withResolvers<void>();
    const url = `${MAIN_ORIGIN}/reports/q4.pdf`;

    cdp.setHandlers({
      'Page.navigate': async () => {
        await gated;

        return { frameId: 'main' };
      },
    });

    vi.useFakeTimers({ toFake: ['Date'] });

    try {
      const call = runtime.runTool({
        agent: { authorized: [readGrant, { class: 'navigate', origin: MAIN_ORIGIN }] },
        arguments: { url },
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_navigate',
      });

      // Let the call reach its own navigation: the expectation is registered before the tool runs.
      await vi.advanceTimersByTimeAsync(0);

      // The navigation is still running three seconds later: the expectation registered before it has run out.
      vi.setSystemTime(Date.now() + 3000);
      answered();

      await call;

      // Two registrations of one navigation: the one sent with the call, and the one its settle entry re-dates.
      expect(navigations).toHaveLength(2);
      expect(settled).toHaveLength(1);

      const [sent, extended] = navigations;
      const [sentAt, extendedAt] = at;

      // It is the same navigation: the file is claimed against the call that sent it, not a new one.
      expect(extended?.url).toBe(url);
      expect(extended?.attempt).toBe(sent?.attempt);

      // The tool's own three seconds are what the second registration buys back: it ends a span later than the first.
      expect((extended?.until ?? 0) - (sent?.until ?? 0)).toBeGreaterThanOrEqual(3000);
      expect((extendedAt ?? 0) - (sentAt ?? 0)).toBeGreaterThanOrEqual(3000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a download the dialog answer starts', () => {
  /** A hold over the fake downloads, with the reports it queued in order. */
  const holdOver = (downloads: FakeDownloads) => {
    const reports: DownloadHoldReport[] = [];
    const hold = createDownloadHold({
      cancel: async itemId => downloads.api.cancel?.(itemId),
      onReport: report => reports.push(report),
      search: async itemId => (await downloads.api.search?.({ id: itemId })) ?? [],
    });

    return { hold, reports };
  };

  // Chrome always names the frame that opened the dialog, and the answer is judged against that frame's origin.
  const dialogOpened = (cdp: FakeCdp): void => {
    cdp.emit('Page.javascriptDialogOpening', {
      frameId: 'main',
      message: 'Leave this page?',
      type: 'confirm',
      url: `${MAIN_ORIGIN}/dashboard`,
    });
  };

  /** The tab's session records a dialog only once it exists, and a read is what creates it. */
  const warmSession = (runtime: BrowserRuntime) =>
    runtime.runTool({
      agent: { authorized: [readGrant] },
      arguments: {},
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_snapshot',
    });

  const answerDialog = (runtime: BrowserRuntime, sensitive: readonly string[] = []) =>
    runtime.runTool({
      agent: { authorized: [readGrant, actGrant], sensitive: [...sensitive] },
      arguments: { accept: true },
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_handle_dialog',
    });

  it('refuses the file it starts, and names the answer as the step to repeat', async () => {
    const downloads = createFakeDownloads();
    const { hold } = holdOver(downloads);
    const { cdp, runtime } = await createHarness({
      downloadHold: hold,
      downloadsApi: downloads.api,
    });
    const url = `${MAIN_ORIGIN}/report.txt`;

    // The click that opened the dialog answered already; its handler resumes inside the answer.
    cdp.setHandlers({
      'Page.handleJavaScriptDialog': () => {
        hold.handle({ id: 81, referrer: `${MAIN_ORIGIN}/dashboard`, url }, () => {});
        return {};
      },
    });
    // The tab records a dialog only once its session exists, and the first call is what creates it.
    await warmSession(runtime);
    dialogOpened(cdp);

    const guarded = await answerDialog(runtime);

    if (guarded.kind !== 'needs_permission') {
      throw new Error(`expected a refusal, got ${JSON.stringify(guarded)}`);
    }

    expect(guarded.step).toStrictEqual({
      argumentsHash: hashBrowserToolArguments({ accept: true }),
      tool: 'browser_handle_dialog',
    });
    expect(downloads.cancelled).toStrictEqual([81]);
    expect(expectStepToken(guarded)).toStrictEqual(expect.any(String));
  });

  it('fails the attachment response when the response interceptor is the guard', async () => {
    const { cdp, runtime } = await createHarness({ downloadsGranted: false });

    cdp.setHandlers({
      'Page.handleJavaScriptDialog': () => {
        cdp.emit('Fetch.requestPaused', {
          requestId: 'dialog-1',
          responseHeaders: [
            { name: 'Content-Disposition', value: 'attachment; filename="report.txt"' },
            { name: 'Content-Type', value: 'text/plain' },
          ],
          responseStatusCode: 200,
        });

        return {};
      },
    });
    // The tab records a dialog only once its session exists, and the first call is what creates it.
    await warmSession(runtime);
    dialogOpened(cdp);

    const outcome = await answerDialog(runtime);
    const answers = cdp
      .sent()
      .filter(
        command =>
          command.method === 'Fetch.failRequest' || command.method === 'Fetch.continueResponse'
      )
      .map(command => [command.method, command.params?.['requestId']]);

    expect(answers).toStrictEqual([['Fetch.failRequest', 'dialog-1']]);
    expect(outcome).toMatchObject({
      afterAction: true,
      items: [{ class: 'sensitive', origin: MAIN_ORIGIN, reason: SENSITIVE_REASON.download }],
      kind: 'needs_permission',
    });
  });

  it('keeps exactly its file when the repeat carries the token, and refuses the next one', async () => {
    const downloads = createFakeDownloads();
    const { hold } = holdOver(downloads);
    const { cdp, runtime } = await createHarness({
      downloadHold: hold,
      downloadsApi: downloads.api,
    });
    const dashboard = `${MAIN_ORIGIN}/dashboard`;
    const first = { id: 81, url: `${MAIN_ORIGIN}/report.txt` };
    const second = { id: 82, url: `${MAIN_ORIGIN}/second.txt` };
    const suggested: number[] = [];

    const answerStarts = (file: { readonly id: number; readonly url: string }) => {
      hold.handle({ ...file, referrer: dashboard }, () => {
        suggested.push(file.id);
      });
    };

    cdp.setHandlers({
      'Page.handleJavaScriptDialog': () => {
        answerStarts(first);
        return {};
      },
    });

    // The tab records a dialog only once its session exists, and the first call is what creates it.
    await warmSession(runtime);
    dialogOpened(cdp);

    const guarded = await answerDialog(runtime);

    expect(guarded.kind).toBe('needs_permission');

    const token = expectStepToken(guarded);

    // A second click reopens the dialog, and the answer that carries the token is the approved one.
    cdp.setHandlers({
      'Page.handleJavaScriptDialog': () => {
        answerStarts(first);
        answerStarts(second);
        return {};
      },
    });
    dialogOpened(cdp);

    const approved = await answerDialog(runtime, [token]);

    if (approved.kind !== 'result') {
      throw new Error(`expected the approved file to land, got ${JSON.stringify(approved)}`);
    }

    // The approval bought one file: the other the same answer started is refused and reported.
    expect(hold.needOf('session-1')?.kind).toBe('spent');
    expect(downloads.cancelled).toStrictEqual([81, 82]);
    expect(String(approved.result.ok ? approved.result.value : '')).toContain('second.txt');
    expect(suggested).toStrictEqual([81, 81, 82]);
  });

  it('holds a file the resumed click handler starts after the click already returned with the modal state', async () => {
    const downloads = createFakeDownloads();
    const { hold } = holdOver(downloads);
    const { cdp, runtime } = await createHarness({
      downloadHold: hold,
      downloadsApi: downloads.api,
    });

    // The click returns as soon as the dialog opens; its handler resumes only when the answer lands.
    pageDialog(cdp, { message: 'Download the report?', type: 'confirm' });
    cdp.setHandlers({
      'Page.handleJavaScriptDialog': () => {
        hold.handle(
          { id: 91, referrer: `${MAIN_ORIGIN}/dashboard`, url: `${MAIN_ORIGIN}/report.txt` },
          () => {}
        );

        return {};
      },
    });

    const clicked = await runtime.runTool({
      agent: { authorized: [readGrant, actGrant] },
      arguments: { target: '#report' },
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_click',
    });

    expect(clicked).toMatchObject({ kind: 'result', result: { ok: true } });

    // Two calls later the answer resumes the handler, and the file it starts is held without an approval.
    const refused = await runtime.runTool({
      agent: { authorized: [readGrant, actGrant] },
      arguments: { accept: true },
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_handle_dialog',
    });

    expect(refused).toMatchObject({
      afterAction: true,
      items: [{ class: 'sensitive', origin: MAIN_ORIGIN, reason: SENSITIVE_REASON.download }],
      kind: 'needs_permission',
    });
    // Held before Chrome named a file: the guard cancelled the item.
    expect(downloads.cancelled).toStrictEqual([91]);
  });

  it('holds a file an answered dialog loads as an attachment when the response interceptor is the guard', async () => {
    const { cdp, runtime } = await createHarness({ downloadsGranted: false });

    // The click returns with the modal state; the answer is what resumes the handler that loads the file.
    pageDialog(cdp, { message: 'Download the report?', type: 'confirm' });
    cdp.setHandlers({
      'Page.handleJavaScriptDialog': () => {
        cdp.emit('Fetch.requestPaused', {
          requestId: 'dialog-2',
          responseHeaders: [
            { name: 'Content-Disposition', value: 'attachment; filename="report.txt"' },
            { name: 'Content-Type', value: 'text/plain' },
          ],
          responseStatusCode: 200,
        });

        return {};
      },
    });

    await runtime.runTool({
      agent: { authorized: [readGrant, actGrant] },
      arguments: { target: '#report' },
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_click',
    });

    const refused = await runtime.runTool({
      agent: { authorized: [readGrant, actGrant] },
      arguments: { accept: true },
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_handle_dialog',
    });
    const answers = cdp
      .sent()
      .filter(
        command =>
          command.method === 'Fetch.failRequest' || command.method === 'Fetch.continueResponse'
      )
      .map(command => [command.method, command.params?.['requestId']]);

    // The interceptor armed with the dialog open, so the answer's own attachment is failed rather than kept.
    expect(answers).toStrictEqual([['Fetch.failRequest', 'dialog-2']]);
    expect(refused).toMatchObject({
      afterAction: true,
      items: [{ class: 'sensitive', origin: MAIN_ORIGIN, reason: SENSITIVE_REASON.download }],
      kind: 'needs_permission',
    });
  });

  it('answers a dialog that starts no download without waiting for the hold’s timeout', async () => {
    const downloads = createFakeDownloads();
    const { hold } = holdOver(downloads);
    const { cdp, runtime } = await createHarness({
      downloadHold: hold,
      downloadsApi: downloads.api,
    });

    cdp.setHandlers({ 'Page.handleJavaScriptDialog': () => ({}) });

    // The tab records a dialog only once its session exists, and the first call is what creates it.
    await warmSession(runtime);
    dialogOpened(cdp);

    const startedAt = performance.now();
    const answered = await answerDialog(runtime);

    expect(answered.kind).toBe('result');
    // Nothing was refused, and the call did not sit on the 2 s a download gets: only the start grace passed.
    expect(downloads.cancelled).toStrictEqual([]);
    expect(performance.now() - startedAt).toBeLessThan(1500);
  });
});
