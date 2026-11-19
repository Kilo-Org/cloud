/* eslint-disable import/max-dependencies, max-lines -- One runtime owns the serial chain, leases, tab groups and the agent gate; splitting it would scatter the per-tab ordering contract. */
import { z } from 'zod';
import {
  AGENT_TAB_OUTSIDE_GROUP_ERROR,
  canStartDownload,
  createStepTokenStore,
  DOWNLOAD_PERMISSION_MISSING_ERROR,
  DOWNLOAD_STEP_TAB_GONE_ERROR,
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
import type {
  BrowserToolDownload,
  BrowserToolSession,
  BrowserToolTabsApi,
} from './browser-tool-session';
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
  /**
   * The call the model made, when the transport runs an equivalent one for it
   * (`browser_tabs new` becomes a navigate on the tab it opened). The step a
   * download is reported against, and the token binds, is this call.
   */
  readonly step?: { readonly arguments: unknown; readonly toolName: string } | undefined;
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
      /** The step the approval is for, when this call is not the step that started the download. */
      readonly step?: { readonly argumentsHash: string; readonly tool: string } | undefined;
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
    /** ISO-8601, as `chrome.downloads.DownloadQuery.startedAfter` requires; a number is rejected. */
    readonly startedAfter?: string;
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
const DOWNLOAD_GUARD_LINGER_MS = 2000;

/** How long an approved navigate waits for the browser to name the file it kept. */
const KEPT_DOWNLOAD_POLLS = 60;
const KEPT_DOWNLOAD_POLL_MS = 50;

/** How long a navigate that did not land on its destination waits for the download the browser owes it. */
const NAVIGATE_DOWNLOAD_POLL_MS = 20;
const NAVIGATE_DOWNLOAD_POLLS = 15;

/**
 * How many ended session handles the runtime remembers: enough that a guard
 * which outlives its session by a moment never opens a record nobody can
 * report, and bounded so a long-lived browser cannot grow it.
 */
const CLOSED_SESSION_LIMIT = 64;

/**
 * How long a refused `browser_tabs new` step remembers the tab it opened, and
 * how many such tabs are remembered at once: the approved repeat redeems its
 * token promptly, and an expired entry is memory.
 */
const STEP_TAB_TTL_MS = 2 * 60_000;
const STEP_TAB_LIMIT = 32;

/**
 * How long an approved call's downloads are its own — the guard's late window, since that is how long a file it
 * Started could still land — and how many such windows a session keeps.
 */
const APPROVED_DOWNLOAD_WINDOW_MS = DOWNLOAD_GUARD_LINGER_MS;
/** How far before an approved call an item may have started and still be its file: a click's request races. */
const APPROVED_WINDOW_SLACK_MS = 50;
/** How long a finished window is remembered, and how many are kept: a search can arrive just after it ends. */
const APPROVED_WINDOW_KEEP_MS = 60_000;
const APPROVED_WINDOW_LIMIT = 8;

/**
 * How long the guard waits for a download it stopped to reach `complete` or
 * `interrupted`. `cancel` resolves on an item that already finished, so the
 * only proof that no file exists is the item's own terminal state.
 */
const DOWNLOAD_SETTLE_POLL_MS = 100;
const DOWNLOAD_SETTLE_POLLS = 20;

/**
 * How long an act call looks for the download its own command started. The
 * browser creates the item a moment after the command returns, so a guard that
 * only listened would leave a file nobody was told about. The call pays this
 * only when it saw nothing, and it stops at the first item it finds.
 */
const DOWNLOAD_OBSERVE_POLL_MS = 10;
const DOWNLOAD_OBSERVE_POLLS = 10;

/**
 * How long an act call waits for a download its own command started. A click
 * that started no navigation pays only the start grace: no document can turn
 * into a file. A navigation holds the call open while it is unanswered, and an
 * announced download for a short grace while the browser names the item,
 * because a file the model was never told about must not appear. All of it is
 * bounded.
 */
const DOWNLOAD_START_GRACE_MS = 40;
const DOWNLOAD_ANNOUNCE_GRACE_MS = 250;
const DOWNLOAD_ANNOUNCE_POLL_MS = 10;
const DOWNLOAD_ANNOUNCE_POLLS = 120;

/**
 * One download this call stopped: its file is gone, still being written, or
 * kept under a name. Every outcome names the file, because a report that
 * arrives after its call has answered can only tell the model what it is.
 */
type DiscardOutcome =
  | { readonly kind: 'kept'; readonly filename: string }
  /** The cancel landed on an item the browser was still writing: the file that lands is deleted off the call's path. */
  | { readonly kind: 'pending'; readonly filename: string }
  | { readonly kind: 'removed'; readonly filename: string };

/** What a guard stopped: files it could not delete, and downloads it stopped or is still finishing. */
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

  const requested = requestedFileName(destination);
  /** Whether the browser created a download at all: a navigate that started none keeps its own error. */
  let created = false;

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
        created = true;
        // An item the browser is still writing carries its target directory as the filename, not a file name: keep
        // Polling until the browser names the file it wrote, so the model is told a name it can look for.
        const written = item.filename?.endsWith('/') === true ? undefined : item.filename;
        const name = written?.split('/').findLast(Boolean);

        if (name !== undefined && name !== '') {
          return `${name}: The file was downloaded; the page did not change.`;
        }
      }
    } catch {
      return undefined;
    }

    // eslint-disable-next-line no-await-in-loop -- bounded wait for the browser to name the item
    await after(KEPT_DOWNLOAD_POLL_MS);
  }

  if (!created) {
    return undefined;
  }

  // The item never named itself inside the window: the file it kept is still the one the navigate asked for.
  return requested === undefined || requested === ''
    ? 'The file was downloaded; the page did not change.'
    : `${requested}: The file was downloaded; the page did not change.`;
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

/** The one field of `Page.getFrameTree` this runtime reads: the main frame's document url. */
const FRAME_TREE_URL = z.object({
  frameTree: z.object({ frame: z.object({ url: z.string().optional() }).optional() }),
});

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
 * Stops one download of this call. The cancel is the call's own business; the
 * file the browser had already finished is deleted here too, because one read
 * of the item says whether there is one. An item the browser is still writing
 * is left to `finishDownload`: a call may not wait for a file nobody reads.
 */
const discardDownload = async (
  api: BrowserDownloadsApi,
  item: BrowserDownloadItem
): Promise<DiscardOutcome> => {
  let cancelled = true;

  try {
    await api.cancel(item.id);
  } catch {
    // Too late for the cancel: the item's own state below says whether a file exists.
    cancelled = false;
  }

  // One read, never a poll: the item's state now is what the browser knows about its file.
  const current = await readDownload(api, item.id);
  const reached = current ?? item;

  // `interrupted` is the browser's own proof that no file exists.
  if (reached.state === 'interrupted') {
    return { filename: fileNameOf(reached), kind: 'removed' };
  }

  if (api.removeFile === undefined) {
    // Nothing can delete a file the browser wrote, so an uncancelled item is a file the user keeps.
    return cancelled
      ? { filename: fileNameOf(reached), kind: 'removed' }
      : { filename: fileNameOf(reached), kind: 'kept' };
  }

  if (reached.state === 'complete') {
    try {
      await api.removeFile(item.id);
      await api.erase?.({ id: item.id });

      return { filename: fileNameOf(reached), kind: 'removed' };
    } catch {
      return { filename: fileNameOf(reached), kind: 'kept' };
    }
  }

  // Still in progress: the call reports the download now, and whatever file lands is deleted off its path.
  void finishDownload(api, item.id);

  return cancelled
    ? { filename: fileNameOf(reached), kind: 'removed' }
    : { filename: fileNameOf(reached), kind: 'pending' };
};

/** One read of a download's own state; `undefined` when the browser has no such item. */
const readDownload = async (
  api: BrowserDownloadsApi,
  id: number
): Promise<BrowserDownloadItem | undefined> => {
  try {
    const found = await api.search?.({ id });

    return found?.find(candidate => candidate.id === id);
  } catch {
    return undefined;
  }
};

/**
 * Deletes the file of a download the call could not settle, after the call has
 * answered: the browser may need a moment to finish writing it, and the tab
 * must not wait for a file the model does not read.
 */
const finishDownload = async (api: BrowserDownloadsApi, id: number): Promise<void> => {
  await settledDownload(api, id);

  try {
    await api.removeFile?.(id);
    await api.erase?.({ id });
  } catch {
    // No file was written, or this browser will not delete it; there is no caller left to tell.
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
    // eslint-disable-next-line no-await-in-loop -- bounded wait for the browser to finish the item
    const item = await readDownload(api, id);

    if (item === undefined || item.state === 'complete' || item.state === 'interrupted') {
      return item;
    }

    // eslint-disable-next-line no-await-in-loop -- see above
    await after(DOWNLOAD_SETTLE_POLL_MS);
  }

  return readDownload(api, id);
};

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
      const found = await api.search?.({
        // Chrome validates this as an ISO-8601 string; a number is a rejected query, not a wider window.
        startedAfter: new Date(startedAt).toISOString(),
        url: navigation.destination,
      });
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
  /**
   * The step that owns this guard: the tool, arguments, session and tab that ran.
   * A download it stops is reported against that step, so the model repeats the
   * call that started the file rather than the call that carried the news.
   */
  readonly step?: DownloadStep | undefined;
  readonly tab: { readonly tabId: number; readonly url: string };
  /** Tabs this call owns, including one it opened. */
  readonly tabIds: () => readonly number[];
  /** What the tab says about the download this call started; absent when there is nothing to watch. */
  readonly witness?: DownloadWitness | undefined;
}

