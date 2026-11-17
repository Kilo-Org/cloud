/* eslint-disable require-await, typescript-eslint/require-await -- fake extension APIs are async by contract; several record a call and resolve. */
import { describe, expect, it, vi } from 'vitest';
import { createTabLeaseRegistry, AGENT_TAB_WAIT_MS } from './browser-tab-leases';
import { createBrowserRuntime } from './browser-runtime';
import type { BrowserRuntime } from './browser-runtime';
import { TAB_BUSY_ERROR, TAB_TAKEN_ERROR } from './browser-caller';
import type { BrowserCaller } from './browser-caller';
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
  /** Holds the next `Runtime.evaluate` until the test releases it. */
  readonly holdNextEvaluate: () => void;
  readonly releaseHeldEvaluate: () => void;
  /** Resolves once a held evaluate has reached the debugger. */
  readonly whenEvaluateHeld: () => Promise<void>;
}

const createFakeDebugger = (): FakeDebugger => {
  const commands: string[] = [];
  let attachCalls = 0;
  let detachCalls = 0;
  let holding = false;
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

      if (method !== 'Runtime.evaluate') {
        return {};
      }

      if (holding) {
        holding = false;

        for (const listener of heldListeners.splice(0)) {
          listener();
        }

        const { promise, resolve } = Promise.withResolvers<void>();

        heldResolvers.push(resolve);
        await promise;
      }

      return { result: { type: 'number', value: 1 } };
    },
  };

  return {
    api,
    attachCalls: () => attachCalls,
    commands: () => commands,
    detachCalls: () => detachCalls,
    holdNextEvaluate: () => {
      holding = true;
    },
    releaseHeldEvaluate: () => {
      for (const resolve of heldResolvers.splice(0)) {
        resolve();
      }
    },
    whenEvaluateHeld: () => {
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

const createHarness = () => {
  const debugger_ = createFakeDebugger();
  const leases = createTabLeaseRegistry({});
  const runtime = createBrowserRuntime({
    debuggerApi: debugger_.api,
    leases,
    scriptingApi: undefined,
    tabsApi: createFakeTabsApi(),
  });

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
    const { debugger_, runtime } = createHarness();

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
    const { leases, runtime } = createHarness();
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
    const { debugger_, leases, runtime } = createHarness();
    const agentCaller = agent('session-1');
    const panelCaller = panel('conversation-a');

    debugger_.holdNextEvaluate();

    const agentCall = evaluateToolCall(runtime, agentCaller);

    await debugger_.whenEvaluateHeld();

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
    debugger_.releaseHeldEvaluate();
    await Promise.resolve();
    expect(leases.holder(TAB_ID)?.caller).toStrictEqual(panelCaller);
  });

  it('releases the tab lease and its attachment when the tab closes', async () => {
    const { debugger_, leases, runtime } = createHarness();

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
