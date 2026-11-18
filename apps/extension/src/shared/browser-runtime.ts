/* eslint-disable import/max-dependencies, max-lines -- One runtime owns the serial chain, leases, tab groups and the agent gate; splitting it would scatter the per-tab ordering contract. */
import { z } from 'zod';
import {
  AGENT_TAB_OUTSIDE_GROUP_ERROR,
  canStartDownload,
  createStepTokenStore,
  DOWNLOAD_PERMISSION_MISSING_ERROR,
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
  createAgentFrameReader,
  enableAgentFrameAutoAttach,
  withheldFramesOf,
} from './browser-agent-frames';
import type { AgentFrameInventory } from './browser-agent-frames';
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
import { getInspectableTab, isInspectablePageUrl } from './tab-debugger';
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
      /** The page ran before the refusal: the CLI must not auto-retry, only a human may. */
      readonly afterAction?: boolean;
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

/** One tab a session opens for itself, after the gate allowed the call that needed it. */
export interface BrowserSessionTabInput {
  readonly sessionHandle: string;
}

export interface BrowserSessionTabResult {
  readonly groupId?: number | undefined;
  readonly tabId: number;
  readonly title: string;
  readonly url: string;
}

/** One download the browser created, as `chrome.downloads.onCreated` reports it. */
export interface BrowserDownloadItem {
  readonly filename?: string;
  readonly finalUrl?: string;
  /** ISO-8601 start time, used to tell this call's download from an older one at the same url. */
  readonly startTime?: string;
  readonly id: number;
  /** `chrome.downloads` lifecycle state; `complete` means `cancel` is too late and the file must be removed. */
  readonly state?: string;
  /** The page that started it; the only attribution a browser without `tabId` offers. */
  readonly referrer?: string;
  readonly tabId?: number;
  readonly url?: string;
}

/** The slice of `chrome.downloads` the agent's download guard uses. */
export interface BrowserDownloadsApi {
  readonly cancel: (downloadId: number) => Promise<void>;
  /** Drops the item from the download history; it does not delete a file. */
  readonly erase?: (query: { readonly id: number }) => Promise<void> | undefined;
  /** Deletes the file of a download `cancel` was too late to stop. */
  readonly removeFile?: (downloadId: number) => Promise<void> | undefined;
  /** Finds a download the browser created after the listener's window, by the url the call asked for, or one item by id. */
  readonly search?: (query: {
    readonly id?: number;
    readonly startedAfter?: number;
    readonly url?: string;
  }) => Promise<readonly BrowserDownloadItem[]> | undefined;
  readonly onCreated: {
    readonly addListener: (listener: (item: BrowserDownloadItem) => void) => void;
    readonly removeListener: (listener: (item: BrowserDownloadItem) => void) => void;
  };
}

export interface BrowserRuntimeDeps {
  readonly debuggerApi: ChromeDebuggerApi | undefined;
  /**
   * `chrome.downloads`, resolved per call: the optional permission can be
   * granted or revoked while this worker lives, so it is read at call time
   * rather than captured when the runtime was built.
   */
  readonly downloadsApi?: (() => BrowserDownloadsApi | undefined) | undefined;
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
  /**
   * A session's own tab: created inactive in the last focused window and put in
   * its group, so an agent never takes the tab the user is looking at. Undefined
   * when this browser cannot create tabs.
   */
  readonly openSessionTab: (
    input: BrowserSessionTabInput
  ) => Promise<BrowserSessionTabResult | undefined>;
  /** One tab's current title and url, for the payload an opened tab reports. */
  readonly tabInfo: (
    tabId: number
  ) => Promise<{ readonly title: string; readonly url: string } | undefined>;
  /** Ends the caller's tab leases. Its refs survive, so the next turn can click by an earlier ref. */
  readonly releaseCaller: (caller: BrowserCaller) => number;
  /** Drops this caller's lease on one tab only: one finished call must not free its session's other tabs. */
  readonly releaseTab: (input: { readonly caller: BrowserCaller; readonly tabId: number }) => void;
  readonly runTool: (input: BrowserToolRunInput) => Promise<BrowserToolRunOutcome>;
  /** Moves the active tab (or the named one) into the session's group (`/browser share`). */
  readonly shareActiveTab: (input: BrowserShareTabInput) => Promise<BrowserShareTabResult>;
}