/**
 * The step a download belongs to, captured before the guard runs: the exact
 * binding a step token is issued against, and the words a report repeats back.
 */
interface DownloadStep {
  readonly argumentHash: string;
  /** How a report names the step: `click on 'Download report'`, `navigation to https://…`. */
  readonly description: string;
  /** The noun a report tells the model to repeat: `click`, `navigation`. */
  readonly noun: string;
  readonly origin: string;
  readonly session: string;
  readonly tabId: number;
  readonly toolName: string;
}

/**
 * How a refused download names the step that started it, so the model repeats
 * that step instead of the call that happened to carry the report.
 */
const downloadStepText = (toolName: string, args: Record<string, unknown>) => {
  if (toolName === 'browser_click') {
    const element =
      argumentText(args['element']) ??
      argumentText(args['target']) ??
      argumentText(args['selector']);

    return element === undefined
      ? { description: 'click', noun: 'click' }
      : { description: `click on '${element}'`, noun: 'click' };
  }

  if (toolName === 'browser_navigate') {
    const url = argumentText(args['url']);

    return url === undefined
      ? { description: 'navigation', noun: 'navigation' }
      : { description: `navigation to ${url}`, noun: 'navigation' };
  }

  return { description: `${toolName} call`, noun: 'call' };
};

/**
 * What the tab shows about the download a call's own command started: the
 * browser announces a download (`Browser.downloadWillBegin`) and records the
 * navigation that produced it. A call that started no navigation cannot have
 * started one of these, so it never waits for a file.
 */
interface DownloadWitness {
  /** The downloads the tab announced since the last read, drained so each is claimed exactly once. */
  readonly takeAnnounced: () => readonly BrowserToolDownload[];
  /**
   * Navigations this call started that the browser has not answered yet. Only a
   * document can turn into a download; an ordinary click's `fetch` must not
   * hold the call open.
   */
  readonly pendingNavigation: () => number;
  /** Whether a response this call received was served as an attachment, which is a download on its way. */
  readonly attachmentResponse: () => boolean;
  /**
   * The announcement itself, as it happens: a guard that stays on duty for a
   * late download has to know the browser named one before the item exists,
   * because the call that comes next may already be reading the report.
   */
  readonly watchAnnounced?:
    | ((listener: (download: BrowserToolDownload) => void) => () => void)
    | undefined;
}

/**
 * Where a call's linger goes. A guard that started no download stays armed
 * briefly for a late one, but it outlives its call: the runtime keeps the
 * linger per tab and the next download-capable call on that tab ends it first,
 * so an already answered guard never cancels a download a later call — an
 * approved repeat above all — started. The linger only stops files: what the
 * model is told about them belongs to the download ledger, which outlives it.
 */
interface LingerSink {
  /** A linger is now armed for this tab: `end` stops it acting on any download that starts later, and `since` is the call's own start. */
  readonly armed: (arm: { readonly end: () => void; readonly since: number }) => void;
  /** The linger ended, by its own window or by the runtime: the tab no longer holds one. */
  readonly ended: () => void;
}

/**
 * One download the runtime still owes a report for, from the browser's
 * announcement to the call that names it. It is keyed by the browser's own
 * identity — the announcement's guid, or the url it named, then the item's id
 * once it exists — so a file is stopped and reported exactly once whatever
 * order the events arrive in.
 */
interface DownloadRecord {
  /** `guid:<guid>`, `url:<url>` for an announcement without one, or `item:<id>` for an item nothing announced. */
  readonly id: string;
  /** The session that owns the download: only a call of that session reports it, and only that session can redeem its token. */
  readonly session: string;
  /** The guard attempt that started it: a guard counts only the downloads its own attempt owns. */
  readonly attempt: string;
  readonly tabId: number;
  /** The step that started the file, which the report asks the model to repeat. */
  readonly step: DownloadStep | undefined;
  /** The announced url, which names the item before the browser creates it. */
  readonly url: string | undefined;
  /** When the browser named it: the window a later search looks for its item in. */
  readonly since: number;
  /** The browser's item once it exists: the same file is never stopped twice. */
  readonly itemId: number | undefined;
  readonly filename: string;
  /**
   * Where the download stands. `announced`: the browser named it and no item is
   * linked yet. `stopping`: its item is being cancelled and deleted. `stopped`:
   * no file survived the cancel. `kept`: the browser had already written the
   * file and would not delete it. `reported`: the call that started it already
   * told the model, so no later call may report it again.
   */
  readonly kind: 'announced' | 'stopping' | 'stopped' | 'kept' | 'reported';
}

/** One download as a later call reports it: the file it was, whether it survived, and the step that started it. */
interface DownloadReport {
  readonly filename: string;
  /** The browser would not delete the file, so the human keeps it where it landed. */
  readonly kept: boolean;
  readonly step: DownloadStep | undefined;
  /** The tab the download belongs to: for a `browser_tabs new` step, the tab that step opened. */
  readonly tabId: number;
}

/** A download as a guard sees it: what the ledger needs to open or find its one record. */
interface DownloadSighting {
  readonly attempt: string;
  readonly filename: string;
  readonly guid: string | undefined;
  readonly session: string;
  readonly step: DownloadStep | undefined;
  readonly tabId: number;
  readonly url: string | undefined;
}

/** What a guard's item means for its own settlement: count it, and whether the file still needs stopping. */
type DownloadClaim =
  /** A record this attempt opened: the call stops the file and reports it. */
  | 'own'
  /** This attempt announced it before the item existed: the call still reports it, already counted once. */
  | 'linked'
  /** The model was already told, or an earlier attempt owns it: stop the file, count and report nothing here. */
  | 'silent'
  /** The item is already being stopped by whoever owns it: nothing left for this guard to do. */
  | 'handled';

/** What a guard tells the runtime about the downloads it sees, and what the runtime says back. */
interface DownloadLedger {
  /** The browser announced a download before creating it: open its record, or leave the one an earlier attempt opened to that attempt. */
  readonly announced: (sighting: DownloadSighting) => 'own' | 'earlier';
  /** The browser created the item: link it to its record, or open one, and say who reports it. */
  readonly stopping: (sighting: DownloadSighting & { readonly itemId: number }) => DownloadClaim;
  /** The stop settled: the record keeps the file's own outcome, so a later report never invents one. */
  readonly settled: (session: string, itemId: number, outcome: DiscardOutcome) => void;
  /** The call that started these downloads reported them itself: no later call may name them again. */
  readonly answered: (session: string, attempt: string) => void;
}

/** The window one guarded call left open on a tab: what a later call searches for, and the step a file it finds belongs to. */
interface OpenWatch {
  readonly attempt: string;
  readonly since: number;
  readonly session: string;
  readonly step: DownloadStep | undefined;
  readonly tabId: number;
}

/** A download's url, or `undefined` when the browser reports none: the identity its announcement is matched by. */
const downloadUrlOf = (item: { readonly url?: string | undefined }): string | undefined =>
  item.url === undefined || item.url === '' ? undefined : item.url;

/** Whether the browser created this item at or after `since`; an item with no readable time is taken as new. */
const startedSince = (item: BrowserDownloadItem, since: number): boolean => {
  if (item.startTime === undefined) {
    return true;
  }

  const created = Date.parse(item.startTime);

  return Number.isNaN(created) || created >= since;
};

/** When the browser created this item, for the record whose window has to cover that moment: now if unreadable. */
const itemStartOf = (item: BrowserDownloadItem): number => {
  const created = item.startTime === undefined ? Number.NaN : Date.parse(item.startTime);

  return Number.isNaN(created) ? Date.now() : created;
};

/** The file name a url asks for: its path's last non-empty segment, decoded, without the query. */
const requestedFileName = (url: string): string | undefined => {
  try {
    const last = new URL(url).pathname.split('/').findLast(Boolean);

    return last === undefined || last === '' ? undefined : decodeURIComponent(last);
  } catch {
    return undefined;
  }
};

/**
 * What a late report says: the step that started the file, what became of it,
 * and the step to repeat — never the call that happened to carry the news. The
 * grant that follows adds its own "Approved." line, so this text only says that
 * the file was stopped for want of approval and that the repeat receives it.
 */
const lateDownloadError = (files: readonly DownloadReport[]): string => {
  const names = [...new Set(files.map(file => file.filename))].join(', ');
  const step = files.findLast(file => file.step !== undefined)?.step;
  const head = step === undefined ? 'A browser action' : `The ${step.description}`;
  const repeat =
    step === undefined
      ? 'Repeat that step after the download is approved to receive the file.'
      : `Repeat that ${step.noun} after the download is approved to receive the file.`;
  // A file the browser had already written was not deleted; the refusal must not read as "nothing was written".
  const saved = files.some(file => file.kept)
    ? ` The browser had already saved ${names} before the download could be stopped.`
    : '';

  return `${head} started a download of ${names}, which was stopped: downloading a file needs your approval. ${repeat}${saved}`;
};

/**
 * The downloads an act call started that the stream has not named yet, searched
 * for because the browser creates the item a moment after the call's own
 * command returns. A guard that only listened would leave the linger deleting a
 * file the model was never told about.
 */
