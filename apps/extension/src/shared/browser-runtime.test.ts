/* eslint-disable max-lines, require-await, typescript-eslint/require-await -- fake extension APIs are async by contract; several record a call and resolve. */
import { describe, expect, it, vi } from 'vitest';
import { createTabLeaseRegistry, AGENT_TAB_WAIT_MS } from './browser-tab-leases';
import { createBrowserRuntime } from './browser-runtime';
import type { BrowserDownloadsApi, BrowserRuntime } from './browser-runtime';
import { TAB_BUSY_ERROR, TAB_TAKEN_ERROR } from './browser-caller';
import type { BrowserCaller } from './browser-caller';
import type { BrowserToolTabsApi } from './browser-tool-session';
import type {
  BrowserTabInfo,
  BrowserTabsApi,
  ChromeDebuggerApi,
  ChromeDebuggerDetachListener,
  ChromeDebuggerEventListener,
} from './tab-debugger';

const TAB_ID = 7;

const panel = (conversationId: string): BrowserCaller => ({
  conversationId,
  kind: 'panel',
  panelId: 'panel-1',
});

const agent = (sessionHandle: string): BrowserCaller => ({
  controllerId: 'controller-1',
  kind: 'agent',
  sessionHandle,
});

const workflow = (runId: string): BrowserCaller => ({ kind: 'workflow', runId });

interface FakeDebugger {
  readonly api: ChromeDebuggerApi;
  readonly attachCalls: () => number;
  readonly commands: () => readonly string[];
  readonly detachCalls: () => number;
  /** Holds the next command of the named method until the test releases it. */
  readonly holdNextCommand: (method: string) => void;
  readonly releaseHeldCommand: () => void;
  /** Resolves once a held command has reached the debugger. */
  readonly whenCommandHeld: () => Promise<void>;
}

const createFakeDebugger = (): FakeDebugger => {
  const commands: string[] = [];
  let attachCalls = 0;
  let detachCalls = 0;
  let heldMethod: string | undefined = undefined;
  const heldResolvers: (() => void)[] = [];
  const heldListeners: (() => void)[] = [];
  const detachListeners: ChromeDebuggerDetachListener[] = [];
  const eventListeners: ChromeDebuggerEventListener[] = [];

  const api: ChromeDebuggerApi = {
    attach: async () => {
      attachCalls += 1;
    },
    detach: async () => {
      detachCalls += 1;
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
    sendCommand: async (_target, method) => {
      commands.push(method);

      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'main', url: 'https://example.com/' } } };
      }

      if (heldMethod === method) {
        heldMethod = undefined;

        for (const listener of heldListeners.splice(0)) {
          listener();
        }

        const { promise, resolve } = Promise.withResolvers<void>();

        heldResolvers.push(resolve);
        await promise;
      }

      return method === 'Runtime.evaluate' ? { result: { type: 'number', value: 1 } } : {};
    },
  };

  return {
    api,
    attachCalls: () => attachCalls,
    commands: () => commands,
    detachCalls: () => detachCalls,
    holdNextCommand: (method: string) => {
      heldMethod = method;
    },
    releaseHeldCommand: () => {
      for (const resolve of heldResolvers.splice(0)) {
        resolve();
      }
    },
    whenCommandHeld: () => {
      const { promise, resolve } = Promise.withResolvers<void>();

      heldListeners.push(resolve);
      return promise;
    },
  };
};

const createFakeTabsApi = (): BrowserTabsApi => {
  const tabs = new Map<number, BrowserTabInfo>([
    [TAB_ID, { id: TAB_ID, title: 'Example', url: 'https://example.com/' }],
  ]);

  return {
    get: async tabId => {
      const tab = tabs.get(tabId);

      if (tab === undefined) {
        throw new Error(`No tab with id: ${String(tabId)}`);
      }

      return tab;
    },
    query: async () => [...tabs.values()],
  };
};

/** The optional `downloads` permission in its granted state, which every guarded page load needs. */
const grantedDownloads = (): BrowserDownloadsApi => ({
  cancel: async () => {},
  erase: async () => {},
  onCreated: { addListener: () => {}, removeListener: () => {} },
  removeFile: async () => {},
});

const createHarness = async () => {
  const debugger_ = createFakeDebugger();
  const leases = createTabLeaseRegistry({});
  const runtime = createBrowserRuntime({
    debuggerApi: debugger_.api,
    downloadsApi: grantedDownloads,
    leases,
    scriptingApi: undefined,
    tabsApi: createFakeTabsApi(),
  });

  // D9: an agent reaches only its session's group, so the suite's session owns the tab from the start.
  await runtime.openSession({
    controllerId: 'controller-1',
    sessionHandle: 'session-1',
    title: 'Work',
  });
  await runtime.shareActiveTab({ sessionHandle: 'session-1', tabId: TAB_ID });

  return { debugger_, leases, runtime };
};