/** How long a session waits for a tab it opened to commit, and how often it re-reads the tab while it waits. */
const TAB_COMMIT_TIMEOUT_MS = 10_000;
const TAB_COMMIT_POLL_MS = 50;

/**
 * How long the guard keeps listening after a call that started no download.
 * A click or a page load whose response headers arrive a moment later still
 * gets its file deleted, but the call itself does not wait for a download it
 * never started.
 */
const DOWNLOAD_GUARD_LINGER_MS = 2_000;

/** How long an approved navigate waits for the browser to name the file it kept. */
const KEPT_DOWNLOAD_POLLS = 60;
const KEPT_DOWNLOAD_POLL_MS = 50;

/** How long a navigate that did not land on its destination waits for the download the browser owes it. */
const NAVIGATE_DOWNLOAD_POLL_MS = 20;
const NAVIGATE_DOWNLOAD_POLLS = 15;

/**
 * How long the guard waits for a download it stopped to reach `complete` or
 * `interrupted`. `cancel` resolves on an item that already finished, so the
 * only proof that no file exists is the item's own terminal state.
 */
const DOWNLOAD_SETTLE_POLL_MS = 100;
const DOWNLOAD_SETTLE_POLLS = 20;

/** One download this call stopped: its file is gone, or the browser kept it under a name. */
type DiscardOutcome =
  | { readonly kind: 'kept'; readonly filename: string }
  | { readonly kind: 'removed' };

/** What a guard stopped: files it removed, and files the browser had already written. */
interface GuardSettlement {
  readonly kept: readonly string[];
  readonly stopped: number;
}

/**
 * The guard for a browser without the optional `downloads` permission. A tab
 * cannot refuse a download itself — chrome.debugger blocks the download domain
 * — but it can intercept the response that would become one: a navigation whose
 * response carries `Content-Disposition: attachment` is aborted before its body
 * is delivered, so no file is ever created. Every other response is continued,
 * so an ordinary click pays one round trip. `undefined` when the target cannot
 * intercept, so the caller can refuse instead.
 */
/** One guard a call runs: `settle` reports which of the call's own downloads it stopped. */
interface DownloadGuard {
  readonly settle: () => Promise<GuardSettlement>;
}

/**
 * The text an approved navigate reports when the file it started was kept.
 * Chrome answers such a navigation with `ERR_ABORTED` — there is no page to
 * load — so without this the model would read a kept file as a failure. The
 * item may still be in progress when it is found, so the name falls back to the
 * requested url until the browser fills the path in.
 */
const keptDownloadText = async (
  api: BrowserDownloadsApi | undefined,
  destination: string,
  startedAt: number
): Promise<string | undefined> => {
  if (api?.search === undefined) {
    return undefined;
  }

  for (let attempt = 0; attempt < KEPT_DOWNLOAD_POLLS; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop -- the browser creates the download on its own schedule
      const found = await api.search({ url: destination });
      // `startedAfter` in the query misses items the browser has not finished naming, so the time filter is applied here.
      const item = (found ?? []).find(
        candidate =>
          candidate.startTime === undefined ||
          Number.isNaN(Date.parse(candidate.startTime)) ||
          Date.parse(candidate.startTime) >= startedAt
      );

      if (item !== undefined) {
        const name =
          item.filename?.split('/').pop() ??
          item.finalUrl?.split('/').pop() ??
          destination.split('/').pop();

        return name === undefined || name === ''
          ? 'The file was downloaded; the page did not change.'
          : `${name}: The file was downloaded; the page did not change.`;
      }
    } catch {
      return undefined;
    }

    // eslint-disable-next-line no-await-in-loop -- bounded wait for the browser to name the item
    await after(KEPT_DOWNLOAD_POLL_MS);
  }

  return undefined;
};