const observeDownloads = async ({
  api,
  mine,
  polls,
  startedAt,
}: {
  readonly api: BrowserDownloadsApi;
  /** Whether an item is this call's own, by the same attribution the stream uses. */
  readonly mine: (item: BrowserDownloadItem) => boolean;
  /** How many searches to spend: one for a call that saw no sign, the bounded window for one that did. */
  readonly polls: number;
  readonly startedAt: number;
}): Promise<readonly BrowserDownloadItem[]> => {
  for (let attempt = 0; attempt < polls; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop -- one search per bounded attempt
      const found = await api.search?.({ startedAfter: new Date(startedAt).toISOString() });
      const started = (found ?? []).filter(item => mine(item));

      if (started.length > 0) {
        return started;
      }
    } catch {
      // A search that fails leaves the listener's own window as the only evidence.
      return [];
    }

    // eslint-disable-next-line no-await-in-loop -- bounded wait for the browser to create it
    await after(DOWNLOAD_OBSERVE_POLL_MS);
  }

  return [];
};

/** Whether a response was served as an attachment: the one answer that becomes a download instead of a page. */
const isAttachment = (request: { readonly responseHeaders?: Record<string, string> }): boolean =>
  Object.entries(request.responseHeaders ?? {}).some(
    ([name, value]) =>
      name.toLowerCase() === 'content-disposition' && value.toLowerCase().includes('attachment')
  );

/**
 * Holds an act call open just long enough for the download its own command
 * started to show up. A call that started no navigation pays only the start
 * grace: no document can turn into a file. A navigation keeps the call open
 * while it is unanswered, and an announced download for a short grace while
 * the browser names the item. Returns how many downloads the tab announced, so
 * a call that stopped none still reports what it caused, and whether it saw any
 * sign of a download at all — an ordinary click sees none and pays no more.
 */
const awaitStartedDownload = async ({
  announced,
  attachmentResponse,
  pendingNavigation,
  stopped,
}: {
  readonly announced: () => number;
  readonly attachmentResponse: () => boolean;
  readonly pendingNavigation: () => number;
  /** Whether the guard already has a download of its own: the item was named while waiting. */
  readonly stopped: () => boolean;
}): Promise<{ readonly announced: number; readonly signalled: boolean }> => {
  const start = Date.now();
  let count = 0;
  let started = false;
  let idleAt = start;

  for (let attempt = 0; attempt < DOWNLOAD_ANNOUNCE_POLLS; attempt += 1) {
    count += announced();

    if (stopped()) {
      return { announced: count, signalled: true };
    }

    const now = Date.now();
    const pending = pendingNavigation();

    if (!started && (count > 0 || pending > 0 || attachmentResponse())) {
      started = true;
      // The grace starts at the first sign of a download and is never restarted by that same sign: an announced
      // Download the browser has not named yet would otherwise hold the call open for the whole bound.
      idleAt = now;
    }

    // A call that started no navigation cannot have started a download: the start grace is all it pays.
    if (!started) {
      if (now - start >= DOWNLOAD_START_GRACE_MS) {
        return { announced: count, signalled: false };
      }
    } else if (count === 0 && pending === 0 && now - idleAt >= DOWNLOAD_ANNOUNCE_GRACE_MS) {
      // Its navigation answered with a page, and no download was announced in the grace: nothing is coming.
      return { announced: count, signalled: true };
    } else if (count > 0 && now - idleAt >= DOWNLOAD_ANNOUNCE_GRACE_MS) {
      // The tab announced a download: the browser names the item a moment later, then the wait is over.
      return { announced: count, signalled: true };
    }

    // eslint-disable-next-line no-await-in-loop -- one live-state poll per bounded attempt
    await after(DOWNLOAD_ANNOUNCE_POLL_MS);
  }

  return { announced: count, signalled: started };
};

/**
 * The guard that uses the optional `downloads` permission: the browser names a
 * download when it creates it, and every item this call started is cancelled
 * and its file deleted. It is the only guard: it sees `blob:` and `data:`
 * downloads, which issue no network request at all.
 *
 * Everything it waits for is bounded and cheap — a cancel, one state read, a
 * short search for a download that lands after the command returned — because
 * the next call on the tab waits behind this one. A file the browser is still
 * writing is deleted after the call has answered.
 */
