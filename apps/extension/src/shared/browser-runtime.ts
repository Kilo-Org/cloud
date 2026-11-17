import { browserCallerKey, TAB_BUSY_ERROR, TAB_TAKEN_ERROR } from './browser-caller';
import type { BrowserCaller } from './browser-caller';
import { clearBrowserToolResize } from './browser-tool-page-actions';
import { runKiloBrowserTool } from './browser-tool-dispatch';
import type { BrowserToolDispatchOptions } from './browser-tool-dispatch';
import { createBrowserToolSession } from './browser-tool-session';
import type { BrowserToolSession, BrowserToolTabsApi } from './browser-tool-session';
import type { TabLeaseHolder, TabLeaseRegistry } from './browser-tab-leases';
import { getInspectableTab } from './tab-debugger';
import type {
  BrowserScriptingApi,
  BrowserTabsApi,
  ChromeDebuggerApi,
  EvalTabResult,
} from './tab-debugger';

export interface BrowserToolRunInput {
  readonly arguments: unknown;
  readonly caller: BrowserCaller;
  readonly options?:
    | Pick<BrowserToolDispatchOptions, 'now' | 'webMcpDiscover' | 'webMcpExecute'>
    | undefined;
  readonly tabId: number;
  /** A panel sets this only after its take-over confirmation. */
  readonly takeOver?: boolean;
  readonly title?: string;
  readonly toolName: string;
}

export type BrowserToolRunOutcome =
  | {
      readonly holder: TabLeaseHolder;
      readonly kind: 'needs_take_over';
    }
  | { readonly kind: 'result'; readonly result: EvalTabResult };

export interface BrowserEvalRunInput {
  readonly caller: BrowserCaller;
  readonly code: string;
  readonly tabId: number;
  readonly timeoutMs?: number;
}

export interface BrowserRuntimeDeps {
  readonly debuggerApi: ChromeDebuggerApi | undefined;
  readonly leases: TabLeaseRegistry;
  readonly scriptingApi: BrowserScriptingApi | undefined;
  readonly tabsApi: BrowserTabsApi & BrowserToolTabsApi;
}

export interface BrowserRuntime {
  /** Tab closed or left the extension's reach: drop the session, its lease and its override. */
  readonly disposeTab: (tabId: number) => Promise<void>;
  /** Runs workflow `page` scripts through the tab's one attachment. */
  readonly evalInTab: (input: BrowserEvalRunInput) => Promise<EvalTabResult>;
  readonly releaseCaller: (caller: BrowserCaller) => number;
  readonly runTool: (input: BrowserToolRunInput) => Promise<BrowserToolRunOutcome>;
}

const disposeBrowserToolSession = async (
  sessions: Map<number, BrowserToolSession>,
  tabId: number
): Promise<void> => {
  const session = sessions.get(tabId);

  if (session === undefined) {
    return;
  }

  sessions.delete(tabId);
  // Clear a browser_resize override before the debugger detaches, so a tab that stays open but leaves the extension's reach does not keep the resized viewport.
  await clearBrowserToolResize(session);
  await session.dispose();
};

/**
 * The background's one browser runtime. Every caller — a side-panel
 * conversation, a workflow run, or a CLI agent — reaches a tab through here:
 * the lease decides who may use the tab, the serial chain keeps one call in
 * flight per tab, and the tab's session owns the single debugger attachment
 * and one ref registry per caller.
 */