/** A string argument of a tool call, or `undefined` when it is absent or empty. */
const argumentText = (value: unknown): string | undefined => {
  const parsed = NON_EMPTY_STRING.safeParse(value);

  return parsed.success ? parsed.data : undefined;
};

/** The tab a guard attributes a download to: its id and the page url a referrer is compared with. */
const guardTabOf = async (
  tabsApi: BrowserRuntimeDeps['tabsApi'],
  tabId: number
): Promise<{ readonly tabId: number; readonly url: string }> => {
  const tab = await tabsApi.get?.(tabId);

  return { tabId, url: tab?.url ?? '' };
};

const NON_EMPTY_STRING = z.string().min(1);

/** `origin` + `pathname`: the page identity a download's referrer is compared against. */
const pageOf = (url: string | undefined): string | undefined => {
  try {
    const parsed = new URL(url ?? '');

    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return undefined;
  }
};

/**
 * Whether this call started the download. The browser ties a download to a tab
 * (`tabId`) or, where it reports no tab, to the page that started it
 * (`referrer`); a download from a tab this call opened counts as the call's
 * own, and one with neither tie is the user's and is left alone, because
 * deleting someone else's file is worse than missing one.
 */
const startedByThisCall = (
  item: BrowserDownloadItem,
  tab: { readonly tabId: number; readonly url: string },
  tabIds: readonly number[]
): boolean => {
  if (item.tabId !== undefined) {
    return item.tabId === tab.tabId || tabIds.includes(item.tabId);
  }

  const referrer = pageOf(item.referrer);
  const page = pageOf(tab.url);

  return referrer !== undefined && page !== undefined && referrer === page;
};

/**
 * Stops one download of this call. `cancel` resolves even for an item that
 * already finished, so this waits for the item's own terminal state and then
 * removes the file of one that completed first; a guard that could not delete
 * the file says so and names it instead of claiming a removal it did not do.
 */
const discardDownload = async (
  api: BrowserDownloadsApi,
  item: BrowserDownloadItem
): Promise<DiscardOutcome> => {
  try {
    await api.cancel(item.id);
  } catch {
    // Too late for the cancel: the state below says whether a file was written.
  }

  const settled = await settledDownload(api, item.id);
  const filename = fileNameOf(settled ?? item);

  // `interrupted` is the browser's own proof that no file exists.
  if (settled?.state === 'interrupted') {
    return { kind: 'removed' };
  }

  if (api.removeFile === undefined) {
    // Nothing can delete a file the browser wrote, so a finished item is a file the user kept.
    return { kind: 'kept', filename };
  }

  try {
    await api.removeFile(item.id);
    await api.erase?.({ id: item.id });

    return { kind: 'removed' };
  } catch {
    // A cancel still in flight holds no file yet, so only a finished item is a kept file.
    return settled?.state === 'in_progress' ? { kind: 'removed' } : { kind: 'kept', filename };
  }
};

/** The name of the file a download wrote, for a refusal that has to name it. */
const fileNameOf = (item: BrowserDownloadItem): string => {
  const name =
    item.filename?.split('/').pop() ??
    item.finalUrl?.split('/').pop() ??
    item.url?.split('/').pop();

  return name === undefined || name === '' ? 'the downloaded file' : name;
};

/**
 * The item's terminal state: `complete` or `interrupted`, or the item as the
 * browser still reports it when the bounded wait runs out. A missing item is
 * gone from the history, which means no file survived.
 */
const settledDownload = async (
  api: BrowserDownloadsApi,
  id: number
): Promise<BrowserDownloadItem | undefined> => {
  for (let attempt = 0; attempt < DOWNLOAD_SETTLE_POLLS; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop -- bounded wait for the browser to finish the item
      const found = (await api.search?.({ id }))?.find(candidate => candidate.id === id);

      if (found === undefined || found.state === 'complete' || found.state === 'interrupted') {
        return found;
      }
    } catch {
      return undefined;
    }

    // eslint-disable-next-line no-await-in-loop -- see above
    await after(DOWNLOAD_SETTLE_POLL_MS);
  }

  try {
    return (await api.search?.({ id }))?.find(candidate => candidate.id === id);
  } catch {
    return undefined;
  }
};