/** One evaluate tool call: the panel-side tool path the models reach. */
const evaluateToolCall = (runtime: BrowserRuntime, caller: BrowserCaller) =>
  runtime.runTool({
    // An agent caller is checked against the real origin first (SPEC "Permission flow").
    agent: { authorized: [{ class: 'act', origin: 'https://example.com' }] },
    arguments: { function: '() => 1' },
    caller,
    tabId: TAB_ID,
    toolName: 'kilo_browser_evaluate',
  });

describe('browser runtime', () => {
  it("shares the tab's one attachment between a workflow eval and a panel tool call", async () => {
    const { debugger_, runtime } = await createHarness();

    await expect(
      runtime.evalInTab({ caller: workflow('run-1'), code: 'return 1;', tabId: TAB_ID })
    ).resolves.toStrictEqual({ ok: true, value: 1 });

    // The run ends its lease, and the next caller reuses the tab's attachment rather than attaching again.
    runtime.releaseCaller(workflow('run-1'));

    await expect(evaluateToolCall(runtime, panel('conversation-a'))).resolves.toMatchObject({
      kind: 'result',
      result: { ok: true },
    });

    // One attachment for both callers: no second attach, and neither call detached.
    expect(debugger_.attachCalls()).toBe(1);
    expect(debugger_.detachCalls()).toBe(0);
    expect(debugger_.commands().filter(method => method === 'Runtime.evaluate')).toHaveLength(2);
  });

  it('ends an agent wait for a held tab with tab_busy after the agent window', async () => {
    vi.useFakeTimers();
    const { leases, runtime } = await createHarness();
    const owner = panel('conversation-a');

    await leases.acquire(TAB_ID, owner);

    const wait = runtime.runTool({
      arguments: { function: '() => 1' },
      caller: agent('session-1'),
      tabId: TAB_ID,
      toolName: 'kilo_browser_evaluate',
    });

    await vi.advanceTimersByTimeAsync(AGENT_TAB_WAIT_MS - 1);
    expect(leases.holder(TAB_ID)?.caller).toStrictEqual(owner);

    await vi.advanceTimersByTimeAsync(1);
    await expect(wait).resolves.toStrictEqual({
      kind: 'result',
      result: { error: TAB_BUSY_ERROR, ok: false },
    });

    vi.useRealTimers();
  });

  it('lets the panel take over an agent call, which ends with tab_taken and drops its late result', async () => {
    const { debugger_, leases, runtime } = await createHarness();
    const agentCaller = agent('session-1');
    const panelCaller = panel('conversation-a');

    debugger_.holdNextCommand('Runtime.evaluate');

    const agentCall = evaluateToolCall(runtime, agentCaller);

    await debugger_.whenCommandHeld();

    // The panel may not take a running agent's tab without its confirmation.
    await expect(evaluateToolCall(runtime, panelCaller)).resolves.toMatchObject({
      holder: { caller: agentCaller },
      kind: 'needs_take_over',
    });

    const panelCall = runtime.runTool({
      arguments: { function: '() => 1' },
      caller: panelCaller,
      tabId: TAB_ID,
      takeOver: true,
      toolName: 'kilo_browser_evaluate',
    });

    // The panel confirmed in its own call path: the agent's call ends here, not with the page's value.
    await expect(agentCall).resolves.toStrictEqual({
      kind: 'result',
      result: { error: TAB_TAKEN_ERROR, ok: false },
    });

    await expect(panelCall).resolves.toMatchObject({ kind: 'result', result: { ok: true } });

    // The agent's page command resolves later; its result is dropped, so the panel keeps the tab.
    debugger_.releaseHeldCommand();
    await Promise.resolve();
    expect(leases.holder(TAB_ID)?.caller).toStrictEqual(panelCaller);
  });

  it('stops a taken call from sending the page commands that follow the one in flight', async () => {
    const { debugger_, runtime } = await createHarness();
    const agentCaller = agent('session-1');

    // A navigate sends Page.navigate and then reads the page identity.
    // That identity read must never follow a take-over.
    debugger_.holdNextCommand('Page.navigate');

    const agentCall = runtime.runTool({
      // An agent caller is checked against the navigation origin first (SPEC "Permission flow").
      agent: { authorized: [{ class: 'navigate', origin: 'https://example.com' }] },
      arguments: { url: 'https://example.com/next' },
      caller: agentCaller,
      tabId: TAB_ID,
      toolName: 'browser_navigate',
    });

    await debugger_.whenCommandHeld();

    const panelCall = runtime.runTool({
      arguments: { function: '() => 1' },
      caller: panel('conversation-a'),
      tabId: TAB_ID,
      takeOver: true,
      toolName: 'kilo_browser_evaluate',
    });

    await expect(agentCall).resolves.toStrictEqual({
      kind: 'result',
      result: { error: TAB_TAKEN_ERROR, ok: false },
    });
    await expect(panelCall).resolves.toMatchObject({ kind: 'result', result: { ok: true } });

    const commandsAfterTakeOver = debugger_.commands().length;

    // The held navigation lands now: the taken call must not send the identity read that follows it.
    vi.useFakeTimers();
    debugger_.releaseHeldCommand();
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();

    expect(debugger_.commands()).toHaveLength(commandsAfterTakeOver);
  });

  it('releases only the call\u2019s tab lease, not the session\u2019s other tabs', async () => {
    const { leases, runtime } = await createHarness();
    const agentCaller = agent('session-1');
    const secondTabId = 8;

    // Two tabs in one session: a finished call on the first must leave the second held.
    await runtime.shareActiveTab({ sessionHandle: 'session-1', tabId: secondTabId });
    await leases.acquire(secondTabId, agentCaller);

    await expect(evaluateToolCall(runtime, agentCaller)).resolves.toMatchObject({
      kind: 'result',
      result: { ok: true },
    });

    runtime.releaseTab({ caller: agentCaller, tabId: TAB_ID });

    expect(leases.holder(TAB_ID)).toBeUndefined();
    expect(leases.holder(secondTabId)?.caller).toStrictEqual(agentCaller);
  });

  it('hands a conversation lease to the workflow run that claims its tab', async () => {
    const { leases, runtime } = await createHarness();
    const panelCaller = panel('conversation-a');
    const run = workflow('run-1');

    await leases.acquire(TAB_ID, panelCaller);

    // A run_workflow in a turn that already used a browser tool must not queue behind that same turn.
    await expect(runtime.claimTab({ caller: run, from: panelCaller, tabId: TAB_ID })).resolves.toBe(
      true
    );
    expect(leases.holder(TAB_ID)?.caller).toStrictEqual(run);
  });

  it('ignores a handover from a caller that is not a panel', async () => {
    vi.useFakeTimers();
    const { leases, runtime } = await createHarness();
    const agentCaller = agent('session-1');

    await leases.acquire(TAB_ID, agentCaller);

    // Only a panel may hand a tab over; an agent's lease is never freed for someone else.
    const claim = runtime.claimTab({ caller: workflow('run-1'), from: agentCaller, tabId: TAB_ID });

    await vi.advanceTimersByTimeAsync(AGENT_TAB_WAIT_MS);
    await expect(claim).resolves.toBe(false);
    expect(leases.holder(TAB_ID)?.caller).toStrictEqual(agentCaller);

    vi.useRealTimers();
  });

  it('refuses a run claim on a tab another caller holds, after the wait window', async () => {
    vi.useFakeTimers();
    const { leases, runtime } = await createHarness();

    await leases.acquire(TAB_ID, panel('conversation-b'));

    const claim = runtime.claimTab({ caller: workflow('run-1'), tabId: TAB_ID });

    await vi.advanceTimersByTimeAsync(AGENT_TAB_WAIT_MS);
    await expect(claim).resolves.toBe(false);
    expect(leases.holder(TAB_ID)?.caller).toStrictEqual(panel('conversation-b'));

    vi.useRealTimers();
  });

  it('releases the tab lease and its attachment when the tab closes', async () => {
    const { debugger_, leases, runtime } = await createHarness();

    await evaluateToolCall(runtime, panel('conversation-a'));
    expect(leases.holder(TAB_ID)?.caller).toStrictEqual(panel('conversation-a'));

    await runtime.disposeTab(TAB_ID);
    expect(leases.holder(TAB_ID)).toBeUndefined();

    // The next caller gets the tab through a fresh session.
    await expect(evaluateToolCall(runtime, panel('conversation-b'))).resolves.toMatchObject({
      kind: 'result',
      result: { ok: true },
    });
    expect(debugger_.attachCalls()).toBe(2);
    expect(debugger_.detachCalls()).toBe(1);
  });
});

describe('opening a session tab', () => {
  it('reports the requested url when the browser reports an empty one', async () => {
    // `tabs.create` resolves with `url: ''` while the navigation is pending; the requested url is the honest answer.
    const tabsApi: BrowserTabsApi & { create: NonNullable<BrowserToolTabsApi['create']> } = {
      create: async () => ({ id: 21, title: '', url: '' }),
      get: async () => ({ id: 21, status: 'complete', url: 'about:blank' }) as BrowserTabInfo,
      query: async () => [{ active: true, id: TAB_ID, windowId: 1 }],
    };
    const runtime = createBrowserRuntime({
      debuggerApi: undefined,
      leases: createTabLeaseRegistry({}),
      scriptingApi: undefined,
      tabsApi,
    });

    const opened = await runtime.openSessionTab({ sessionHandle: 'session-1' });

    // A tab opened at the destination would spend a single-use url before the guarded call ran.
    expect(opened?.url).toBe('about:blank');
  });
});
