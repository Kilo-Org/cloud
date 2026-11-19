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
  /** Downloads the tab announced since the last read, drained so each is counted once. */
  readonly announced: () => number;
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
 * linger per tab and the next call on that tab ends it first, so an already
 * answered guard never cancels a download a later call — an approved repeat
 * above all — started.
 */
interface LingerSink {
  /** A linger is now armed for this tab; `end` stops it acting on any download that starts later. */
  readonly armed: (end: () => void) => void;
  /** The linger ended, by its own window or by the runtime: the tab no longer holds one. */
  readonly ended: () => void;
  /**
   * A download the linger stopped after its own call had answered. Nothing else
   * will report it, so the runtime hands it to the next call on the tab, together
   * with the step that started it, instead of letting the file vanish unreported.
   */
  readonly late: (stop: {
    readonly filename: string;
    readonly outcome: Promise<DiscardOutcome> | undefined;
  }) => void;
}

/**
 * One download an answered call's linger stopped, kept until a call can tell
 * the model about it. It is queued when the browser announces the download, so
 * the file name is known before the item exists; the report never waits on the
 * stop itself.
 */
interface LateStop {
  readonly filename: string;
  /** Resolves when the guard finished stopping it: nothing the report waits on. */
  readonly outcome: Promise<DiscardOutcome> | undefined;
  /** The step that started the file; absent only for a guard without one (a panel or a workflow call). */
  readonly step: DownloadStep | undefined;
}

/** One stopped download as a later call reports it: the file it was, whether it survived, and the step that started it. */
interface LateDiscard {
  readonly filename: string;
  /** The browser would not delete the file, so the human keeps it where it landed. */
  readonly kept: boolean;
  readonly step: DownloadStep | undefined;
}

/**
 * What a late report says: the step that started the file, what became of it,
 * and the step to repeat — never the call that happened to carry the news.
 */