/**
 * The guard that uses the optional `downloads` permission: the browser names a
 * download when it creates it — before the call's own command returns — and the
 * call's own items are cancelled and their files deleted. It is the only guard:
 * it sees `blob:` and `data:` downloads, which issue no network request at all.
 */
/**
 * The download a navigate started, polled because the browser creates it on its
 * own schedule: a navigation that became a download never reaches its
 * destination, so this only runs for that case.
 */
const findNavigateDownloads = async ({
  api,
  navigation,
  owned,
  startedAt,
}: {
  readonly api: BrowserDownloadsApi;
  readonly navigation: { readonly destination: string };
  readonly owned: (item: BrowserDownloadItem) => boolean;
  readonly startedAt: number;
}): Promise<readonly BrowserDownloadItem[]> => {
  for (let attempt = 0; attempt < NAVIGATE_DOWNLOAD_POLLS; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop -- one search per bounded attempt
      const found = await api.search?.({ startedAfter: startedAt, url: navigation.destination });
      // The search matches by url alone, so the same file another tab started is not this navigate's.
      const mine = (found ?? []).filter(item => owned(item));

      if (mine.length > 0) {
        return mine;
      }
    } catch {
      // A search that fails leaves the listener's own window as the only evidence.
    }

    // eslint-disable-next-line no-await-in-loop -- bounded wait for the browser to create it
    await after(NAVIGATE_DOWNLOAD_POLL_MS);
  }

  return [];
};

interface DownloadAttribution {
  /** A navigate's destination and a reader for the tab's url now: a navigation that became a download never reaches it. */
  readonly navigation?:
    | { readonly destination: string; readonly landed: () => Promise<boolean> }
    | undefined;
  readonly tab: { readonly tabId: number; readonly url: string };
  /** Tabs this call owns, including one it opened. */
  readonly tabIds: () => readonly number[];
}

const armDownloadGuard = (
  api: BrowserDownloadsApi,
  attribution: DownloadAttribution
): DownloadGuard => {
  const { navigation, tab, tabIds } = attribution;
  const startedAt = Date.now();
  const discards: Promise<DiscardOutcome>[] = [];
  let created = false;
  const listener = (item: BrowserDownloadItem): void => {
    // A navigate answers with the file it asked for even when the browser reports no tab for it.
    // An item the browser ties to another tab is that tab's download, so the same url in a second tab is left alone.
    const requested =
      navigation !== undefined &&
      item.tabId === undefined &&
      (pageOf(item.url) === pageOf(navigation.destination) ||
        pageOf(item.finalUrl) === pageOf(navigation.destination));

    // Another tab's download, or the user's own: not this call's business.
    if (!requested && !startedByThisCall(item, tab, tabIds())) {
      return;
    }

    created = true;
    discards.push(discardDownload(api, item));
  };

  const report = async (): Promise<GuardSettlement> => {
    const outcomes = await Promise.all(discards);

    return {
      kept: outcomes.flatMap(outcome => (outcome.kind === 'kept' ? [outcome.filename] : [])),
      stopped: outcomes.filter(outcome => outcome.kind === 'removed').length,
    };
  };

  api.onCreated.addListener(listener);

  return {
    settle: async () => {
      // A navigate that became a download never reaches its destination, so the tab answers at once and the
      // requested url finds the item while it is in progress. A navigation that landed pays nothing.
      if (!created && navigation !== undefined && api.search !== undefined) {
        if (!(await navigation.landed().catch(() => true))) {
          const owned = (item: BrowserDownloadItem): boolean =>
            item.tabId === undefined || tabIds().includes(item.tabId);

          for (const item of await findNavigateDownloads({
            api,
            navigation,
            owned,
            startedAt,
          })) {
            discards.push(discardDownload(api, item));
          }
        }
      }

      if (!created && discards.length === 0) {
        // Nothing started, so the call does not pay for a window it may never need: the listener stays armed for a
        // bounded linger and deletes a download whose headers arrived after the call returned.
        void (async (): Promise<void> => {
          await after(DOWNLOAD_GUARD_LINGER_MS);
          api.onCreated.removeListener(listener);
          await report();
        })();

        return { kept: [], stopped: 0 };
      }

      api.onCreated.removeListener(listener);

      return report();
    },
  };
};

