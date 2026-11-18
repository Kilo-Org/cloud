/* eslint-disable max-lines -- One runtime owns the serial chain, leases, tab groups and the agent gate; splitting it would scatter the per-tab ordering contract. */
import {
  AGENT_TAB_OUTSIDE_GROUP_ERROR,
  createStepTokenStore,
  hashBrowserToolArguments,
  NEEDS_PERMISSION_ERROR,
  ORIGIN_CHANGED_ERROR,
  parseToolArguments,
  SENSITIVE_REASON,
} from './browser-agent-checks';
import type { BrowserGrant, BrowserPermissionItem, StepTokenStore } from './browser-agent-checks';
import { postAgentNavigate, preflightAgentCall, takeStartedDownloads } from './browser-agent-gate';
import type { BrowserSensitiveStep } from './browser-agent-gate';
import {
  enableAgentFrameAutoAttach,
  readAgentFrameTree,
  withheldFramesOf,
} from './browser-agent-frames';
import { createBrowserTabGroupController } from './browser-tab-groups';
import type {
  BrowserOpenSessionInput,
  BrowserSessionRef,
  BrowserShareTabInput,
  BrowserShareTabResult,
  BrowserTabGroupController,
  BrowserTabGroupOpenResult,
  BrowserTabGroupSessionSummary,
} from './browser-tab-groups';
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

/** The grant pairs and step tokens one CLI agent call carries (SPEC "Protocol v1" `tools.call`). */
export interface BrowserAgentCallContext {
  readonly authorized: readonly BrowserGrant[];
  readonly sensitive?: readonly string[] | undefined;
}

