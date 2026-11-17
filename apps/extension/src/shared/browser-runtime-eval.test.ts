/* eslint-disable require-await, typescript-eslint/require-await -- fake extension APIs are async by contract and resolve without awaiting. */
import { describe, expect, it } from 'vitest';
import { createTabLeaseRegistry } from './browser-tab-leases';
import { createBrowserRuntime } from './browser-runtime';
import type { BrowserCaller } from './browser-caller';
import type {
  BrowserScriptingApi,
  BrowserScriptingInjectionResult,
  BrowserTabInfo,
  BrowserTabsApi,
} from './tab-debugger';

/*
 * One workflow run evaluates every page of its script on the same tab. The
 * run's caller holds the tab lease between pages, so all pages must use that
 * one caller: a per-page caller queues behind the first page's lease forever.
 */

const TAB_ID = 7;

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

const createRuntime = () => {
  const scriptingApi: BrowserScriptingApi = {
    executeScript: <InjectionResult>(_details: {
      readonly args: string[];
      readonly func: (...args: string[]) => InjectionResult;
      readonly target: { readonly tabId: number; readonly documentIds?: string[] };
      readonly world: 'MAIN';
    }): Promise<BrowserScriptingInjectionResult[]> =>
      Promise.resolve([{ documentId: 'doc-1', result: 'ok' }]),
  };
  const leases = createTabLeaseRegistry({});
  const runtime = createBrowserRuntime({
    debuggerApi: undefined,
    leases,
    scriptingApi,
    tabsApi: createFakeTabsApi(),
  });

  return { leases, runtime };
};

describe('browser runtime workflow eval', () => {
  it("runs every page of a run under the run's one caller and frees the tab when it is disposed", async () => {
    const { leases, runtime } = createRuntime();
    const run = workflow('run-1');

    await expect(
      runtime.evalInTab({ caller: run, code: 'return 1;', tabId: TAB_ID })
    ).resolves.toMatchObject({ ok: true });

    // Between pages the run still owns the tab; the next page is the same caller, so it is granted.
    expect(leases.holder(TAB_ID)?.caller).toStrictEqual(run);
    await expect(
      runtime.evalInTab({ caller: run, code: 'return 2;', tabId: TAB_ID })
    ).resolves.toMatchObject({ ok: true });

    // A different caller queues behind the run: the run still holds the tab, which is why the second page above worked.
    const other = runtime.evalInTab({
      caller: workflow('run-2'),
      code: 'return 3;',
      tabId: TAB_ID,
    });

    await Promise.resolve();
    expect(leases.holder(TAB_ID)?.caller).toStrictEqual(run);

    // Disposal at the run's end hands the tab over.
    runtime.disposeCaller(run);
    await expect(other).resolves.toMatchObject({ ok: true });
  });
});