const armDownloadGuard = (
  api: BrowserDownloadsApi,
  attribution: DownloadAttribution,
  hooks: {
    /** This guard's own name: a record is counted by the attempt that opened it, never by a later one. */
    readonly attempt: string;
    readonly ledger: DownloadLedger;
    readonly linger: LingerSink | undefined;
  }
): DownloadGuard => {
  const { ledger, linger } = hooks;
  const { attempt } = hooks;
  const { navigation, step, tab, tabIds } = attribution;
  const session = step?.session ?? '';
  const startedAt = Date.now();
  /** One stop per download: the stream and the searches name the same item, and it is stopped once. */
  const stops = new Map<number, Promise<DiscardOutcome>>();
  /**
   * Whether the tab created this item before this guard existed. Such a file is
   * another call's — an approved step's late download above all — and this guard
   * must not cancel it: the approval it bought dies at the next guarded call, not
   * at the file it started.
   */
  const notThisCalls = (item: BrowserDownloadItem): boolean => {
    if (item.startTime === undefined) {
      return false;
    }

    const created = Date.parse(item.startTime);

    return !Number.isNaN(created) && created < startedAt;
  };
  const owned = (item: BrowserDownloadItem): boolean =>
    (item.tabId === undefined || tabIds().includes(item.tabId)) && !notThisCalls(item);
  /** The announcement subscription: only a linger keeps one, and it ends with the linger. */
  let stopWatching: (() => void) | undefined = undefined;
  let created = false;
  let listening = true;
  let lingering = false;
  /** The call answered: a stop from here on belongs to the record alone, and nothing may add to its report. */
  let closed = false;
  /** Downloads this attempt announced that no item is linked to yet: this call reports them, the linger stops them. */
  let announced = 0;

  /** What the ledger needs to open or find this guard's one record for a download. */
  const sighting = (input: {
    readonly filename: string;
    readonly guid?: string | undefined;
    readonly itemId?: number | undefined;
    readonly url: string | undefined;
  }): DownloadSighting & { readonly itemId: number } => ({
    attempt,
    filename: input.filename,
    guid: input.guid,
    itemId: input.itemId ?? -1,
    // A guard only exists for an agent call, so its step is always the one a report repeats.
    session,
    step,
    tabId: tab.tabId,
    url: input.url,
  });

  /**
   * Claims an announcement for this attempt. The tab also names downloads an
   * earlier guard is still watching, and those are that attempt's: counting one
   * here would refuse a call that started nothing and bury the earlier report.
   */
  const noteAnnouncement = (download: BrowserToolDownload): void => {
    const url = download.url === undefined || download.url === '' ? undefined : download.url;
    const filename = download.suggestedFilename ?? url?.split('/').pop() ?? 'the downloaded file';

    if (ledger.announced(sighting({ filename, guid: download.guid, url })) === 'own') {
      announced += 1;
    }
  };

  /** The downloads the tab announced since the last read, claimed once each, returning this attempt's new ones. */
  const takeAnnouncements = (): number => {
    const seen = attribution.witness?.takeAnnounced() ?? [];
    const before = announced;

    for (const download of seen) {
      noteAnnouncement(download);
    }

    return announced - before;
  };

  const stop = (item: BrowserDownloadItem): void => {
    if (stops.has(item.id)) {
      return;
    }

    const url = item.url === undefined || item.url === '' ? undefined : item.url;
    const claim = ledger.stopping(sighting({ filename: fileNameOf(item), itemId: item.id, url }));

    if (claim === 'handled') {
      return;
    }

    created = true;

    const discarded = discardDownload(api, item);

    if (!closed && (claim === 'own' || claim === 'linked')) {
      stops.set(item.id, discarded);
    }

    if (!closed && claim === 'linked') {
      // The announcement already made this download the call's own: the stop only finishes it.
      announced -= 1;
    }

    void (async (): Promise<void> => {
      // The record keeps the file's own outcome, so a later report never claims a surviving file was deleted.
      ledger.settled(session, item.id, await discarded);
    })();
  };

  const listener = (item: BrowserDownloadItem): void => {
    // A file the tab created before this guard existed, or inside an approval's window, is another step's.
    if (notThisCalls(item)) {
      return;
    }

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

    stop(item);
  };

  const disarm = (): void => {
    if (listening) {
      listening = false;
      api.onCreated.removeListener(listener);
    }
  };

  const listen = (): void => {
    if (!listening) {
      listening = true;
      api.onCreated.addListener(listener);
    }
  };

  const report = async (): Promise<GuardSettlement> => {
    const outcomes = await Promise.all(stops.values());

    return {
      kept: outcomes.flatMap(outcome => (outcome.kind === 'kept' ? [outcome.filename] : [])),
      // A download whose file is still being written counts as stopped too: the guard is deleting whatever lands.
      stopped: outcomes.filter(outcome => outcome.kind !== 'kept').length,
    };
  };

  api.onCreated.addListener(listener);

  return {
    settle: async () => {
      if (navigation !== undefined && api.search !== undefined) {
        // A navigate that became a download never reaches its destination, so the tab answers at once.
        const landed = created || (await navigation.landed().catch(() => true));

        if (!landed) {
          for (const item of await findNavigateDownloads({ api, navigation, owned, startedAt })) {
            stop(item);
          }
        }

        // A navigate is announced too, and its item may land after the search gives up: the claim is what the
        // Call reports, and the linger still stops the file.
        takeAnnouncements();
      }

      // An act call's download is created a moment after its own command returns, so the guard waits for it.
      // The wait follows the navigation it started while that navigation is unanswered, then looks for the item.
      // Without this the linger would delete a file the model was never told about.
      let signalled = false;

      if (navigation === undefined && attribution.witness !== undefined) {
        const waited = await awaitStartedDownload({
          announced: takeAnnouncements,
          attachmentResponse: attribution.witness.attachmentResponse,
          pendingNavigation: attribution.witness.pendingNavigation,
          stopped: () => stops.size > 0,
        });

        ({ signalled } = waited);
      }

      // One search always: the browser can create an item without announcing it, and the model must be told about
      // A file this call started. Only a call that saw a sign of a download waits for it — an ordinary click pays
      // One round trip, and a file that lands later is the next call's to find and report.
      if (!created && navigation === undefined) {
        for (const item of await observeDownloads({
          api,
          mine: candidate =>
            !notThisCalls(candidate) && startedByThisCall(candidate, tab, tabIds()),
          polls: signalled ? DOWNLOAD_OBSERVE_POLLS : 1,
          startedAt,
        })) {
          stop(item);
        }
      }

      /** Keeps the guard listening for a late item, and hands the runtime a way to end it at the next guarded call. */
      const lingerOn = (): void => {
        // Nothing of this call's was stopped, so the call does not pay for a window it may never need. The listener
        // Stays armed so a download whose headers arrive late is deleted too; the runtime ends it at the tab's next
        // Download-capable call, which is why an approved repeat's file is never cancelled by the guard that asked.
        const end = (): void => {
          if (!lingering) {
            return;
          }

          lingering = false;
          disarm();
          stopWatching?.();
          stopWatching = undefined;
          linger?.ended();
        };

        lingering = true;
        listen();
        // The browser names a download before the item exists: the record opens now, so the very next call —
        // Whichever tool it is — can report it without waiting for the item to appear.
        stopWatching = attribution.witness?.watchAnnounced?.(download => {
          if (lingering) {
            noteAnnouncement(download);
          }
        });
        linger?.armed({ end, since: startedAt });
        void (async (): Promise<void> => {
          await after(DOWNLOAD_GUARD_LINGER_MS);
          end();
        })();
      };

      // An announcement that arrived while the guard searched belongs to this call too, before anything is reported.
      takeAnnouncements();

      if (stops.size === 0 && announced === 0) {
        lingerOn();

        return { kept: [], stopped: 0 };
      }

      const settlement = await report();

      // Every file this call reports is the model's now: no later call may name it again, and the record that
      // Still has to finish stopping an unapproved file stays silent.
      ledger.answered(session, attempt);
      closed = true;

      if (settlement.stopped === 0) {
        // The tab announced a download the browser has not named yet: this call reports it now, and the linger
        // Still deletes whatever lands, so no file is kept unapproved and none vanishes unreported.
        lingerOn();

        return { kept: settlement.kept, stopped: announced };
      }

      disarm();

      // A download the tab announced but did not yet hand over belongs to this call too: the model is told about it.
      return announced === 0
        ? settlement
        : { kept: settlement.kept, stopped: settlement.stopped + announced };
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
  // The linger a finished call left armed on a tab: the next download-capable call on that tab ends it before it
  // Can act on what that call starts. A read leaves it on duty, and the records below survive it either way.
  const lingers = new Map<number, () => void>();
  /**
   * The window a guard left open, per tab: the item it never saw is searched for by the next call of its own
   * session, so a download that lands after its call answered is stopped and reported even when the browser named
   * it after the linger had ended.
   */
  const openWatches = new Map<number, OpenWatch>();
  /** One record per download a session still owes a report for: the only bookkeeping a file that outlived its call has. */
  const downloadRecords = new Map<string, Map<string, DownloadRecord>>();
  /** Session handles that ended: no call can report for one again, so a lingering guard must not open a record for it. */
  const closedSessions = new Set<string>();
  /** Names one guard attempt; a record is counted by the attempt that opened it and by no other. */
  let attempts = 0;
  /**
   * The windows in which a call ran with its downloads approved, per session: a file a human approved is that
   * call's, so no later search may stop it however closely it matches an older record for the same url.
   */
  const approvedWindows = new Map<string, { readonly from: number; readonly to: number }[]>();
  /** When each session last ran a call with its downloads approved: a later item of the same url is that call's. */
  const lastApprovedAt = new Map<string, number>();

  /** Notes that this session's call runs with its downloads approved, and forgets windows that are over. */
  const noteApprovedWindow = (session: string, from: number): void => {
    const kept = (approvedWindows.get(session) ?? []).filter(
      window => window.to >= from - APPROVED_WINDOW_KEEP_MS
    );

    kept.push({ from, to: from + APPROVED_DOWNLOAD_WINDOW_MS });

    approvedWindows.set(session, kept.slice(-APPROVED_WINDOW_LIMIT));
    lastApprovedAt.set(session, from);
  };

  /** Whether the browser created this item while an approved call was running: then it is that call's file. */
  const startedByApprovedCall = (session: string, item: BrowserDownloadItem): boolean => {
    const at = itemStartOf(item);

    return (approvedWindows.get(session) ?? []).some(
      window => window.from - APPROVED_WINDOW_SLACK_MS <= at && at <= window.to
    );
  };

  /**
   * The tab a refused download step opened, keyed by the step itself. Its approved repeat navigates that tab: a
   * `browser_tabs new` sent again would open a second tab and download the file twice.
   */
  const stepTabs = new Map<string, { readonly tabId: number; readonly since: number }>();

  /**
   * The step alone identifies its tab: the repeat may arrive on the caller's tab or on the one the step opened, and
   * both are the same approval.
   */
  const stepTabKey = (binding: {
    readonly argumentHash: string;
    readonly session: string;
    readonly toolName: string;
  }): string => [binding.session, binding.toolName, binding.argumentHash].join('|');

  /** Remembers the tab a refused `browser_tabs new` step opened, for the one repeat its token buys. */
  const rememberStepTab = (step: DownloadStep, openedTabId: number): void => {
    if (step.toolName !== 'browser_tabs') {
      return;
    }

    const at = Date.now();

    for (const [key, entry] of stepTabs) {
      if (entry.since + STEP_TAB_TTL_MS < at) {
        stepTabs.delete(key);
      }
    }

    stepTabs.set(stepTabKey(step), { since: at, tabId: openedTabId });

    // Bounded: only a token that is about to be redeemed can still read one, and an expired entry is memory.
    while (stepTabs.size > STEP_TAB_LIMIT) {
      const oldest = stepTabs.keys().next().value;

      if (oldest === undefined) {
        break;
      }

      stepTabs.delete(oldest);
    }
  };

  /** The tab a refused step opened, while its entry is live: the repeat redeems its token against this tab. */
  const peekStepTab = (binding: {
    readonly argumentHash: string;
    readonly session: string;
    readonly toolName: string;
  }): number | undefined => {
    const entry = stepTabs.get(stepTabKey(binding));

    return entry === undefined || entry.since + STEP_TAB_TTL_MS < Date.now()
      ? undefined
      : entry.tabId;
  };

  /** The tab's id while the browser still has it: a step whose tab was closed cannot run anywhere. */
  const liveTabOrUndefined = async (tabId: number): Promise<number | undefined> => {
    try {
      const tab = await tabsApi.get?.(tabId);

      return tab === undefined || tab.id === undefined ? undefined : tab.id;
    } catch {
      return undefined;
    }
  };

  /** The tab a refused step opened, taken once: the repeat that redeems the token is the only call that may have it. */
  const takeStepTab = (binding: {
    readonly argumentHash: string;
    readonly session: string;
    readonly toolName: string;
  }): number | undefined => {
    const tabId = peekStepTab(binding);

    stepTabs.delete(stepTabKey(binding));

    return tabId;
  };

  /** A session that ends owes no approval, and its stopped files stay unreported: there is no model left to tell. */
  const closeSessionRecords = (session: string): void => {
    downloadRecords.delete(session);
    approvedWindows.delete(session);
    lastApprovedAt.delete(session);

    // The session's steps are over with it: no later call may resolve one of their tabs.
    for (const key of stepTabs.keys()) {
      if (key.startsWith(`${session}|`)) {
        stepTabs.delete(key);
      }
    }

    closedSessions.add(session);

    // Bounded: an old handle that is reused is reopened explicitly, and only the live ones can hold a record.
    while (closedSessions.size > CLOSED_SESSION_LIMIT) {
      const oldest = closedSessions.values().next().value;

      if (oldest === undefined) {
        break;
      }

      closedSessions.delete(oldest);
    }
  };

  const recordsFor = (session: string): Map<string, DownloadRecord> => {
    const existing = downloadRecords.get(session);

    if (existing !== undefined) {
      return existing;
    }

    const created = new Map<string, DownloadRecord>();

    downloadRecords.set(session, created);

    return created;
  };

  /**
   * A download's one record: by the item the browser created, else by the url its announcement named, and only
   * while that record's own window is live around `at` — a later download of the same url is another call's file.
   */
  const findRecord = (
    session: string,
    input: {
      readonly at?: number | undefined;
      readonly itemId?: number | undefined;
      readonly tabId: number;
      readonly url: string | undefined;
    }
  ): DownloadRecord | undefined => {
    const records = downloadRecords.get(session);

    if (records === undefined) {
      return undefined;
    }

    if (input.itemId !== undefined) {
      for (const record of records.values()) {
        if (record.itemId === input.itemId) {
          return record;
        }
      }

      return undefined;
    }

    if (input.url === undefined) {
      return undefined;
    }

    // An item already linked is another download of the same url: only an unlinked announcement is this one, and
    // A repeated url answers with the newest of them, which is the announcement this item belongs to.
    const at = input.at ?? Date.now();

    return [...records.values()]
      .filter(
        record =>
          record.itemId === undefined &&
          // A reported record may still link the file it announced, but only while that item predates the
          // Session's last approved call: anything the browser started after an approval is that call's file.
          (record.kind !== 'reported' ||
            at < (lastApprovedAt.get(session) ?? Number.POSITIVE_INFINITY)) &&
          record.url === input.url &&
          record.tabId === input.tabId &&
          // A record speaks only for the downloads of its own window: an approved repeat's kept file of the same
          // Url started later, and stopping it would delete a file the human approved and report nothing.
          record.since <= at &&
          at <= record.since + DOWNLOAD_GUARD_LINGER_MS
      )
      .toSorted((left, right) => left.since - right.since)
      .at(-1);
  };

  /** The browser announced a download: one record, and only the attempt that opened it counts it. */
  const announceDownload = (sighting: DownloadSighting): 'own' | 'earlier' => {
    if (closedSessions.has(sighting.session)) {
      // The session is gone: its guard still stops the file, and no record is opened for a model that cannot read it.
      return 'earlier';
    }

    const records = recordsFor(sighting.session);
    const id =
      sighting.guid !== undefined && sighting.guid !== ''
        ? `guid:${sighting.guid}`
        : `url:${sighting.url ?? sighting.filename}`;
    // A guid is the download's identity; a url only names one when the browser gave no guid at all.
    const existing =
      records.get(id) ??
      (sighting.guid === undefined || sighting.guid === ''
        ? findRecord(sighting.session, { tabId: sighting.tabId, url: sighting.url })
        : undefined);

    if (existing !== undefined && (existing.id === id || existing.kind === 'announced')) {
      // The same announcement arrived twice — the linger saw it live, a call drained the buffer — or the same
      // Download was already reported: either way it is not a second download for this call to count.
      return 'earlier';
    }

    records.set(id, {
      attempt: sighting.attempt,
      filename: sighting.filename,
      id,
      itemId: undefined,
      kind: 'announced',
      session: sighting.session,
      since: Date.now(),
      step: sighting.step,
      tabId: sighting.tabId,
      url: sighting.url,
    });

    return 'own';
  };

  /** The browser created the item: link it to its record or open one, and say who stops and reports it. */
  const stopDownload = (
    sighting: DownloadSighting & { readonly itemId: number }
  ): DownloadClaim => {
    const records = recordsFor(sighting.session);
    const existing =
      findRecord(sighting.session, {
        at: Date.now(),
        itemId: sighting.itemId,
        tabId: sighting.tabId,
        url: undefined,
      }) ??
      findRecord(sighting.session, { at: Date.now(), tabId: sighting.tabId, url: sighting.url });

    if (existing === undefined) {
      if (closedSessions.has(sighting.session)) {
        // The session is gone: the file is still stopped, and there is nobody to report it to.
        return 'silent';
      }

      const id = `item:${String(sighting.itemId)}`;

      records.set(id, {
        attempt: sighting.attempt,
        filename: sighting.filename,
        id,
        itemId: sighting.itemId,
        kind: 'stopping',
        session: sighting.session,
        since: Date.now(),
        step: sighting.step,
        tabId: sighting.tabId,
        url: sighting.url,
      });

      return 'own';
    }

    if (existing.itemId !== undefined) {
      // Whoever linked the item first is stopping it: a second cancel would only report the same file twice.
      return 'handled';
    }

    records.set(existing.id, {
      ...existing,
      itemId: sighting.itemId,
      // A reported record stays reported: the model already knows, so this stop must stay silent.
      kind: existing.kind === 'reported' ? 'reported' : 'stopping',
    });

    return existing.attempt === sighting.attempt && existing.kind !== 'reported'
      ? 'linked'
      : 'silent';
  };

  /** The stop settled: the record keeps the file's own outcome, so a later report never invents one. */
  const settleDownload = (session: string, itemId: number, outcome: DiscardOutcome): void => {
    const records = downloadRecords.get(session);

    if (records === undefined) {
      return;
    }

    for (const [key, record] of records) {
      if (record.itemId === itemId && record.kind !== 'reported') {
        records.set(key, { ...record, kind: outcome.kind === 'kept' ? 'kept' : 'stopped' });
      }
    }
  };

  /** The call that started these downloads reported them: no later call may name them again. */
  const answerDownloads = (session: string, attempt: string): void => {
    const records = downloadRecords.get(session);

    if (records === undefined) {
      return;
    }

    for (const [key, record] of records) {
      if (record.attempt === attempt && record.kind !== 'reported') {
        records.set(key, { ...record, kind: 'reported' });
      }
    }
  };

  const ledger: DownloadLedger = {
    announced: announceDownload,
    answered: answerDownloads,
    settled: settleDownload,
    stopping: stopDownload,
  };

  /** Ends whatever linger an earlier call left on this tab: a download-capable call owns the downloads from now on. */
  const endLinger = (tabId: number): void => {
    const end = lingers.get(tabId);

    lingers.delete(tabId);
    end?.();
  };

  /**
   * Hands a tab's downloads to the call that is starting: the earlier linger ends and its watch goes with it,
   * because a file this call starts must never be cancelled by the guard that asked for approval. The records
   * stay: a file already stopped is still reported, and only its own session's next call may report it.
   */
  const takeOverDownloads = (tabId: number): void => {
    endLinger(tabId);
    openWatches.delete(tabId);
  };

  /**
   * Finds and stops the downloads a guard left behind: the item a record only announced, and the file an armed
   * watch never saw. One search, never a poll — the call that arrives reports what the browser knows now, and it
   * never waits on the guard that started the file.
   */
  const finishWatchedDownloads = async (session: string): Promise<void> => {
    const checkedAt = Date.now();
    const records = [...(downloadRecords.get(session)?.values() ?? [])].filter(
      record => record.itemId === undefined && record.kind !== 'stopping'
    );
    const watches = [...openWatches.values()].filter(
      watch => watch.session === session && watch.since + DOWNLOAD_GUARD_LINGER_MS > checkedAt
    );
    const api = downloadsApi?.();

    // A watch whose window is over is not searched again: nothing would have stopped the file anyway.
    if (records.length === 0 && watches.length === 0) {
      return;
    }

    if (api?.search === undefined) {
      // No optional permission: nothing can be searched or deleted, and the records still say what is known.
      return;
    }

    const since = Math.min(
      ...records.map(record => record.since),
      ...watches.map(watch => watch.since)
    );
    // A download the browser reports without a tab is attributed by the page that started it, exactly as the live
    // Listener does, so the candidate tabs' pages are read once for this search.
    const pageByTab = new Map<number, string | undefined>();
    const getTab = tabsApi.get?.bind(tabsApi);

    if (getTab !== undefined) {
      for (const tabId of new Set([
        ...records.map(record => record.tabId),
        ...watches.map(watch => watch.tabId),
      ])) {
        try {
          // eslint-disable-next-line no-await-in-loop -- one read per candidate tab, once per search
          const tab = await getTab(tabId);

          pageByTab.set(tabId, pageOf(tab?.url));
        } catch {
          pageByTab.set(tabId, undefined);
        }
      }
    }

    let found: readonly BrowserDownloadItem[] = [];

    try {
      found = (await api.search({ startedAfter: new Date(since).toISOString() })) ?? [];
    } catch {
      // A search that fails leaves the records to report what the guard already saw.
      return;
    }

    for (const item of found) {
      const owner =
        startedSince(item, since) && !startedByApprovedCall(session, item)
          ? ownerOf({ item, pageByTab, records, session, watches })
          : undefined;

      if (owner !== undefined) {
        // eslint-disable-next-line no-await-in-loop -- one item at a time, and each stop settles its own record
        await stopLateDownload(owner, item, api);
      }
    }
  };

  /** The record, or the armed watch, that owns a download the search found: `undefined` when it is another call's. */
  const ownerOf = (input: {
    readonly item: BrowserDownloadItem;
    readonly pageByTab: ReadonlyMap<number, string | undefined>;
    readonly records: readonly DownloadRecord[];
    readonly session: string;
    readonly watches: readonly OpenWatch[];
  }): (DownloadSighting & { readonly itemId: number }) | undefined => {
    const { item, pageByTab, records, session, watches } = input;
    const at = itemStartOf(item);
    // A download without a tab belongs to the page that started it, the tie the live listener uses; a download
    // With a tab is that tab's, and the session's other tabs belong to the user or to another call.
    const referrer = pageOf(item.referrer);
    const candidateTabs =
      item.tabId === undefined
        ? [
            ...new Set([
              ...records.map(record => record.tabId),
              ...watches.map(watch => watch.tabId),
            ]),
          ].filter(tabId => referrer !== undefined && pageByTab.get(tabId) === referrer)
        : [item.tabId];

    // An item a record already links is being stopped by whoever owns it: a second cancel would report it twice.
    if (
      findRecord(session, { at, itemId: item.id, tabId: item.tabId ?? 0, url: undefined }) !==
      undefined
    ) {
      return undefined;
    }

    for (const tabId of candidateTabs) {
      const record = findRecord(session, { at, tabId, url: downloadUrlOf(item) });
      const watch = watches.find(candidate => candidate.tabId === tabId);
      const owner =
        record ?? (watch !== undefined && startedSince(item, watch.since) ? watch : undefined);

      if (owner === undefined) {
        return undefined;
      }

      return {
        attempt: owner.attempt,
        // The record knows the name the browser announced; a watch only knows the item it just found.
        filename: record === undefined ? fileNameOf(item) : record.filename,
        guid: undefined,
        itemId: item.id,
        session,
        step: owner.step,
        tabId,
        url: downloadUrlOf(item),
      };
    }

    return undefined;
  };

  /** Stops a download a guard left behind and settles its one record: the report reads the true outcome later. */
  const stopLateDownload = async (
    owner: DownloadSighting & { readonly itemId: number },
    item: BrowserDownloadItem,
    api: BrowserDownloadsApi
  ): Promise<void> => {
    if (stopDownload(owner) === 'handled') {
      return;
    }

    settleDownload(owner.session, item.id, await discardDownload(api, item));
  };

  /** The reports this session owes without a search: what the ledger already knows. Each stays as the stop's own memory. */
  const drainDownloadReports = (session: string): readonly DownloadReport[] => {
    const records = downloadRecords.get(session);

    if (records === undefined) {
      return [];
    }

    const reports: DownloadReport[] = [];

    for (const [key, record] of records) {
      // A stop that has not settled is not reported yet: its file may still be kept, and a report now would say it
      // Was deleted and never name the file that survived. The next call reports it once its outcome is known.
      if (record.kind !== 'stopping' && record.kind !== 'reported') {
        // Reported once: the record itself stays, so the same item is never stopped or named a second time.
        records.set(key, { ...record, kind: 'reported' });
        reports.push({
          filename: record.filename,
          kept: record.kind === 'kept',
          step: record.step,
          tabId: record.tabId,
        });
      }
    }

    pruneRecords(session, Date.now());

    return reports;
  };

  /** Forgets reported records once their window is over: nothing can search for their items again, and they are memory. */
  const pruneRecords = (session: string, at: number): void => {
    const records = downloadRecords.get(session);

    if (records === undefined) {
      return;
    }

    for (const [key, record] of records) {
      // A stop that never settled is memory too: nothing will report it, so it may not grow the map.
      const stale =
        record.kind === 'reported' || record.kind === 'stopping'
          ? record.since + DOWNLOAD_GUARD_LINGER_MS < at
          : false;

      if (stale) {
        records.delete(key);
      }
    }

    if (records.size === 0) {
      downloadRecords.delete(session);
    }
  };

  /** Everything this session owes a report for: one search for the items a guard left behind, then the records. */
  const collectDownloadReports = async (session: string): Promise<readonly DownloadReport[]> => {
    await finishWatchedDownloads(session);

    return drainDownloadReports(session);
  };

  const sessionFor = (tabId: number): BrowserToolSession => {
    const existing = sessions.get(tabId);

    if (existing !== undefined) {
      return existing;
    }

    const created = createBrowserToolSession({
      debuggerApi,
      // A live predicate, not a copy: the voucher lasts only while the tab is still a blank one this runtime opened.
      ownedTab: () => sessionOwnedTabs.has(tabId),
      scriptingApi,
      tabId,
      tabsApi,
    });

    sessions.set(tabId, created);
    return created;
  };

  const disposeTab = async (tabId: number): Promise<void> => {
    chains.delete(tabId);
    // A step that opened this tab can never be repeated on it: forgetting the entry keeps a stale approval from
    // Resolving to a dead tab id.
    for (const [key, entry] of stepTabs) {
      if (entry.tabId === tabId) {
        stepTabs.delete(key);
      }
    }
    inFlight.delete(tabId);
    // A closed tab has no next call, so its linger is over and nothing will report what it left: both go with it.
    takeOverDownloads(tabId);
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

  /**
   * The url of the tab's own document, read through the debugger's frame tree —
   * the one URL the browser withholds from `tabs.Tab` on a page the extension
   * may not read. `undefined` when the attach cannot answer at all.
   */
  const frameUrlOf = async (tabId: number): Promise<string | undefined> => {
    try {
      const parsed = FRAME_TREE_URL.safeParse(await sessionFor(tabId).send('Page.getFrameTree'));

      return parsed.success ? parsed.data.frameTree.frame?.url : undefined;
    } catch {
      // A tab the debugger cannot attach to has no readable document, which is what the precheck then reports.
      return undefined;
    }
  };

  /**
   * Whether this tab is one the runtime opened for a session and is still
   * blank. The bit is the runtime's own voucher, so it goes the moment the
   * voucher stops being true: the tab closed, the session that opened it no
   * longer holds it, or a document committed and the precheck can judge it.
   */
  const sessionTabBlank = async (tabId: number): Promise<boolean> => {
    if (!sessionOwnedTabs.has(tabId)) {
      return false;
    }

    const tab = await tabProgressOf(tabId);

    if (tab === undefined || groups.sessionForTab(tabId) === undefined) {
      sessionOwnedTabs.delete(tabId);

      return false;
    }

    // A readable url is authoritative and needs no attach: a blank page keeps the voucher, a real one ends it.
    if (tab.url !== undefined && tab.url !== '') {
      if (tab.url === 'about:blank') {
        return true;
      }

      sessionOwnedTabs.delete(tabId);

      return false;
    }

    // `tabs.Tab` withholds the url of a `chrome://` page, so a tab that committed one would keep the voucher
    // Alive and repeat a failing attach; the debugger's own frame URL is not withheld.
    const committed = await frameUrlOf(tabId);

    if (committed === undefined || committed === '' || committed === 'about:blank') {
      return true;
    }

    sessionOwnedTabs.delete(tabId);

    return false;
  };

  const reachable = async (tabId: number): Promise<EvalTabResult | undefined> => {
    // A session's own tab starts blank, and the precheck exists to protect the user's browser-internal pages.
    // The precheck cannot judge a tab with no readable url, so the attach reports what it cannot reach instead.
    // That voucher ends with the tab's first document: afterwards it is an ordinary tab the precheck judges.
    if (await sessionTabBlank(tabId)) {
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
  const armGuard = (api: BrowserDownloadsApi, attribution: DownloadAttribution): DownloadGuard => {
    const attempt = `attempt-${String((attempts += 1))}`;

    return armDownloadGuard(api, attribution, {
      attempt,
      ledger,
      linger: {
        armed: ({ end, since }) => {
          // One linger per tab: the previous one was ended when this call began. The watch is what a later call of
          // This same session searches with, so a file that lands after the window is still stopped and reported.
          lingers.set(attribution.tab.tabId, end);
          openWatches.set(attribution.tab.tabId, {
            attempt,
            session: attribution.step?.session ?? '',
            since,
            step: attribution.step,
            tabId: attribution.tab.tabId,
          });
        },
        ended: () => {
          lingers.delete(attribution.tab.tabId);
        },
      },
    });
  };

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

  /** The refusal every sensitive step shares: the items to approve, and what the call already did. */
  const needsPermissionOutcome = (
    items: readonly BrowserPermissionItem[],
    answer: {
      readonly afterAction?: boolean;
      /** The model-visible text, when the refusal has to name a step or a file. */
      readonly error?: string;
      readonly keptFiles?: readonly string[];
      /** The step whose repeat needs the approval, when a later call is the one asking. */
      readonly step?: { readonly argumentsHash: string; readonly tool: string };
      readonly stepToken?: string;
    } = {}
  ): BrowserToolRunOutcome => {
    const { afterAction, error, keptFiles = [], step, stepToken } = answer;

    return {
      items,
      kind: 'needs_permission',
      // A file the guard could not delete is named: the refusal must not read as "nothing was written".
      result: {
        error:
          error ??
          (keptFiles.length === 0
            ? NEEDS_PERMISSION_ERROR
            : `The browser action needs permission for this origin. The browser had already saved ${keptFiles.join(', ')} in the downloads folder before the download could be stopped.`),
        ok: false,
      },
      ...(step === undefined ? {} : { step }),
      ...(stepToken === undefined ? {} : { stepToken }),
      ...(afterAction === true ? { afterAction: true } : {}),
    };
  };

  /**
   * The refusal that carries a download an already answered call's linger
   * stopped. Its step token binds the step that started the file — that is the
   * call the model has to repeat — and the text says so, because this call is
   * only the one that happened to be next.
   */
  const lateDownloadRefusal = (
    files: readonly DownloadReport[]
  ): BrowserToolRunOutcome | undefined => {
    if (files.length === 0) {
      return undefined;
    }

    const started = files.findLast(file => file.step !== undefined);
    const step = started?.step;

    // A `browser_tabs new` step opened its tab before the file landed: the approved repeat navigates that tab.
    if (step !== undefined && started !== undefined) {
      rememberStepTab(step, started.tabId);
    }

    const origin = step?.origin ?? '';
    const stepToken =
      step === undefined
        ? undefined
        : tokens.issue({
            argumentHash: step.argumentHash,
            origin: step.origin,
            reason: SENSITIVE_REASON.download,
            session: step.session,
            tabId: step.tabId,
            toolName: step.toolName,
          });

    return needsPermissionOutcome(
      [{ class: 'sensitive', origin, reason: SENSITIVE_REASON.download }],
      {
        afterAction: true,
        error: lateDownloadError(files),
        // The carrying call did not start the file: the CLI has to bind the token to the step that did.
        ...(step === undefined
          ? {}
          : { step: { argumentsHash: step.argumentHash, tool: step.toolName } }),
        ...(stepToken === undefined ? {} : { stepToken }),
      }
    );
  };

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
    step: stepInput,
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
      // A download an earlier call left for this session — stopped, kept, or only announced — has no result of its
      // Own to be reported on: this call reports it before it runs, whatever tool it is, and its token binds the step
      // That started the file. The search here stops a file whose own guard never saw it, so nothing lands silently.
      // A panel call has no session to report to, so it never consumes a model's report.
      if (caller.kind === 'agent') {
        const owed = lateDownloadRefusal(await collectDownloadReports(caller.sessionHandle));

        if (owed !== undefined) {
          return owed;
        }
      }

      const unreachable = await reachable(tabId);

      if (unreachable !== undefined) {
        return { kind: 'result', result: unreachable };
      }

      const { promise: takenAway, resolve: markTaken } = Promise.withResolvers<void>();
      let taken = false;
      // The tab this call ends up driving: the caller's, or the one its step opened. Read by the cleanup below.
      let drivenTabId = tabId;

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
        // The call the model made: a transport may run an equivalent one for it (`browser_tabs new` becomes a
        // Navigate on the tab it opened), and the token must still bind the call the model has to repeat.
        const stepArgumentsRecord =
          stepInput === undefined ? argsRecord : parseToolArguments(stepInput.arguments);
        const stepToolName = stepInput?.toolName ?? toolName;
        const stepHash = hashBrowserToolArguments(stepArgumentsRecord);
        const issueSensitiveToken = (
          sensitive: BrowserSensitiveStep,
          /** The tab the step ran on: a `browser_tabs new` step runs on the tab it opened. */
          tokenTabId: number = tabId
        ): string =>
          tokens.issue({
            argumentHash: stepHash,
            element: sensitive.element,
            origin: sensitive.origin,
            reason: sensitive.reason,
            session: sessionKey,
            tabId: tokenTabId,
            toolName: stepToolName,
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

          return needsPermissionOutcome(preflight.failure.items, {
            // This call is the step: the same shape everywhere, so the CLI has one rule.
            step: { argumentsHash: stepHash, tool: stepToolName },
            ...(preflight.sensitive === undefined
              ? {}
              : { stepToken: issueSensitiveToken(preflight.sensitive) }),
          });
        }

        const stepUrl = argumentText(stepArgumentsRecord['url']);
        const stepOpensTab =
          stepToolName === 'browser_tabs' &&
          stepArgumentsRecord['action'] === 'new' &&
          stepUrl !== undefined;
        // A `browser_tabs new` step ran on the tab it opened, so its token binds that tab. The repeat may arrive on
        // That tab or on the one the CLI held before, and both are the same approval.
        const rememberedTab = stepOpensTab
          ? peekStepTab({ argumentHash: stepHash, session: sessionKey, toolName: stepToolName })
          : undefined;
        // A remembered tab the browser no longer has is gone: the step cannot run, and asking must not console the
        // Approval by burning its token, so the call is refused before anything is consumed.
        const stepTab =
          rememberedTab === undefined ? undefined : await liveTabOrUndefined(rememberedTab);

        if (stepOpensTab && stepTab === undefined && rememberedTab !== undefined) {
          return {
            kind: 'result',
            result: { error: DOWNLOAD_STEP_TAB_GONE_ERROR, ok: false },
          };
        }

        const presentedTokens = agentContext?.sensitive ?? [];

        if (stepOpensTab && stepTab === undefined && presentedTokens.length > 0) {
          return {
            kind: 'result',
            result: { error: DOWNLOAD_STEP_TAB_GONE_ERROR, ok: false },
          };
        }

        // A download approval is post-action, so the gate cannot classify it on retry; a presented token bound to this session, tab, tool and argument set disables the guard once.
        const downloadApproved =
          agentContext !== undefined && preflight !== undefined && preflight.ok
            ? presentedTokens.some(token =>
                tokens.consume(token, {
                  argumentHash: stepHash,
                  origin: preflight.origin,
                  session: sessionKey,
                  tabId: stepTab ?? tabId,
                  toolName: stepToolName,
                })
              )
            : false;

        // A call that can start a download owns the tab's downloads: an earlier call's linger and window end before
        // It runs, so neither cancels a file this call starts — an approved repeat, or the panel's own click, above
        // All. A read never starts one, so it leaves the earlier guard on duty and consumes no report: a file that
        // Lands while it runs is still stopped and named by this session's next call.
        const downloadCapable =
          canStartDownload(toolName, argsRecord) &&
          (agentContext === undefined ||
            (preflight !== undefined &&
              (preflight.class === 'act' || preflight.class === 'navigate')));

        // An unapproved act call runs with downloads denied: a download it starts is cancelled, then reported as a sensitive step.
        const guardDownloads =
          agentContext !== undefined &&
          downloadCapable &&
          preflight !== undefined &&
          preflight.sensitiveToken === undefined &&
          !downloadApproved;

        // An approved repeat of a `browser_tabs new` download owns the tab that step opened: sending the tool again
        // Would open a second tab and download the file twice, and the kept file would go unreported. The repeat
        // Navigates that tab instead, which is the guarded navigate the approval was for.
        const reusedTab =
          downloadApproved && stepOpensTab
            ? takeStepTab({ argumentHash: stepHash, session: sessionKey, toolName: stepToolName })
            : undefined;

        // The approval is for that tab: without it a fresh `browser_tabs new` would start the file again, so the
        // Call is blocked rather than run against a tab nobody approved.
        if (downloadApproved && stepOpensTab && reusedTab === undefined) {
          return {
            kind: 'result',
            result: { error: DOWNLOAD_STEP_TAB_GONE_ERROR, ok: false },
          };
        }

        // A guarded `browser_tabs new` opens its tab blank, inside the session's group, and navigates it under the
        // Guard: a tab opened at the destination lets the browser start the download before any guard exists, and
        // The file is then kept with no approval. This is the one path that must not reach the tool as written.
        const opensGuardedTab = guardDownloads && toolName === 'browser_tabs' && stepOpensTab;
        // The permission is read before any tab exists: a refusal must not leave a blank tab in the session's
        // Group, where it would become the next call's target.
        if (opensGuardedTab && downloadsApi?.() === undefined) {
          return {
            kind: 'result',
            result: { error: DOWNLOAD_PERMISSION_MISSING_ERROR, ok: false },
          };
        }

        const openedForStep = opensGuardedTab
          ? await openSessionTab({ sessionHandle: sessionKey })
          : undefined;

        if (opensGuardedTab && openedForStep === undefined) {
          return {
            kind: 'result',
            result: { error: DOWNLOAD_STEP_TAB_GONE_ERROR, ok: false },
          };
        }

        // The tab, session, tool and arguments this call really drives: the caller's, or the tab its step opened.
        const runTabId = reusedTab ?? openedForStep?.tabId ?? tabId;

        // The call drives runTabId, so a take-over has to end this call: the caller's entry would abort the wrong
        // One, and a take-over of the caller's tab must leave this call running.
        drivenTabId = runTabId;

        if (runTabId !== tabId) {
          inFlight.delete(tabId);
          inFlight.set(runTabId, () => {
            taken = true;
            markTaken();
          });
        }

        // The driven tab's own lease: a panel call on it asks for a take-over instead of interleaving with this call.
        // Lock order is fixed — the caller tab's chain first (already held), then the driven tab's lease — and a
        // Driven tab is one this session opened, never another live call's caller, so the order cannot invert.
        const drivenLease =
          runTabId === tabId
            ? undefined
            : await leases.acquire(runTabId, caller, {
                ...(takeOver === undefined ? {} : { takeOver }),
                ...(title === undefined ? {} : { title }),
              });

        if (drivenLease?.kind === 'needs_take_over') {
          return { holder: drivenLease.holder, kind: 'needs_take_over' };
        }

        if (drivenLease?.kind === 'busy') {
          return { kind: 'result', result: { error: TAB_BUSY_ERROR, ok: false } };
        }

        const runSession =
          runTabId === tabId
            ? session
            : sessionFor(runTabId).bindCaller(browserCallerKey(caller), {
                cancelled: () => taken,
              });
        const runIsTranslation = reusedTab !== undefined || openedForStep !== undefined;
        const runToolName = runIsTranslation ? 'browser_navigate' : toolName;
        const runArguments = runIsTranslation ? { url: stepUrl ?? '' } : toolArguments;

        if (downloadCapable) {
          takeOverDownloads(tabId);
        }

        // A file is about to start in the tab the step opened: that tab's earlier linger has to end too.
        if (runTabId !== tabId) {
          takeOverDownloads(runTabId);
          takeStartedDownloads(runSession);
          await ensureFrameAutoAttach(runSession, runTabId);
        }

        // Read the optional permission at call time: it can be granted or revoked while this worker lives.
        const guardApi = downloadsApi?.();
        const guardTab = guardDownloads ? await guardTabOf(tabsApi, runTabId) : undefined;
        // The tabs this call owns: its own plus any it opens (`browser_tabs new`, a link with a target).
        // The session's other tabs belong to the user or to another call, so a download there is not this call's.
        const callTabs = new Set<number>([runTabId]);
        const noteOwnedTab = (openedTabId: number, openerTabId: number | undefined): void => {
          if (openerTabId === runTabId) {
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

        const guardTabIds = (): readonly number[] => [...callTabs];

        // A navigate names the document it asked for, so a download that starts after the call returns can still be found.
        const destination =
          preflight?.class === 'navigate' || runIsTranslation ? stepUrl : undefined;
        // The requests this call can be charged with: everything the tab starts from here on.
        // A download needs one, so a call that starts none never waits for a file.
        const requestsBefore = new Set(
          guardDownloads ? runSession.networkRequests().map(request => request.requestId) : []
        );
        // The step this call is: what a download it starts is reported against, and what the token then binds.
        const downloadStep: DownloadStep | undefined =
          guardDownloads && preflight?.ok
            ? {
                argumentHash: stepHash,
                ...downloadStepText(stepToolName, stepArgumentsRecord),
                origin: preflight.origin,
                session: sessionKey,
                // The tab the step runs on, which for `browser_tabs new` is the tab it opened: the repeat lands there.
                tabId: runTabId,
                toolName: stepToolName,
              }
            : undefined;
        const downloadGuard =
          guardTab === undefined || guardApi === undefined
            ? undefined
            : armGuard(guardApi, {
                ...(destination === undefined
                  ? {}
                  : {
                      navigation: {
                        destination,
                        landed: navigationLanded(runTabId, destination),
                      },
                    }),
                ...(downloadStep === undefined ? {} : { step: downloadStep }),
                tab: guardTab,
                tabIds: guardTabIds,
                witness: {
                  attachmentResponse: () =>
                    runSession
                      .networkRequests()
                      .some(
                        request => !requestsBefore.has(request.requestId) && isAttachment(request)
                      ),
                  pendingNavigation: () =>
                    runSession
                      .networkRequests()
                      .filter(
                        request =>
                          !requestsBefore.has(request.requestId) &&
                          request.resourceType === 'Document' &&
                          request.status === undefined &&
                          request.finishedAt === undefined &&
                          request.failure === undefined
                      ).length,
                  takeAnnounced: () => runSession.takeDownloads(),
                  watchAnnounced: listener => runSession.watchDownloads(listener),
                },
              });

        // No guard without the optional permission: no file may be started, so the call is refused instead of run unguarded.
        if (guardDownloads && downloadGuard === undefined) {
          return {
            kind: 'result',
            result: { error: DOWNLOAD_PERMISSION_MISSING_ERROR, ok: false },
          };
        }

        if (downloadGuard !== undefined) {
          // The guard reports the tabs this call opened, so its listener lives exactly as long as the guard does.
          tabsApi.onCreated?.addListener(noteBrowserOpenedTab);
          await setDownloadBehavior(runSession, 'deny');
        }

        const callStartedAt = Date.now();

        // A file an approved call starts belongs to that approval: no later search may stop it, however closely it
        // Matches an older record for the same url.
        if (downloadApproved) {
          noteApprovedWindow(sessionKey, callStartedAt);
        }

        let result: EvalTabResult | null = null;
        let settlement: GuardSettlement = { kept: [], stopped: 0 };

        try {
          const call = runKiloBrowserTool({
            arguments: runArguments,
            options: {
              tabId: runTabId,
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
            session: runSession,
            toolName: runToolName,
          });

          result = await Promise.race([call, takenAway.then(() => null)]);
        } finally {
          // Every exit — a result, a take-over, a throw — disarms the guard, so no listener or interception outlives the call.
          if (guardDownloads) {
            await setDownloadBehavior(runSession, 'default');
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

        // A download an earlier call's guard stopped while this one ran had no result to be reported on; this call
        // Reports it, so a deleted file is never silent. A panel call has no model to tell, so it leaves them.
        const late = agentContext === undefined ? [] : drainDownloadReports(sessionKey);
        const stoppedFiles = settlement.stopped;
        // A file the guard could not delete is named, whichever call stopped it.
        const keptFiles = [
          ...settlement.kept,
          ...late.filter(file => file.kept).map(file => file.filename),
        ];

        if (agentContext !== undefined && stoppedFiles + settlement.kept.length === 0) {
          // Nothing of this call's own was stopped: the report is about an earlier call's download, so its token
          // Binds that call's step and the text names it.
          const owed = lateDownloadRefusal(late);

          if (owed !== undefined) {
            return owed;
          }
        } else if (agentContext !== undefined && stoppedFiles + settlement.kept.length > 0) {
          const origin = preflight?.ok ? preflight.origin : '';
          const reason = SENSITIVE_REASON.download;
          const stepToken = preflight?.ok
            ? issueSensitiveToken({ origin, reason }, runTabId)
            : undefined;

          // The tab this step opened, for the one repeat its token buys: sending `browser_tabs new` again would open
          // A second tab and download the file twice instead of receiving the one the human approved. The step ran
          // On the tab it opened, whether the transport opened it or this runtime did.
          if (downloadStep !== undefined) {
            rememberStepTab(downloadStep, runTabId);
          }

          // The click already ran and the download was cancelled. `afterAction` tells the CLI not to replay it.
          return needsPermissionOutcome([{ class: 'sensitive', origin, reason }], {
            afterAction: true,
            keptFiles,
            ...(downloadStep === undefined
              ? {}
              : {
                  step: {
                    argumentsHash: downloadStep.argumentHash,
                    tool: downloadStep.toolName,
                  },
                }),
            ...(stepToken === undefined ? {} : { stepToken }),
          });
        }

        // A guarded `browser_tabs new` answers with what the tool itself would: the tab it opened, at its new url.
        if (openedForStep !== undefined) {
          if (!settled.ok) {
            return { kind: 'result', result: settled };
          }

          const info = await tabInfo(runTabId);
          const opened = {
            selected: true,
            tabId: runTabId,
            title: info?.title ?? openedForStep.title,
            // Chrome withholds the url of an `about:blank` tab without the `tabs` permission, so an empty one falls back.
            url: info?.url === undefined || info.url === '' ? openedForStep.url : info.url,
          };

          // The navigation ran on a tab this call opened, so the agent's withheld frames are read from it: a plain
          // Return here would tell the model nothing about the frames it could not read.
          return agentContext === undefined
            ? { kind: 'result', result: { ok: true, value: opened } }
            : {
                kind: 'result',
                result: { ok: true, value: opened },
                withheldFrames: await withheldOriginsFor(
                  createAgentFrameReader(runSession),
                  agentContext.authorized
                ),
              };
        }

        // An approved navigate to an attachment keeps its file and still answers `ERR_ABORTED`: that is a success with no page change, not a failure.
        const keptText =
          downloadApproved &&
          (preflight?.class === 'navigate' || runIsTranslation) &&
          destination !== undefined &&
          !settled.ok &&
          settled.error.includes('ERR_ABORTED')
            ? await keptDownloadText(guardApi, destination, callStartedAt)
            : undefined;

        // A download is not a document, so a navigate that became one never moved the tab.
        // An opaque or older origin there is the file's answer, not the redirect this check looks for.
        if (preflight !== undefined && preflight.class === 'navigate' && keptText === undefined) {
          const changed = await postAgentNavigate(runSession, preflight.origin);

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
          preflight?.class === 'read' ? readFrames : createAgentFrameReader(runSession);

        return {
          kind: 'result',
          result: finalResult,
          withheldFrames: await withheldOriginsFor(withheldReader, agentContext.authorized),
        };
      } finally {
        inFlight.delete(tabId);
        inFlight.delete(drivenTabId);

        if (drivenTabId !== tabId) {
          leases.release(drivenTabId, caller);
        }
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
      // Workflow page code can start a download too, so it owns the tab's downloads from here. The records stay:
      // Only the session that owns them may report one, and this call is not that session.
      takeOverDownloads(tabId);

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

    if (caller.kind === 'agent') {
      // The session is over: its downloads are settled with no report, because there is no model left to tell,
      // And a later session must never be asked to redeem a token bound to this one.
      closeSessionRecords(caller.sessionHandle);

      for (const [tabId, watch] of openWatches) {
        if (watch.session === caller.sessionHandle) {
          openWatches.delete(tabId);
        }
      }
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
      // A closed session owes no approval: whatever it left stopped is settled here, not handed to the next one.
      closeSessionRecords(input.sessionHandle);
      await groups.closeSession(input);
    },
    disposeCaller,
    disposeTab,
    evalInTab,
    listSessions: () => groups.listSessions(),
    noteTabCreated,
    openSession: input => {
      // A handle that opens again is live again: a record may be opened for it, and a stop is reportable once more.
      closedSessions.delete(input.sessionHandle);

      return groups.openSession(input);
    },
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