export interface BrowserToolRunInput {
  /** Present only for an `agent` caller: the CLI's grants for this call. */
  readonly agent?: BrowserAgentCallContext | undefined;
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
  | {
      readonly kind: 'result';
      readonly result: EvalTabResult;
      /** Origins whose frames the agent could not read this call; the bridge puts them in `_meta`. */
      readonly withheldFrames?: readonly string[];
    }
  // The transport maps these onto JSON-RPC -32010 / -32012; the result carries the model-visible tool error.
  | {
      readonly items: readonly BrowserPermissionItem[];
      readonly kind: 'needs_permission';
      readonly result: EvalTabResult;
      readonly stepToken?: string | undefined;
    }
  | {
      readonly from: string;
      readonly kind: 'origin_changed';
      readonly result: EvalTabResult;
      readonly to: string;
    };

export interface BrowserEvalRunInput {
  readonly caller: BrowserCaller;
  readonly code: string;
  readonly tabId: number;
  readonly timeoutMs?: number;
}

export interface BrowserRuntimeDeps {
  readonly debuggerApi: ChromeDebuggerApi | undefined;
  readonly leases: TabLeaseRegistry;
  /** The clock sensitive step tokens expire against; defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
  readonly scriptingApi: BrowserScriptingApi | undefined;
  /** The session's sensitive approvals; one store per background runtime. */
  readonly stepTokens?: StepTokenStore | undefined;
  /**
   * The tab groups agent sessions live in. Optional so a test can inject its
   * own; the runtime otherwise builds one from `tabsApi`, so the D9 boundary
   * and the session lifecycle are wired for every caller. Group titles still
   * need the transport that opens sessions and shares tabs (C3 item).
   */
  readonly tabGroups?: BrowserTabGroupController | undefined;
  readonly tabsApi: BrowserTabsApi & BrowserToolTabsApi;
}

export interface BrowserTabClaimInput {
  readonly caller: BrowserCaller;
  /**
   * The caller handing its lease over — a conversation's panel lease, so a run
   * can take the tab its own conversation holds instead of queueing behind the
   * turn that is waiting for it.
   */
  readonly from?: BrowserCaller;
  readonly tabId: number;
}

export interface BrowserRuntime {
  /** Gives a session its tab group back after it ended (`/browser adopt`). */
  readonly adoptEnded: (input: BrowserSessionRef) => Promise<BrowserTabGroupOpenResult>;
  /**
   * Takes the tab's lease before the caller's first command, so a workflow run
   * navigates under the lease rather than rewriting the page under its holder.
   */
  readonly claimTab: (input: BrowserTabClaimInput) => Promise<boolean>;
  /** Ends a session: its group collapses, turns grey and becomes `Kilo · ended`. */
  readonly closeSession: (input: BrowserSessionRef) => Promise<void>;
  /** Records a tab the browser opened from one of a session's tabs, so the session may use it. */
  readonly noteTabCreated: (tabId: number, openerTabId: number | undefined) => Promise<void>;
  /** Drops the caller's ref registries for good; the tab sessions and leases stay alive for others. */
  readonly disposeCaller: (caller: BrowserCaller) => number;
  /** Tab closed or left the extension's reach: drop the session, its lease and its override. */
  readonly disposeTab: (tabId: number) => Promise<void>;
  /** Runs workflow `page` scripts through the tab's one attachment. */
  readonly evalInTab: (input: BrowserEvalRunInput) => Promise<EvalTabResult>;
  /** The sessions the group controller knows, for the settings UI. */
  readonly listSessions: () => BrowserTabGroupSessionSummary[];
  /** Creates the session's group `Kilo · <title>` (or tracks tabs without one). */
  readonly openSession: (input: BrowserOpenSessionInput) => Promise<BrowserTabGroupOpenResult>;
  /** Ends the caller's tab leases. Its refs survive, so the next turn can click by an earlier ref. */
  readonly releaseCaller: (caller: BrowserCaller) => number;
  readonly runTool: (input: BrowserToolRunInput) => Promise<BrowserToolRunOutcome>;
  /** Moves the active tab (or the named one) into the session's group (`/browser share`). */
  readonly shareActiveTab: (input: BrowserShareTabInput) => Promise<BrowserShareTabResult>;
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
  now,
  scriptingApi,
  stepTokens,
  tabGroups,
  tabsApi,
}: BrowserRuntimeDeps): BrowserRuntime => {
  const tokens = stepTokens ?? createStepTokenStore(now === undefined ? {} : { now });
  const groups =
    tabGroups ??
    createBrowserTabGroupController({
      api: {
        tabQuery: async query => {
          const tabs = await tabsApi.query(query);

          return tabs.map(tab =>
            tab.active === undefined ? { id: tab.id } : { active: tab.active, id: tab.id }
          );
        },
      },
    });
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
    autoAttachedTabs.delete(tabId);
    groups.noteTabRemoved(tabId);
    leases.releaseTab(tabId);
    await disposeBrowserToolSession(sessions, tabId);
  };

  const runExclusive = async <Result>(
    tabId: number,
    task: () => Promise<Result>
  ): Promise<Result> => {
    const previous = chains.get(tabId) ?? Promise.resolve();
    const { promise: gate, resolve } = Promise.withResolvers<void>();

    // The chain entry settles only after both the earlier call and this one's gate: callers run in admission order.
    chains.set(
      tabId,
      (async (): Promise<void> => {
        await previous;
        await gate;
      })()
    );

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

  /**
   * Cancels downloads a call was not approved to start. `Page.setDownloadBehavior`
   * is the page-target spelling of the browser-level method, so it works through
   * the tab's one debugger attachment; the guard is best effort — a browser that
   * refuses it keeps its default behaviour and the call proceeds.
   */
  const setDownloadBehavior = async (
    session: BrowserToolSession,
    behavior: 'default' | 'deny'
  ): Promise<void> => {
    try {
      await session.send('Page.setDownloadBehavior', { behavior, eventsEnabled: true });
    } catch {
      // A target that rejects the deprecated method keeps the browser default.
    }
  };

  // Tabs whose flattened frame auto-attach is on, so out-of-process iframes are reachable for scoping.
  const autoAttachedTabs = new Set<number>();

  const ensureFrameAutoAttach = async (
    session: BrowserToolSession,
    tabId: number
  ): Promise<void> => {
    if (autoAttachedTabs.has(tabId)) {
      return;
    }

    await enableAgentFrameAutoAttach(session);
    autoAttachedTabs.add(tabId);
  };

  const withheldOriginsFor = async (
    session: BrowserToolSession,
    authorized: readonly BrowserGrant[]
  ): Promise<readonly string[]> => {
    const frames = await readAgentFrameTree(session);
    const readable = authorized.filter(grant => grant.class === 'read').map(grant => grant.origin);

    return withheldFramesOf(frames, readable).map(frame => frame.origin);
  };

  const needsPermissionOutcome = (
    items: readonly BrowserPermissionItem[],
    stepToken: string | undefined
  ): BrowserToolRunOutcome => ({
    items,
    kind: 'needs_permission',
    result: { error: NEEDS_PERMISSION_ERROR, ok: false },
    ...(stepToken === undefined ? {} : { stepToken }),
  });

  const claimTab = async ({ caller, from, tabId }: BrowserTabClaimInput): Promise<boolean> => {
    // The handover runs before the acquire, in one message.
    // Only a panel may hand a lease over: its take-over asymmetry is the design's only one.
    // An agent's tab is never freed for someone else without a confirmation.
    if (from?.kind === 'panel') {
      leases.release(tabId, from);
    }

    const lease = await leases.acquire(tabId, caller);

    return lease.kind === 'granted';
  };

  const runTool = async ({
    agent,
    arguments: toolArguments,
    caller,
    options,
    tabId,
    takeOver,
    title,
    toolName,
  }: BrowserToolRunInput): Promise<BrowserToolRunOutcome> => {
    // An agent reaches only its own session's tabs; the group is the boundary (D9).
    // A session with nothing shared yet is refused too: no group means no reach.
    if (caller.kind === 'agent' && !groups.isTabAllowed(caller.sessionHandle, tabId)) {
      return { kind: 'result', result: { error: AGENT_TAB_OUTSIDE_GROUP_ERROR, ok: false } };
    }

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

      const { promise: takenAway, resolve: markTaken } = Promise.withResolvers<void>();
      let taken = false;

      inFlight.set(tabId, () => {
        taken = true;
        markTaken();
      });

      // A taken call stops issuing commands instead of interleaving them with the panel's.
      // The guard is read before every command this call sends.
      const session = sessionFor(tabId).bindCaller(browserCallerKey(caller), {
        cancelled: () => taken,
      });

      try {
        const agentContext = caller.kind === 'agent' ? (agent ?? { authorized: [] }) : undefined;
        const argsRecord = parseToolArguments(toolArguments);
        const issueSensitiveToken = (sensitive: BrowserSensitiveStep): string =>
          tokens.issue({
            argumentHash: hashBrowserToolArguments(argsRecord),
            element: sensitive.element,
            origin: sensitive.origin,
            reason: sensitive.reason,
            tabId,
            toolName,
          });

        if (agentContext !== undefined) {
          // Only downloads this call starts may be reported: events left by an earlier call are stale.
          takeStartedDownloads(session);
          await ensureFrameAutoAttach(session, tabId);
        }

        const preflight =
          agentContext === undefined
            ? undefined
            : await preflightAgentCall({
                args: argsRecord,
                authorized: agentContext.authorized,
                consumeStepToken: (token, binding) => tokens.consume(token, binding),
                session,
                stepTokens: agentContext.sensitive ?? [],
                tabId,
                toolName,
              });

        if (preflight !== undefined && !preflight.ok) {
          if (preflight.failure.kind === 'blocked') {
            return { kind: 'result', result: { error: preflight.failure.error, ok: false } };
          }

          if (preflight.failure.kind === 'origin_changed') {
            return {
              from: preflight.failure.from,
              kind: 'origin_changed',
              result: { error: ORIGIN_CHANGED_ERROR, ok: false },
              to: preflight.failure.to,
            };
          }

          return needsPermissionOutcome(
            preflight.failure.items,
            preflight.sensitive === undefined ? undefined : issueSensitiveToken(preflight.sensitive)
          );
        }

        // A download approval is post-action, so the gate cannot classify it on retry; a presented token bound to this tab, tool and argument set disables the guard once.
        const downloadApproved =
          agentContext !== undefined && preflight !== undefined && preflight.ok
            ? (agentContext.sensitive ?? []).some(token =>
                tokens.consume(token, {
                  argumentHash: hashBrowserToolArguments(argsRecord),
                  origin: preflight.origin,
                  tabId,
                  toolName,
                })
              )
            : false;

        // An unapproved act call runs with downloads denied: a download it starts is cancelled, then reported as a sensitive step.
        const guardDownloads =
          agentContext !== undefined &&
          preflight !== undefined &&
          preflight.class === 'act' &&
          preflight.sensitiveToken === undefined &&
          !downloadApproved;

        if (guardDownloads) {
          await setDownloadBehavior(session, 'deny');
        }

        let result: EvalTabResult | null = null;

        try {
          const call = runKiloBrowserTool({
            arguments: toolArguments,
            options: {
              tabId,
              tabsApi,
              ...(agentContext === undefined
                ? {}
                : {
                    agentAccess: {
                      actOrigins: agentContext.authorized
                        .filter(grant => grant.class === 'act')
                        .map(grant => grant.origin),
                      groupTabs:
                        caller.kind === 'agent'
                          ? groups.tabsForSession(caller.sessionHandle)
                          : undefined,
                      navigateOrigins: agentContext.authorized
                        .filter(grant => grant.class === 'navigate')
                        .map(grant => grant.origin),
                      readableOrigins: agentContext.authorized
                        .filter(grant => grant.class === 'read')
                        .map(grant => grant.origin),
                    },
                    agentScope: {
                      readableOrigins: agentContext.authorized
                        .filter(grant => grant.class === 'read')
                        .map(grant => grant.origin),
                    },
                    noteTabCreated,
                  }),
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

          result = await Promise.race([call, takenAway.then(() => null)]);
        } finally {
          if (guardDownloads) {
            await setDownloadBehavior(session, 'default');
          }
        }

        // A taken-over call drops its late result: the page belongs to the panel now.
        if (taken) {
          return { kind: 'result', result: { error: TAB_TAKEN_ERROR, ok: false } };
        }

        const settled = result ?? { error: 'The browser tool returned no result.', ok: false };

        if (preflight !== undefined && preflight.class === 'navigate') {
          const changed = await postAgentNavigate(session, preflight.origin);

          if (changed !== undefined) {
            return { from: changed.from, kind: 'origin_changed', result: settled, to: changed.to };
          }
        }

        if (guardDownloads && takeStartedDownloads(session) > 0) {
          const origin = preflight?.ok ? preflight.origin : '';
          const reason = SENSITIVE_REASON.download;

          return needsPermissionOutcome(
            [{ class: 'sensitive', origin, reason }],
            preflight?.ok ? issueSensitiveToken({ origin, reason }) : undefined
          );
        }

        if (agentContext === undefined) {
          return { kind: 'result', result: settled };
        }

        return {
          kind: 'result',
          result: settled,
          withheldFrames: await withheldOriginsFor(session, agentContext.authorized),
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

  const disposeCaller = (caller: BrowserCaller): number => {
    const key = browserCallerKey(caller);

    for (const session of sessions.values()) {
      session.disposeCaller(key);
    }

    return leases.releaseCaller(caller);
  };

  const noteTabCreated = async (tabId: number, openerTabId: number | undefined): Promise<void> => {
    if (openerTabId === undefined) {
      return;
    }

    const openerSession = groups.sessionForTab(openerTabId);

    if (openerSession === undefined) {
      return;
    }

    const groupId = groups
      .listSessions()
      .find(session => session.sessionHandle === openerSession)?.groupId;

    if (groupId !== undefined) {
      groups.noteTabAdded(tabId, groupId);
      return;
    }

    // No group yet: create it from the session's tabs plus this one, titled and coloured like a shared tab (D9: the group is what the agent may act on).
    const owned = [...new Set([...groups.tabsForSession(openerSession), tabId])];

    for (const ownedTab of owned) {
      // eslint-disable-next-line no-await-in-loop -- grouping one tab per call, order matters for the first group
      await groups.shareActiveTab({ sessionHandle: openerSession, tabId: ownedTab });
    }
  };

  return {
    adoptEnded: input => groups.adoptEnded(input),
    claimTab,
    closeSession: async input => {
      await groups.closeSession(input);
    },
    disposeCaller,
    disposeTab,
    evalInTab,
    listSessions: () => groups.listSessions(),
    noteTabCreated,
    openSession: input => groups.openSession(input),
    // Turn end: the lease goes, the caller's refs stay. Playwright-like, a ref from an earlier snapshot keeps resolving for as long as the caller and the tab session live.
    releaseCaller: caller => leases.releaseCaller(caller),
    runTool,
    shareActiveTab: input => groups.shareActiveTab(input),
  };
};