const lateDownloadError = (files: readonly LateDiscard[]): string => {
  const names = [...new Set(files.map(file => file.filename))].join(', ');
  const step = files.findLast(file => file.step !== undefined)?.step;
  const head = step === undefined ? 'A browser action' : `The ${step.description}`;
  const repeat =
    step === undefined
      ? 'Repeat that step to receive the file.'
      : `Repeat that ${step.noun} to receive the file.`;
  const saved = files.some(file => file.kept)
    ? ` The browser had already saved ${names} before the download could be stopped.`
    : '';

  return `${head} started a download of ${names}, which was stopped. Approved. ${repeat}${saved}`;
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
  linger?: LingerSink
): DownloadGuard => {
  const { navigation, tab, tabIds } = attribution;
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
  /** Downloads the tab announced that no item has been stopped for yet: the report names them now, the stop follows. */
  const announcedPending = new Map<string, (outcome: DiscardOutcome) => void>();
  /** The urls this guard already stopped, so an announcement cannot queue a second report for one file. */
  const stoppedUrls = new Set<string>();
  /** The pending announcement subscription: only a linger keeps one, and it ends with the linger. */
  let stopWatching: (() => void) | undefined = undefined;
  let created = false;
  let listening = true;
  let lingering = false;
  /** Downloads this call reported as announced but unnamed: the linger stops them later, already reported. */
  let announcedUnreported = 0;

  const stop = (item: BrowserDownloadItem): void => {
    created = true;

    if (!stops.has(item.id)) {
      const discarded = discardDownload(api, item);

      stops.set(item.id, discarded);

      const url = item.url === undefined || item.url === '' ? undefined : item.url;

      if (url !== undefined) {
        stoppedUrls.add(url);
      }

      // The announcement already reported this file: this stop only settles the promise behind it.
      const settle = url === undefined ? undefined : announcedPending.get(url);

      if (settle !== undefined && url !== undefined) {
        announcedPending.delete(url);
        void (async (): Promise<void> => {
          settle(await discarded);
        })();
      } else if (lingering) {
        // The linger outlives this call's result, so its stops are handed over to whoever reports next.
        if (announcedUnreported > 0) {
          // This call already told the model about this download; the linger only finishes stopping it.
          announcedUnreported -= 1;
        } else {
          linger?.late({ filename: fileNameOf(item), outcome: discarded });
        }
      }
    }
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
      }

      // An act call's download is created a moment after its own command returns, so the guard waits for it.
      // The wait follows the navigation it started while that navigation is unanswered, then looks for the item.
      // Without this the linger would delete a file the model was never told about.
      let announced = 0;
      let signalled = false;

      if (navigation === undefined && attribution.witness !== undefined) {
        const waited = await awaitStartedDownload({
          announced: attribution.witness.announced,
          attachmentResponse: attribution.witness.attachmentResponse,
          pendingNavigation: attribution.witness.pendingNavigation,
          stopped: () => stops.size > 0,
        });

        ({ announced, signalled } = waited);
      }

      // One search always: the browser can create an item without announcing it, and the model must be told about
      // A file this call started. Only a call that saw a sign of a download waits for it — an ordinary click pays
      // One round trip, and a file that lands later is the linger's, reported on the next call.
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
        // Nothing started, so the call does not pay for a window it may never need.
        // The listener stays armed for a bounded linger, so a download whose headers arrive late is deleted too.
        // The linger owns only this call's window: downloads that start before the next download-capable call ends it.
        // That is why an approved repeat's file is never cancelled by the guard that asked for it.
        const end = (): void => {
          if (!lingering) {
            return;
          }

          lingering = false;
          disarm();
          stopWatching?.();
          stopWatching = undefined;

          // An announced download the guard never saw as an item wrote no file: its report already went out.
          for (const [url, settle] of announcedPending) {
            settle({ filename: url.split('/').pop() ?? 'the downloaded file', kind: 'removed' });
          }

          announcedPending.clear();
          linger?.ended();
          // Whatever the linger already stopped is still deleted, now that nothing else will report it.
          void report();
        };

        lingering = true;
        listen();
        // The browser names a download before the item exists: queue the report now, so the very next call — whichever
        // Tool it is — can answer without waiting for the item to appear.
        stopWatching = attribution.witness?.watchAnnounced?.(download => {
          if (!lingering || download.url === undefined || download.url === '') {
            return;
          }

          if (announcedPending.has(download.url) || stoppedUrls.has(download.url)) {
            return;
          }

          const { promise, resolve } = Promise.withResolvers<DiscardOutcome>();
          const filename =
            download.suggestedFilename ?? download.url.split('/').pop() ?? 'the downloaded file';

          announcedPending.set(download.url, resolve);
          linger?.late({ filename, outcome: promise });
        });
        linger?.armed(end);
        void (async (): Promise<void> => {
          await after(DOWNLOAD_GUARD_LINGER_MS);
          end();
        })();
      };

      if (stops.size === 0 && announced === 0) {
        lingerOn();

        return { kept: [], stopped: 0 };
      }

      const settlement = await report();

      if (settlement.stopped === 0) {
        // The tab announced a download the browser has not named yet: this call reports it now.
        // The linger still deletes whatever lands, so no file is kept unapproved and none vanishes unreported.
        // Each of those, when the linger stops it, has already been reported: it must not be reported twice.
        announcedUnreported += announced;
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
  // Can act on what that call starts. A read leaves it on duty instead of dropping it.
  const lingers = new Map<number, () => void>();
  // Downloads a linger stopped after its own call answered, which no call has reported yet: the next call on the
  // Tab reports them, because a file that was deleted is never silent. Each carries the step that started it, so
  // The approval it asks for binds that step and not whichever call happened to carry the news.
  const lateStops = new Map<number, LateStop[]>();

  /** Ends whatever linger an earlier call left on this tab: a new download-capable call owns the downloads from now on. */
  const endLinger = (tabId: number): void => {
    const end = lingers.get(tabId);

    lingers.delete(tabId);
    end?.();
  };

  /**
   * Reports the downloads an earlier call's linger stopped — or announced and
   * still being stopped — and had nobody to tell. It never waits: the browser
   * names a download before the item exists, and a call that arrives in between
   * still has to answer.
   */
  const takeLateStops = (tabId: number): readonly LateDiscard[] => {
    const queued = lateStops.get(tabId);

    if (queued === undefined) {
      return [];
    }

    lateStops.delete(tabId);

    return queued.map(entry => ({
      filename: entry.filename,
      kept: false,
      step: entry.step,
    }));
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
    inFlight.delete(tabId);
    // A closed tab has no next call, so its linger is over: it must not keep listening for that tab's id.
    endLinger(tabId);
    lateStops.delete(tabId);
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
  const armGuard = (api: BrowserDownloadsApi, attribution: DownloadAttribution): DownloadGuard =>
    armDownloadGuard(api, attribution, {
      armed: end => {
        // One linger per tab: the previous one was ended when this call began.
        lingers.set(attribution.tab.tabId, end);
      },
      ended: () => {
        lingers.delete(attribution.tab.tabId);
      },
      late: stop => {
        // The linger outlived its call, so this stop has no result to be reported on: the next call on the tab has.
        // The step travels with it, so the approval it asks for binds the call that started the file.
        const { tabId } = attribution.tab;
        const queued = lateStops.get(tabId) ?? [];

        queued.push({ filename: stop.filename, outcome: stop.outcome, step: attribution.step });
        lateStops.set(tabId, queued);
      },
    });

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
      readonly stepToken?: string;
    } = {}
  ): BrowserToolRunOutcome => {
    const { afterAction, error, keptFiles = [], stepToken } = answer;

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
    files: readonly LateDiscard[]
  ): BrowserToolRunOutcome | undefined => {
    if (files.length === 0) {
      return undefined;
    }

    const step = files.findLast(file => file.step !== undefined)?.step;
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
      // A download an earlier call's linger stopped has no result of its own to be reported on: this call reports
      // It before it runs, whatever tool it is, and its token binds the step that started the file. A panel call has
      // No model to tell, so it drops what is left instead of holding it for the next agent call.
      if (caller.kind === 'agent') {
        const owed = lateDownloadRefusal(takeLateStops(tabId));

        if (owed !== undefined) {
          return owed;
        }
      } else {
        // A call the user drives through the panel owns the tab's downloads from the moment it starts, so an
        // Earlier agent call's linger must not cancel a file this one starts.
        endLinger(tabId);
        lateStops.delete(tabId);
      }

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
            preflight.sensitive === undefined
              ? {}
              : { stepToken: issueSensitiveToken(preflight.sensitive) }
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

        // A call that can start a download owns the tab's downloads: an earlier call's linger ends before it runs,
        // So the linger never cancels a file this call starts — an approved repeat above all.
        const downloadCapable =
          agentContext !== undefined &&
          preflight !== undefined &&
          (preflight.class === 'act' || preflight.class === 'navigate') &&
          canStartDownload(toolName, argsRecord);

        if (downloadCapable) {
          endLinger(tabId);
        }

        // An unapproved act call runs with downloads denied: a download it starts is cancelled, then reported as a sensitive step.
        const guardDownloads =
          downloadCapable &&
          preflight !== undefined &&
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

        const guardTabIds = (): readonly number[] => [...callTabs];

        // A navigate names the document it asked for, so a download that starts after the call returns can still be found.
        const destination =
          preflight?.class === 'navigate' ? argumentText(argsRecord['url']) : undefined;
        // The requests this call can be charged with: everything the tab starts from here on.
        // A download needs one, so a call that starts none never waits for a file.
        const requestsBefore = new Set(
          guardDownloads ? session.networkRequests().map(request => request.requestId) : []
        );
        // The step this call is: what a download it starts is reported against, and what the token then binds.
        const downloadStep: DownloadStep | undefined =
          guardDownloads && preflight?.ok
            ? {
                argumentHash: hashBrowserToolArguments(argsRecord),
                ...downloadStepText(toolName, argsRecord),
                origin: preflight.origin,
                session: sessionKey,
                tabId,
                toolName,
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
                        landed: navigationLanded(tabId, destination),
                      },
                    }),
                ...(downloadStep === undefined ? {} : { step: downloadStep }),
                tab: guardTab,
                tabIds: guardTabIds,
                witness: {
                  announced: () => session.takeDownloads().length,
                  attachmentResponse: () =>
                    session
                      .networkRequests()
                      .some(
                        request => !requestsBefore.has(request.requestId) && isAttachment(request)
                      ),
                  pendingNavigation: () =>
                    session
                      .networkRequests()
                      .filter(
                        request =>
                          !requestsBefore.has(request.requestId) &&
                          request.resourceType === 'Document' &&
                          request.status === undefined &&
                          request.finishedAt === undefined &&
                          request.failure === undefined
                      ).length,
                  watchAnnounced: listener => session.watchDownloads(listener),
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

        // A download an earlier call's linger stopped while this one ran had no result to be reported on; this
        // Call reports it, so a deleted file is never silent. The tab's own target may also have reported one
        // (`Page.downloadWillBegin`), where that is allowed. A panel call has no model to tell, so it leaves them.
        const late = agentContext === undefined ? [] : takeLateStops(tabId);
        const stoppedFiles =
          settlement.stopped + (guardDownloads ? takeStartedDownloads(session) : 0);
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
          const stepToken = preflight?.ok ? issueSensitiveToken({ origin, reason }) : undefined;

          // The click already ran and the download was cancelled. `afterAction` tells the CLI not to replay it.
          return needsPermissionOutcome([{ class: 'sensitive', origin, reason }], {
            afterAction: true,
            keptFiles,
            ...(stepToken === undefined ? {} : { stepToken }),
          });
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
      // Workflow page code can start a download too, so it owns the tab's downloads from here.
      endLinger(tabId);

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