export const createBrowserRuntime = ({
  debuggerApi,
  leases,
  scriptingApi,
  tabsApi,
}: BrowserRuntimeDeps): BrowserRuntime => {
  const sessions = new Map<number, BrowserToolSession>();
  // One tail promise per tab: calls run in the order they were admitted.
  const chains = new Map<number, Promise<void>>();
  // The abort hook of the call currently running in the tab, keyed by tab.
  const inFlight = new Map<number, () => void>();

  const sessionFor = (tabId: number): BrowserToolSession => {
    const existing = sessions.get(tabId);

    if (existing !== undefined) {
      return existing;
    }

    const created = createBrowserToolSession({ debuggerApi, scriptingApi, tabId, tabsApi });

    sessions.set(tabId, created);
    return created;
  };

  const disposeTab = async (tabId: number): Promise<void> => {
    chains.delete(tabId);
    inFlight.delete(tabId);
    leases.releaseTab(tabId);
    await disposeBrowserToolSession(sessions, tabId);
  };

  const runExclusive = async <Result>(
    tabId: number,
    task: () => Promise<Result>
  ): Promise<Result> => {
    const previous = chains.get(tabId) ?? Promise.resolve();
    const { promise: gate, resolve } = Promise.withResolvers<void>();

    chains.set(tabId, previous.then(() => gate));

    await previous;

    try {
      return await task();
    } finally {
      resolve();
    }
  };

  const reachable = async (tabId: number): Promise<EvalTabResult | undefined> => {
    const reach = await getInspectableTab({ tabId, tabsApi });

    if (reach.ok) {
      return undefined;
    }

    await disposeTab(tabId);
    return { error: reach.error, ok: false };
  };

  const runTool = async ({
    arguments: toolArguments,
    caller,
    options,
    tabId,
    takeOver,
    title,
    toolName,
  }: BrowserToolRunInput): Promise<BrowserToolRunOutcome> => {
    const lease = await leases.acquire(tabId, caller, {
      ...(takeOver === undefined ? {} : { takeOver }),
      ...(title === undefined ? {} : { title }),
    });

    if (lease.kind === 'needs_take_over') {
      return { holder: lease.holder, kind: 'needs_take_over' };
    }

    if (lease.kind === 'busy') {
      return { kind: 'result', result: { error: TAB_BUSY_ERROR, ok: false } };
    }

    // The panel confirmed: the agent's in-flight call ends here and the panel's call waits for it to unwind.
    inFlight.get(tabId)?.();

    return runExclusive(tabId, async () => {
      const unreachable = await reachable(tabId);

      if (unreachable !== undefined) {
        return { kind: 'result', result: unreachable };
      }

      const session = sessionFor(tabId).bindCaller(browserCallerKey(caller));
      const { promise: takenAway, resolve: markTaken } = Promise.withResolvers<void>();
      let taken = false;

      inFlight.set(tabId, () => {
        taken = true;
        markTaken();
      });

      try {
        const call = runKiloBrowserTool({
          arguments: toolArguments,
          options: {
            tabId,
            tabsApi,
            ...(options?.now === undefined ? {} : { now: options.now }),
            ...(options?.webMcpDiscover === undefined
              ? {}
              : { webMcpDiscover: options.webMcpDiscover }),
            ...(options?.webMcpExecute === undefined
              ? {}
              : { webMcpExecute: options.webMcpExecute }),
          },
          session,
          toolName,
        });
        const result = await Promise.race([call, takenAway.then(() => null)]);

        // A taken-over call drops its late result: the page belongs to the panel now.
        if (taken) {
          return { kind: 'result', result: { error: TAB_TAKEN_ERROR, ok: false } };
        }

        return {
          kind: 'result',
          result: result ?? { error: 'The browser tool returned no result.', ok: false },
        };
      } finally {
        inFlight.delete(tabId);
      }
    });
  };

  const evalInTab = async ({
    caller,
    code,
    tabId,
    timeoutMs,
  }: BrowserEvalRunInput): Promise<EvalTabResult> => {
    const lease = await leases.acquire(tabId, caller);

    if (lease.kind !== 'granted') {
      return { error: TAB_BUSY_ERROR, ok: false };
    }

    return runExclusive(tabId, async () => {
      const unreachable = await reachable(tabId);

      if (unreachable !== undefined) {
        return unreachable;
      }

      return sessionFor(tabId).evaluateInTab(code, timeoutMs);
    });
  };

  const releaseCaller = (caller: BrowserCaller): number => {
    const key = browserCallerKey(caller);

    for (const session of sessions.values()) {
      session.releaseCaller(key);
    }

    return leases.releaseCaller(caller);
  };

  return { disposeTab, evalInTab, releaseCaller, runTool };
};
