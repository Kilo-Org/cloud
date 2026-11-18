/* eslint-disable require-await, typescript-eslint/require-await -- fake extension APIs are async by contract and resolve without awaiting. */
import { describe, expect, it } from 'vitest';
import { createTabLeaseRegistry } from './browser-tab-leases';
import { createBrowserRuntime } from './browser-runtime';
import type { BrowserRuntime } from './browser-runtime';
import type { BrowserCaller } from './browser-caller';
import type {
  BrowserScriptingApi,
  BrowserScriptingInjectionResult,
  BrowserTabInfo,
  BrowserTabsApi,
} from './tab-debugger';

/*
 * Ref lifetime at the runtime boundary: a caller's refs outlive its turn and
 * are cleared only by navigation, tab dispose, or the caller's disposal.
 */

const TAB_ID = 7;

const panel = (conversationId: string): BrowserCaller => ({
  conversationId,
  kind: 'panel',
  panelId: 'panel-1',
});

const workflow = (runId: string): BrowserCaller => ({ kind: 'workflow', runId });

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

const snapshotToolCall = (runtime: BrowserRuntime, caller: BrowserCaller) =>
  runtime.runTool({ arguments: {}, caller, tabId: TAB_ID, toolName: 'kilo_browser_snapshot' });

const clickToolCall = (runtime: BrowserRuntime, caller: BrowserCaller, target: string) =>
  runtime.runTool({
    arguments: { target },
    caller,
    tabId: TAB_ID,
    toolName: 'kilo_browser_click',
  });

/**
 * A scripting-backed runtime (`chrome.debugger` unavailable, as on Firefox):
 * snapshot and click run as injected page scripts that the fake records. The
 * snapshot payload keys off the aria builder in the code, like the session
 * tests do, so a real snapshot registers `e1 -> button.go` for its caller.
 */
const createScriptingHarness = () => {
  const codes: string[] = [];
  const scriptingApi: BrowserScriptingApi = {
    executeScript: <InjectionResult>(details: {
      readonly args: string[];
      readonly func: (...args: string[]) => InjectionResult;
      readonly target: { readonly tabId: number; readonly documentIds?: string[] };
      readonly world: 'MAIN';
    }): Promise<BrowserScriptingInjectionResult[]> => {
      const code = details.args[0] ?? '';

      codes.push(code);

      const payload = code.includes('__buildAria')
        ? {
            lines: ['- button "Go" e1'],
            nextRef: 1,
            refs: [{ ref: 'e1', selector: 'button.go' }],
          }
        : 'ok';

      return Promise.resolve([
        { documentId: 'doc-1', result: { ok: true, value: { done: true, result: payload } } },
      ]);
    },
  };
  const leases = createTabLeaseRegistry({});
  const runtime = createBrowserRuntime({
    debuggerApi: undefined,
    leases,
    scriptingApi,
    tabsApi: createFakeTabsApi(),
  });

  return { codes, leases, runtime };
};

describe('browser runtime ref lifetime', () => {
  it("keeps a caller's refs across its lease release and another caller's snapshot", async () => {
    const { codes, leases, runtime } = createScriptingHarness();
    const first = panel('conversation-a');
    const second = workflow('run-1');

    await expect(snapshotToolCall(runtime, first)).resolves.toMatchObject({
      kind: 'result',
      result: { ok: true },
    });

    // The turn ends: the lease goes, the refs stay.
    runtime.releaseCaller(first);
    expect(leases.holder(TAB_ID)).toBeUndefined();

    // Another caller takes the tab and replaces its own registry with a full snapshot.
    await expect(snapshotToolCall(runtime, second)).resolves.toMatchObject({
      kind: 'result',
      result: { ok: true },
    });
    runtime.releaseCaller(second);

    // The first caller's next turn clicks by the ref it took in the earlier turn.
    await expect(clickToolCall(runtime, first, 'e1')).resolves.toMatchObject({
      kind: 'result',
      result: { ok: true },
    });
    expect(codes.at(-1)).toContain('button.go');
  });

  it("clears a disposed caller's refs", async () => {
    const { runtime } = createScriptingHarness();
    const first = panel('conversation-a');

    await snapshotToolCall(runtime, first);
    runtime.disposeCaller(first);

    const outcome = await clickToolCall(runtime, first, 'e1');

    expect(outcome).toMatchObject({
      kind: 'result',
      result: { error: expect.stringContaining('Unknown element reference') as unknown, ok: false },
    });
  });
});
