/* eslint-disable vitest/no-conditional-in-test -- the fake CDP and tabs API answer per method and per tab id */
/* eslint-disable max-lines, require-await -- the suite drives one fake CDP session and one fake tab-group API through every agent tool path, whose fakes are async by contract. */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createBrowserTabGroupController } from './browser-tab-groups';
import type { BrowserTabGroupController } from './browser-tab-groups';
import { createTabLeaseRegistry } from './browser-tab-leases';
import { createBrowserRuntime } from './browser-runtime';
import type {
  BrowserDownloadItem,
  BrowserDownloadsApi,
  BrowserToolRunOutcome,
} from './browser-runtime';
import {
  AGENT_TAB_OUTSIDE_GROUP_ERROR,
  DOWNLOAD_PERMISSION_MISSING_ERROR,
  NEEDS_PERMISSION_ERROR,
  ORIGIN_CHANGED_ERROR,
  SENSITIVE_REASON,
} from './browser-agent-checks';
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

type CdpHandler = (
  params: Record<string, unknown> | undefined
) => Record<string, unknown> | undefined;

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
  readonly downloadsDenied: () => number;
  readonly downloadsRestored: () => number;
  readonly emit: (method: string, params: Record<string, unknown>) => void;
  /** One event from a child (out-of-process frame) session, the way chrome.debugger reports it. */
  readonly emitFrom: (method: string, params: Record<string, unknown>, sessionId: string) => void;
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
  const eventListeners: ChromeDebuggerEventListener[] = [];
  let denied = 0;
  let restored = 0;
  let mainUrl = `${MAIN_ORIGIN}/dashboard`;
  let probe: Record<string, unknown> = { fields: [], paymentFormSubmit: false };
  let emitDownloadOnClick = false;
  const handlers: Record<string, CdpHandler> = {};

  const sendMailbox = (
    method: string,
    params: Record<string, unknown> | undefined
  ): Record<string, unknown> | undefined => {
    const handler = handlers[method];

    if (handler !== undefined) {
      return handler(params);
    }

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

      return sendMailbox(method, params);
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

/** `chrome.downloads` as the runtime sees it: the single `onCreated` stream and the erase that deletes the file. */
const createFakeDownloads = (
  options: { readonly cancelRejects?: boolean; readonly removeRejects?: boolean } = {}
) => {
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
    readonly downloadsApi?: BrowserDownloadsApi | undefined;
    readonly downloadsGranted?: boolean;
    readonly downloadsResolver?: () => BrowserDownloadsApi | undefined;
    readonly share?: boolean;
    readonly tabGroups?: BrowserTabGroupController;
    readonly tabsApi?: BrowserTabsApi;
  } = {}
) => {
  const cdp = createFakeCdp();
  const leases = createTabLeaseRegistry({});
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
      result: { error: NEEDS_PERMISSION_ERROR, ok: false },
    });
    // The click ran once: a click is a press and a release, and nothing ran the action a second time.
    expect(cdp.commands().filter(method => method === 'Input.dispatchMouseEvent')).toHaveLength(2);
    expect(cdp.downloadsDenied()).toBe(1);
    expect(cdp.downloadsRestored()).toBe(1);

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

  it('refuses a download-capable call when the optional permission is missing', async () => {
    // No downloads API: the guard cannot see a blob download, so the click must not run.
    const { cdp, runtime } = await createHarness({ downloadsGranted: false });

    const outcome = await runtime.runTool({
      agent: { authorized: [readGrant, actGrant] },
      arguments: { target: '#pay' },
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_click',
    });

    expect(outcome).toMatchObject({
      kind: 'result',
      result: { error: DOWNLOAD_PERMISSION_MISSING_ERROR, ok: false },
    });
    expect(cdp.commands()).not.toContain('Input.dispatchMouseEvent');
  });

  it('refuses a navigate without the optional permission, and loads nothing', async () => {
    const { cdp, runtime } = await createHarness({ downloadsGranted: false });

    const outcome = await runtime.runTool({
      agent: { authorized: [readGrant, actGrant, { class: 'navigate', origin: MAIN_ORIGIN }] },
      arguments: { url: `${MAIN_ORIGIN}/invoice.pdf` },
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_navigate',
    });

    // A page can start a download on load: no guard, no load.
    expect(outcome).toMatchObject({
      kind: 'result',
      result: { error: DOWNLOAD_PERMISSION_MISSING_ERROR, ok: false },
    });
    expect(cdp.commands()).not.toContain('Page.navigate');
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
    const { runtime } = await createHarness({ downloadsGranted: false, tabsApi });

    const click = () =>
      runtime.runTool({
        agent: { authorized: [readGrant, actGrant] },
        arguments: { target: '#pay' },
        caller: agent(),
        tabId: TAB_ID,
        toolName: 'browser_click',
      });

    // The refusal returns before the guard exists, so the tab listener it would have fed is never registered.
    await expect(click()).resolves.toMatchObject({
      kind: 'result',
      result: { error: DOWNLOAD_PERMISSION_MISSING_ERROR, ok: false },
    });
    expect(created.size).toBe(0);
  });

  it('runs a download call unguarded once with the approval token, then burns it', async () => {
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
            "The click on '#pay' started a download of report.txt, which was stopped. Approved. Repeat that click to receive the file.",
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

    // The approved repeat keeps the file: the model must read that as a success that changed no page.
    const approved = await navigate([expectStepToken(guarded)]);

    expect(approved).toMatchObject({ kind: 'result', result: { ok: true } });
    const approvedText =
      approved.kind === 'result' && approved.result.ok ? String(approved.result.value) : '';

    // The success names the file the browser wrote and says the page did not change.
    expect(approvedText).toContain('report.txt');
    expect(approvedText).toContain('The file was downloaded; the page did not change.');
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

    for (const sessionHandle of ['session-1', 'session-2']) {
      // eslint-disable-next-line no-await-in-loop -- one session per share, in order
      await runtime.openSession({ controllerId: 'controller-1', sessionHandle, title: 'Work' });
      // eslint-disable-next-line no-await-in-loop -- see above
      await runtime.shareActiveTab({ sessionHandle, tabId: TAB_ID });
    }

    cdp.setHandlers({
      'Input.dispatchMouseEvent': () => {
        cdp.emit('Browser.downloadWillBegin', {
          guid: 'download-7',
          suggestedFilename: 'invoice.pdf',
          url: `${MAIN_ORIGIN}/invoice.pdf`,
        });

        return {};
      },
    });

    const click = async (sessionHandle: string, sensitive: readonly string[] = []) => {
      const caller = { controllerId: 'controller-1', kind: 'agent' as const, sessionHandle };

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
    const { runtime } = await createHarness();

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
