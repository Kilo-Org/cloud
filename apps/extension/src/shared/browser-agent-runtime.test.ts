/* eslint-disable max-lines, require-await -- the suite drives one fake CDP session and one fake tab-group API through every agent tool path, whose fakes are async by contract. */
import { describe, expect, it } from 'vitest';
import { createBrowserTabGroupController } from './browser-tab-groups';
import type { BrowserTabGroupController } from './browser-tab-groups';
import { createTabLeaseRegistry } from './browser-tab-leases';
import { createBrowserRuntime } from './browser-runtime';
import type { BrowserToolRunOutcome } from './browser-runtime';
import {
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
      case 'DOM.querySelector': {
        return { nodeId: 5 };
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

const createHarness = (tabGroups?: BrowserTabGroupController) => {
  const cdp = createFakeCdp();
  const leases = createTabLeaseRegistry({});
  const runtime = createBrowserRuntime({
    debuggerApi: cdp.api,
    leases,
    scriptingApi: undefined,
    tabGroups,
    tabsApi: createTabsApi(),
  });

  return { cdp, leases, runtime };
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
    const { cdp, runtime } = createHarness();

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
    const { runtime } = createHarness();

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
    const { cdp, runtime } = createHarness();
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
    const { cdp, runtime } = createHarness();
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
    const { cdp, runtime } = createHarness();

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
    const { cdp, runtime } = createHarness();

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
      items: [{ class: 'sensitive', origin: MAIN_ORIGIN, reason: SENSITIVE_REASON.download }],
      kind: 'needs_permission',
      result: { error: NEEDS_PERMISSION_ERROR, ok: false },
    });
    // The download was denied for the call's duration and the browser's default restored afterwards.
    expect(cdp.downloadsDenied()).toBe(1);
    expect(cdp.downloadsRestored()).toBe(1);

    expect(expectStepToken(outcome)).toBeDefined();
  });

  it('runs a download call unguarded once with the approval token, then burns it', async () => {
    const { cdp, runtime } = createHarness();

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

    expect(approved.kind).toBe('result');
    expect(cdp.downloadsDenied()).toBe(1);

    const replay = await click([token]);

    expect(replay.kind).toBe('needs_permission');
    expect(cdp.downloadsDenied()).toBe(2);
  });

  it('does not refuse an act call for a download an earlier call started', async () => {
    const { cdp, runtime } = createHarness();

    cdp.setHandlers({
      'Page.navigate': () => {
        cdp.emit('Browser.downloadWillBegin', {
          guid: 'download-8',
          suggestedFilename: 'old.pdf',
          url: `${MAIN_ORIGIN}/old.pdf`,
        });

        return { frameId: 'main' };
      },
    });

    const navigate = await runtime.runTool({
      agent: { authorized: [{ class: 'navigate', origin: MAIN_ORIGIN }] },
      arguments: { url: `${MAIN_ORIGIN}/next` },
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_navigate',
    });

    expect(navigate.kind).toBe('result');

    // The navigate left a download event behind; this call started none of its own.
    const click = await runtime.runTool({
      agent: { authorized: [readGrant, actGrant] },
      arguments: { target: '#pay' },
      caller: agent(),
      tabId: TAB_ID,
      toolName: 'browser_click',
    });

    expect(click.kind).toBe('result');
  });

  it('keeps a session to its own tab group', async () => {
    const { controller } = createGroups();
    const { runtime } = createHarness(controller);

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
    const { runtime } = createHarness(controller);

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
    const { runtime } = createHarness(controller);

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
    const { runtime } = createHarness(controller);

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
    const { cdp, runtime } = createHarness();

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
    const { cdp, runtime } = createHarness();

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
    const { runtime } = createHarness();

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