const after = (milliseconds: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);

  return promise;
};

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
  downloadsApi,
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
  // Tabs this runtime opened for an agent session. They start blank, and a blank url is unreadable without the
  // `tabs` permission, so the inspectability precheck cannot judge them; the debugger attach does.
  const sessionOwnedTabs = new Set<number>();
  // One tail promise per tab: calls run in the order they were admitted.
  const chains = new Map<number, Promise<void>>();
  // The abort hook of the call currently running in the tab, keyed by tab.
  const inFlight = new Map<number, () => void>();

  const sessionFor = (tabId: number): BrowserToolSession => {
    const existing = sessions.get(tabId);

    if (existing !== undefined) {
      return existing;
    }

    const created = createBrowserToolSession({
      debuggerApi,
      ...(sessionOwnedTabs.has(tabId) ? { ownedTab: true } : {}),
      scriptingApi,
      tabId,
      tabsApi,
    });

    sessions.set(tabId, created);
    return created;
  };

  const disposeTab = async (tabId: number): Promise<void> => {
    chains.delete(tabId);
    inFlight.delete(tabId);
    autoAttachedTabs.delete(tabId);
    sessionOwnedTabs.delete(tabId);
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

  /** A tab's commit progress: `status`/`pendingUrl` say whether a navigation is still in flight. */
  interface TabProgress {
    readonly pendingUrl?: string;
    readonly status?: string;
    readonly url?: string;
  }
  type TabUpdateListener = (tabId: number, changeInfo: TabProgress, tab?: TabProgress) => void;

  /** One tab's commit state; undefined when the tab is gone. */
  const tabProgressOf = async (tabId: number): Promise<TabProgress | undefined> => {
    const get = tabsApi.get?.bind(tabsApi);

    if (get === undefined) {
      return undefined;
    }

    try {
      // `chrome.tabs.Tab` carries `status` and `pendingUrl`, which the narrow tabs interface does not model.
      const tab: TabProgress = await get(tabId);

      return tab;
    } catch {
      // A closed or never-existing tab id.
      return undefined;
    }
  };

  /**
   * Waits until the tab's own document has committed to a page the debugger can
   * attach to. Chrome creates a tab on `about:blank` and commits the requested
   * navigation a moment later — on a loaded CI runner longer than any fixed
   * sleep — so this wakes on `tabs.onUpdated` and re-reads the tab as a safety
   * net when the event is missed. Bounded: a tab that never commits yields
   * `undefined`, and a loaded tab at a URL no grant can name is final at once.
   */
  const committedTabUrl = async (tabId: number): Promise<string | undefined> => {
    const updated = tabsApi.onUpdated;
    const deadline = Date.now() + TAB_COMMIT_TIMEOUT_MS;

    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- one read per round trip, in commit order
      const tab = await tabProgressOf(tabId);

      if (tab === undefined) {
        return undefined;
      }

      if (isInspectablePageUrl(tab.url)) {
        return tab.url;
      }

      // Only positive evidence of a navigation in flight is worth waiting for: a loaded tab at a URL no grant can name (a `chrome://` page, a user's `about:blank`) will not become inspectable.
      if (tab.pendingUrl === undefined && tab.status !== 'loading') {
        return undefined;
      }

      if (Date.now() >= deadline) {
        return undefined;
      }

      const { promise: wake, resolve: signal } = Promise.withResolvers<void>();
      const listener: TabUpdateListener = changedTabId => {
        if (changedTabId === tabId) {
          signal();
        }
      };
      const timer = setTimeout(signal, TAB_COMMIT_POLL_MS);

      updated?.addListener(listener);

      try {
        // eslint-disable-next-line no-await-in-loop -- one bounded wait for the tab's next change
        await wake;
      } finally {
        clearTimeout(timer);
        updated?.removeListener(listener);
      }
    }
  };

  const reachable = async (tabId: number): Promise<EvalTabResult | undefined> => {
    // A session's own tab starts blank, and the precheck exists to protect the user's browser-internal pages.
    // It cannot judge this tab, so the attach reports what it cannot reach.
    if (sessionOwnedTabs.has(tabId)) {
      return undefined;
    }

    const reach = await getInspectableTab({ tabId, tabsApi });

    if (reach.ok) {
      return undefined;
    }

    // A tab the browser opened for a page is `about:blank` until its document commits; that is a page still loading, not a tab out of reach.
    if ((await committedTabUrl(tabId)) !== undefined) {
      return undefined;
    }

    await disposeTab(tabId);
    return { error: reach.error, ok: false };
  };

  /**
   * Asks the tab's target to refuse downloads, the deprecated page-level spelling
   * of the browser method. `chrome.debugger` refuses it — it is classified as a
   * browser-level command, which a tab attachment may not send — so this is
   * defence in depth for a target that does honour it; `armDownloadGuard` is the
   * guard that always runs.
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

  /**
   * The guard one guarded call runs: the download stream, read at call time so
   * a grant or revoke is seen. `undefined` when the optional permission is
   * missing — the caller then refuses the call rather than run it unguarded.
   */
  const armGuard = (api: BrowserDownloadsApi, attribution: DownloadAttribution): DownloadGuard =>
    armDownloadGuard(api, attribution);

  /** Whether the tab now sits on the page a navigate asked for; a download never loads it. */
  const navigationLanded = (tabId: number, destination: string) => async (): Promise<boolean> => {
    const tab = await tabsApi.get?.(tabId);

    return pageOf(tab?.url) === pageOf(destination);
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
    readFrames: () => Promise<AgentFrameInventory>,
    authorized: readonly BrowserGrant[]
  ): Promise<readonly string[]> => {
    const { frames } = await readFrames();
    const readable = authorized.filter(grant => grant.class === 'read').map(grant => grant.origin);

    return withheldFramesOf(frames, readable).map(frame => frame.origin);
  };

  const needsPermissionOutcome = (
    items: readonly BrowserPermissionItem[],
    stepToken: string | undefined,
    afterAction?: boolean,
    keptFiles: readonly string[] = []
  ): BrowserToolRunOutcome => ({
    items,
    kind: 'needs_permission',
    // A file the guard could not delete is named: the refusal must not read as "nothing was written".
    result: {
      error:
        keptFiles.length === 0
          ? NEEDS_PERMISSION_ERROR
          : `The browser action needs permission for this origin. The browser had already saved ${keptFiles.join(', ')} in the downloads folder before the download could be stopped.`,
      ok: false,
    },
    ...(stepToken === undefined ? {} : { stepToken }),
    ...(afterAction === true ? { afterAction: true } : {}),
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
      const tabSession = sessionFor(tabId).bindCaller(browserCallerKey(caller), {
        cancelled: () => taken,
      });
      const session = tabSession;

      // One frame read per call: the grant check, the tool (a screenshot masks from the same tree) and the withheld report share it.
      const readFrames = createAgentFrameReader(session);

      try {
        const agentContext = caller.kind === 'agent' ? (agent ?? { authorized: [] }) : undefined;
        const argsRecord = parseToolArguments(toolArguments);
        // Every step token is bound to the calling session, the tab, the tool and the exact arguments.
        const sessionKey = caller.kind === 'agent' ? caller.sessionHandle : '';
        const issueSensitiveToken = (sensitive: BrowserSensitiveStep): string =>
          tokens.issue({
            argumentHash: hashBrowserToolArguments(argsRecord),
            element: sensitive.element,
            origin: sensitive.origin,
            reason: sensitive.reason,
            session: sessionKey,
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
                sessionHandle: sessionKey,
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

        // A download approval is post-action, so the gate cannot classify it on retry; a presented token bound to this session, tab, tool and argument set disables the guard once.
        const downloadApproved =
          agentContext !== undefined && preflight !== undefined && preflight.ok
            ? (agentContext.sensitive ?? []).some(token =>
                tokens.consume(token, {
                  argumentHash: hashBrowserToolArguments(argsRecord),
                  origin: preflight.origin,
                  session: sessionKey,
                  tabId,
                  toolName,
                })
              )
            : false;

        // An unapproved act call runs with downloads denied: a download it starts is cancelled, then reported as a sensitive step.
        const guardDownloads =
          agentContext !== undefined &&
          preflight !== undefined &&
          (preflight.class === 'act' || preflight.class === 'navigate') &&
          canStartDownload(toolName, argsRecord) &&
          preflight.sensitiveToken === undefined &&
          !downloadApproved;

        // Read the optional permission at call time: it can be granted or revoked while this worker lives.
        const guardApi = downloadsApi?.();
        const guardTab = guardDownloads ? await guardTabOf(tabsApi, tabId) : undefined;
        // The tabs this call owns: its own plus any it opens (`browser_tabs new`, a link with a target).
        // The session's other tabs belong to the user or to another call, so a download there is not this call's.
        const callTabs = new Set<number>([tabId]);
        const noteOwnedTab = (openedTabId: number, openerTabId: number | undefined): void => {
          if (openerTabId === tabId) {
            callTabs.add(openedTabId);
          }
        };
        const noteBrowserOpenedTab = (opened: {
          readonly id?: number;
          readonly openerTabId?: number;
        }): void => {
          if (opened.id !== undefined) {
            noteOwnedTab(opened.id, opened.openerTabId);
          }
        };

        if (guardTab !== undefined) {
          tabsApi.onCreated?.addListener(noteBrowserOpenedTab);
        }

        const guardTabIds = (): readonly number[] => [...callTabs];
        // A navigate names the document it asked for, so a download that starts after the call returns can still be found.
        const destination =
          preflight?.class === 'navigate' ? argumentText(argsRecord['url']) : undefined;
        const downloadGuard =
          guardTab === undefined || guardApi === undefined
            ? undefined
            : armGuard(guardApi, {
                ...(destination === undefined
                  ? {}
                  : {
                      navigation: {
                        destination,
                        landed: navigationLanded(tabId, destination),
                      },
                    }),
                tab: guardTab,
                tabIds: guardTabIds,
              });

        // No guard without the optional permission: no file may be started, so the call is refused instead of run unguarded.
        if (guardDownloads && downloadGuard === undefined) {
          return {
            kind: 'result',
            result: { error: DOWNLOAD_PERMISSION_MISSING_ERROR, ok: false },
          };
        }

        if (downloadGuard !== undefined) {
          await setDownloadBehavior(session, 'deny');
        }

        const callStartedAt = Date.now();
        let result: EvalTabResult | null = null;
        let settlement: GuardSettlement = { kept: [], stopped: 0 };

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
                    noteTabCreated: (openedTabId, openerTabId) => {
                      noteOwnedTab(openedTabId, openerTabId);

                      return noteTabCreated(openedTabId, openerTabId);
                    },
                  }),
              readFrames,
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
          // Every exit — a result, a take-over, a throw — disarms the guard, so no listener or interception outlives the call.
          if (guardDownloads) {
            await setDownloadBehavior(session, 'default');
          }

          if (downloadGuard !== undefined) {
            // A download the guard saw: the browser named it before the guard stopped and deleted its file.
            settlement = await downloadGuard.settle();
            tabsApi.onCreated?.removeListener?.(noteBrowserOpenedTab);
          }
        }

        // A taken-over call drops its late result: the page belongs to the panel now.
        if (taken) {
          return { kind: 'result', result: { error: TAB_TAKEN_ERROR, ok: false } };
        }

        const settled = result ?? { error: 'The browser tool returned no result.', ok: false };

        // The tab's own target may also have reported one (`Page.downloadWillBegin`), where that is allowed.
        if (
          guardDownloads &&
          takeStartedDownloads(session) + settlement.stopped + settlement.kept.length > 0
        ) {
          const origin = preflight?.ok ? preflight.origin : '';
          const reason = SENSITIVE_REASON.download;

          // The click already ran and the download was cancelled. `afterAction` tells the CLI not to replay it.
          return needsPermissionOutcome(
            [{ class: 'sensitive', origin, reason }],
            preflight?.ok ? issueSensitiveToken({ origin, reason }) : undefined,
            true,
            settlement.kept
          );
        }

        // An approved navigate to an attachment keeps its file and still answers `ERR_ABORTED`: that is a success with no page change, not a failure.
        const keptText =
          downloadApproved &&
          preflight?.class === 'navigate' &&
          destination !== undefined &&
          !settled.ok &&
          settled.error.includes('ERR_ABORTED')
            ? await keptDownloadText(guardApi, destination, callStartedAt)
            : undefined;

        // A download is not a document, so a navigate that became one never moved the tab.
        // An opaque or older origin there is the file's answer, not the redirect this check looks for.
        if (preflight !== undefined && preflight.class === 'navigate' && keptText === undefined) {
          const changed = await postAgentNavigate(session, preflight.origin);

          if (changed !== undefined) {
            return { from: changed.from, kind: 'origin_changed', result: settled, to: changed.to };
          }
        }

        const finalResult: EvalTabResult =
          keptText === undefined ? settled : { ok: true, value: keptText };

        if (agentContext === undefined) {
          return { kind: 'result', result: finalResult };
        }

        // A read never navigates, so its tree is the one the preflight saw; an act or navigate call may have replaced it, and a stale list would under-report.
        const withheldReader =
          preflight?.class === 'read' ? readFrames : createAgentFrameReader(session);

        return {
          kind: 'result',
          result: finalResult,
          withheldFrames: await withheldOriginsFor(withheldReader, agentContext.authorized),
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

    // The tab joins this session, and a tab the session opens may start blank: the attach judges it, not the precheck.
    sessionOwnedTabs.add(tabId);

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

  /**
   * Opens the session's own tab: inactive, in the last focused window, and in
   * the session's `Kilo · <title>` group. The user's current tab keeps focus,
   * which is the whole point of an agent never taking a tab it did not make.
   *
   * The tab opens at `about:blank` and the caller navigates it afterwards
   * through `runTool`, so the download guard is armed before any request
   * leaves: a tab opened *at* a URL would let Chrome start a download the gate
   * never saw.
   */
  const openSessionTab = async ({
    sessionHandle,
  }: BrowserSessionTabInput): Promise<BrowserSessionTabResult | undefined> => {
    const create = tabsApi.create?.bind(tabsApi);

    if (create === undefined) {
      return undefined;
    }

    const [active] = await tabsApi.query({ active: true, lastFocusedWindow: true });
    const created = await create({
      active: false,
      url: 'about:blank',
      ...(active?.windowId === undefined ? {} : { windowId: active.windowId }),
    });

    if (created.id === undefined) {
      return undefined;
    }

    sessionOwnedTabs.add(created.id);

    // Sharing the tab is what titles and colours the group; the tab is not activated by it.
    const shared = await groups.shareActiveTab({ sessionHandle, tabId: created.id });

    return {
      tabId: created.id,
      title: created.title ?? '',
      url: 'about:blank',
      ...(shared.groupId === undefined ? {} : { groupId: shared.groupId }),
    };
  };

  const tabInfo = async (
    tabId: number
  ): Promise<{ readonly title: string; readonly url: string } | undefined> => {
    const tab = await tabsApi.get?.(tabId);

    return tab === undefined ? undefined : { title: tab.title ?? '', url: tab.url ?? '' };
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
    openSessionTab,
    // Turn end: the lease goes, the caller's refs stay. Playwright-like, a ref from an earlier snapshot keeps resolving for as long as the caller and the tab session live.
    releaseCaller: caller => leases.releaseCaller(caller),
    releaseTab: ({ caller, tabId }) => {
      leases.release(tabId, caller);
    },
    runTool,
    shareActiveTab: input => groups.shareActiveTab(input),
    tabInfo,
  };
};
