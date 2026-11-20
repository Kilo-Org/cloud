/* eslint-disable capitalized-comments, max-lines -- the hold is one decision point: its prose continues across
   lines by design, and splitting the state machine across files would scatter cancel-before-suggest. */
/**
 * The hold that decides every download in the profile before its file exists.
 *
 * `chrome.downloads.onDeterminingFilename` hands the extension the item and a
 * `suggest` callback, and Chrome does not complete the item until the callback
 * runs — 15 s at most, after which Chrome continues as if nobody had answered.
 * The hold answers well inside that window, so a refused download is cancelled
 * before its file is renamed into place. Chrome streams the body into a
 * temporary file during the hold and the cancel deletes it; what the hold
 * guarantees is that no finished file appears without approval, never that
 * nothing was written.
 *
 * The listener is this extension's only one for the event, so it also sees the
 * user's downloads and other extensions' downloads. Those are answered at once
 * and left untouched; only a download attributed to an agent tab is decided.
 *
 * Classification, strongest signal first:
 * - `byExtensionId` set: another extension's download, or this extension's own
 *   `chrome.downloads.download` call. Never an agent click: pass.
 * - No agent tab registered: nothing the agent could have started. Pass.
 * - A CDP announcement (`Browser.downloadWillBegin`) already names the file on
 *   an agent tab: owned by that tab, whichever way the referrer points.
 * - A referrer naming an agent tab's page, or an agent tab's origin (a
 *   cross-origin attachment's referrer is origin-only): owned, fail closed.
 * - An empty referrer, which any page that sets `no-referrer` produces: wait
 *   {@link ATTRIBUTION_WAIT_MS} for an announcement, then pass if none came.
 * - A referrer naming no agent tab: another page's download. Pass.
 */

/** The step a download belongs to: the exact binding a step token is issued against. */
export interface DownloadStep {
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

/** The browser announced a download on an agent tab, before its item existed. */
export interface DownloadHoldAnnouncement {
  /** Chrome's own identity for the download, when the announcement carries one. */
  readonly guid?: string;
  readonly suggestedFilename?: string;
  /** When the browser named it, in `Date.now()` milliseconds. */
  readonly startedAt?: number;
  readonly tabId: number;
  readonly url?: string;
}

/** One download as `onDeterminingFilename` reports it: what the decision reads. */
export interface DownloadHoldItem {
  /** Set when another extension started it, or when this extension used `chrome.downloads.download`. */
  readonly byExtensionId?: string;
  readonly filename?: string;
  readonly finalUrl?: string;
  readonly id: number;
  /** The page that started it. Empty under `no-referrer`, origin-only across origins. */
  readonly referrer?: string;
  /** `complete` and `interrupted` are terminal; a cancelled item the browser still describes says which. */
  readonly state?: string;
  readonly url?: string;
}

/** One download a session still owes the model an answer for. */
export interface DownloadHoldReport {
  readonly filename: string;
  /** The browser may have saved it: a refusal must never read as "nothing was written". */
  readonly kept: boolean;
  /** When the hold decided it, so a call can tell its own refusal from an earlier call's. */
  readonly since: number;
  readonly step: DownloadStep | undefined;
  readonly tabId: number;
  /** The url the browser named it by, so the approval the report asks for names the same file. */
  readonly url: string | undefined;
}

/**
 * What an approval buys. The approval covers one file alone, so a second
 * download during the approved call is decided like any other.
 *
 * An `http(s)` file is identified by its page — origin and pathname — because a
 * page that regenerates a signed link or a counter still downloads the file the
 * human approved. Every other scheme (`blob:`, `data:`) gets a fresh url per
 * click, so it is identified by its scheme and file name.
 */
export type DownloadTarget =
  | {
      readonly kind: 'scheme';
      readonly name?: string | undefined;
      readonly scheme: string;
    }
  | { readonly kind: 'url'; readonly page?: string | undefined; readonly url: string };

/**
 * A session's approval. `armed` while its token lives — a human may take a
 * minute to answer — and `spent` once the one file it bought has landed, which
 * is what refuses a second file from the same gesture.
 */
export type ApprovalNeed =
  | {
      readonly expiresAt: number;
      readonly kind: 'armed';
      readonly session: string;
      readonly step: DownloadStep | undefined;
      readonly tabId: number;
      readonly target: DownloadTarget;
    }
  | {
      readonly filename: string;
      readonly itemId: number;
      readonly kind: 'spent';
      readonly session: string;
      readonly step: DownloadStep | undefined;
      readonly tabId: number;
      readonly target: DownloadTarget;
    };

/** Why the hold cannot prove a file is gone: the report then says it may have been saved. */
export type EscapedReason = 'cancel-failed' | 'complete' | 'unobserved';

/**
 * One download the hold is deciding. Every state carries the need its token
 * carries, so the need lives exactly as long as the token does and nothing
 * outlives it into a later session.
 */
export type TrackedDownload =
  /** Attributed to an agent tab; the decision is in flight and Chrome is holding the item. */
  | {
      readonly filename: string;
      readonly itemId: number;
      readonly kind: 'held';
      readonly need: ApprovalNeed;
      readonly since: number;
      readonly tabId: number;
      readonly url: string | undefined;
    }
  /** Approved: the need is spent and `suggest` let the file land. */
  | {
      readonly filename: string;
      readonly itemId: number;
      readonly kind: 'allowed';
      readonly need: ApprovalNeed;
      readonly since: number;
      readonly tabId: number;
      readonly url: string | undefined;
    }
  /** Refused before `suggest`: the cancel resolved and no file can be renamed into place. */
  | {
      readonly filename: string;
      readonly itemId: number;
      readonly kind: 'blocked';
      readonly need: ApprovalNeed;
      readonly since: number;
      readonly tabId: number;
      readonly url: string | undefined;
    }
  /**
   * Not provably stopped: the cancel threw, the item had already completed, the
   * browser could not describe it, or an announcement no item ever claimed.
   * Reported as "may have been saved".
   */
  | {
      readonly filename: string;
      readonly itemId: number | undefined;
      readonly kind: 'escaped';
      readonly need: ApprovalNeed;
      readonly reason: EscapedReason;
      readonly since: number;
      readonly tabId: number;
      readonly url: string | undefined;
    };

/** What the listener answers Chrome: `suggest` exactly once, and whether the answer is deferred. */
export type SuggestFilename = (override?: { readonly filename?: string }) => void;

/** One agent tab the hold may attribute a download to. */
export interface DownloadHoldTab {
  /** The page it is on, for the referrer comparison. */
  readonly page: string;
  readonly session: string;
  /** The download-capable step that last ran on it: what a refusal names and its token binds. */
  readonly step: DownloadStep | undefined;
  readonly tabId: number;
}

/** How long one call waits for its own download's decision after the tool answered. */
export interface SettleWindow {
  /** The call's own start: a decision older than this belongs to a call already answered. */
  readonly since: number;
  /** How long to wait for an item when nothing suggests a download started: a click's item is created a moment later. */
  readonly graceMs: number;
  /**
   * Whether something the call saw says a download started: the tab's own announcement, or a page load the
   * browser answered as a file. Only a signed call waits the whole {@link timeoutMs} for its item.
   */
  readonly sign: () => boolean;
  readonly timeoutMs: number;
}

/**
 * How a call's settle ended, as one state rather than a pair of flags:
 * - `no_sign`: nothing suggested a download, so the call answered after the short grace.
 * - `waiting_for_item`: a download started and no item was decided inside the bound; the file may exist.
 * - `decided`: the hold decided the item, and its report is what the call answers with.
 */
export type DownloadSettle = 'decided' | 'no_sign' | 'waiting_for_item';

export interface DownloadHold {
  /** The browser announced a download on an agent tab, before its item existed. */
  readonly announce: (download: DownloadHoldAnnouncement) => void;
  /**
   * Reports an announcement the browser will never complete into an item — no
   * `downloads` permission, so the event this hold answers does not exist — as
   * possibly saved, at once instead of after the tripwire's wait.
   */
  readonly escape: (download: DownloadHoldAnnouncement, session: string) => void;
  /** Arms the need a redeemed step token carries, replacing the session's earlier one. */
  readonly arm: (need: ApprovalNeed) => void;
  readonly closeSession: (session: string) => void;
  /** The reports this session owes, drained: a refused file is named once, on the session's next call. */
  readonly drain: (session: string) => readonly DownloadHoldReport[];
  /** The permanent `onDeterminingFilename` listener, as Chrome calls it. */
  readonly handle: (item: DownloadHoldItem, suggest: SuggestFilename) => boolean;
  /** The session's live approval: `armed` until a download spends it, `spent` for good. */
  readonly needOf: (session: string) => ApprovalNeed | undefined;
  /**
   * Waits, at most the window's bounds, for the downloads this call started to be
   * decided: the call then reads its own answer instead of racing it. A call with
   * no sign answers after the short grace; a signed one waits for its item.
   */
  readonly settle: (session: string, window: SettleWindow) => Promise<DownloadSettle>;
  /** Registers an agent tab, or refreshes its page and step; `undefined` forgets it. */
  readonly tab: (input: DownloadHoldTab | { readonly detach: number }) => void;
  /**
   * Records the navigation a call is about to send on its tab, before it is sent:
   * an item that arrives with no referrer and no announcement is that call's
   * file only while its expectation is live. Every other empty-referrer item
   * stays foreign, so a user's own download is never claimed.
   */
  readonly navigate: (navigation: DownloadHoldNavigation) => void;
  /** One item's decision, for a test or a diagnostic that holds nothing else. */
  readonly tracked: (itemId: number) => TrackedDownload | undefined;
}

/** How long an unattributable download is held for a CDP announcement. Well under Chrome's 15 s release. */
export const ATTRIBUTION_WAIT_MS = 250;

/** How long an announcement waits for the item that claims it before it is reported as possibly saved. */
export const TRIPWIRE_MS = 1500;

/** How long an announcement stays claimable by a late item. */
const ANNOUNCEMENT_TTL_MS = 5000;

const HOLD_POLL_MS = 10;

/** The page identity two urls are compared by: `origin` plus `pathname`. */
const pageOf = (url: string | undefined): string | undefined => {
  try {
    const parsed = new URL(url ?? '');

    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return undefined;
  }
};

/** The file name a url asks for: its path's last non-empty segment, decoded. */
const requestedName = (url: string | undefined): string | undefined => {
  try {
    const last = new URL(url ?? '').pathname.split('/').findLast(Boolean);

    return last === undefined || last === '' ? undefined : decodeURIComponent(last);
  } catch {
    return undefined;
  }
};

const schemeOf = (url: string | undefined): string | undefined => {
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(url ?? '')?.[1];

  return scheme === undefined ? undefined : scheme.toLowerCase();
};

/** The target a refused step's download had: what its approval buys. */
export const targetOf = (url: string): DownloadTarget => {
  const scheme = schemeOf(url);

  return scheme === 'http' || scheme === 'https'
    ? { kind: 'url', page: pageOf(url), url }
    : { kind: 'scheme', name: requestedName(url), scheme: scheme ?? '' };
};

/** The name a download would have on disk, from the announcement or from the url it came from. */
const nameOfItem = (
  item: DownloadHoldItem,
  announcement: DownloadHoldAnnouncement | undefined
): string => {
  const fromItem =
    item.filename === undefined || item.filename === ''
      ? undefined
      : item.filename.split('/').findLast(segment => segment !== '');
  const candidate =
    announcement?.suggestedFilename ??
    fromItem ??
    requestedName(item.url) ??
    requestedName(item.finalUrl);

  return candidate === undefined || candidate === '' ? 'the downloaded file' : candidate;
};

/** Whether this download is the file a target names. */
const targetMatches = (
  target: DownloadTarget,
  item: DownloadHoldItem,
  announcement: DownloadHoldAnnouncement | undefined
): boolean => {
  if (target.kind === 'url') {
    const url = item.url === undefined || item.url === '' ? undefined : item.url;

    return url !== undefined && (url === target.url || pageOf(url) === target.page);
  }

  if (schemeOf(item.url) !== target.scheme) {
    return false;
  }

  return target.name === undefined || nameOfItem(item, announcement) === target.name;
};

/** What one read of an item's state said: `unknown` is a browser that could not answer, never "no file". */
type ItemLookup =
  | { readonly item: DownloadHoldItem; readonly kind: 'found' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unknown' };

/** What a download's own fields alone say. `wait` is one nothing has attributed yet. */
type Attribution =
  | { readonly kind: 'foreign' }
  | { readonly kind: 'owned'; readonly tabId: number }
  | { readonly kind: 'wait' };

/** One announcement waiting for the item that claims it: `claimed` flips once an item takes it. */
type OpenAnnouncement = DownloadHoldAnnouncement & { claimed: boolean };

/**
 * A navigation the runtime itself sent on an agent tab, registered before it is
 * sent: the one tie an item needs when the browser reports no referrer and
 * announces nothing. A browser-initiated navigation of a top-level document —
 * `browser_navigate`, `browser_navigate_back`, a `browser_tabs new` — issues no
 * `Referer` and, on real Chrome, no `Page.downloadWillBegin` either, so an
 * attachment it loads is otherwise indistinguishable from a user's own file.
 */
export interface DownloadHoldNavigation {
  /** The call that sent it: what a report inside its window belongs to. */
  readonly attempt: string;
  readonly session: string;
  readonly tabId: number;
  /** The url the runtime asked for, before any redirect: compared by page identity. */
  readonly url: string;
  /** When the expectation ends: the call's own settle window plus the attribution bound. */
  readonly until: number;
}

const waitFor = (milliseconds: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();

  setTimeout(resolve, milliseconds);

  return promise;
};

export const createDownloadHold = ({
  cancel,
  erase,
  now = Date.now,
  onReport,
  search,
}: {
  readonly cancel: (itemId: number) => Promise<void>;
  readonly erase?: ((itemId: number) => Promise<void> | undefined) | undefined;
  readonly now?: () => number;
  /** Called once per report as it is queued, so a worker that sleeps before the next call does not lose it. */
  readonly onReport?: ((report: DownloadHoldReport, session: string) => void) | undefined;
  readonly search?: ((itemId: number) => Promise<readonly DownloadHoldItem[]>) | undefined;
}): DownloadHold => {
  const needs = new Map<string, ApprovalNeed>();
  const tracked = new Map<number, TrackedDownload>();
  const owed = new Map<string, DownloadHoldReport[]>();
  /** Live agent tabs, by id: the page each one is on, its session, and the step that last ran there. */
  const tabs = new Map<number, DownloadHoldTab>();
  /** Announcements no item has claimed yet, per tab: what a held download is matched against. */
  const announcements = new Map<number, OpenAnnouncement[]>();
  /** The navigation each tab's live call is sending, by tab id: the tie an unreferred item needs. */
  const navigations = new Map<number, DownloadHoldNavigation>();
  /** The announcements a tripwire watches, so one announcement is reported at most once. */
  const watched = new Set<string>();

  const announcementKey = (download: DownloadHoldAnnouncement): string =>
    download.guid === undefined || download.guid === ''
      ? `${String(download.tabId)}|${download.url ?? ''}`
      : `guid:${download.guid}`;

  /** Queues one report, once: the same file is never named twice. */
  const report = (state: TrackedDownload): void => {
    const { session } = state.need;
    const existing = owed.get(session) ?? [];
    const next: DownloadHoldReport = {
      filename: state.filename,
      kept: state.kind === 'escaped',
      since: state.since,
      step: state.need.step,
      tabId: state.tabId,
      url: state.url,
    };

    if (existing.some(entry => entry.filename === next.filename && entry.tabId === next.tabId)) {
      return;
    }

    owed.set(session, [...existing, next]);
    onReport?.(next, session);
  };

  /** The session's approval, dropped once its token's own lifetime is over. */
  const needOf = (session: string): ApprovalNeed | undefined => {
    const need = needs.get(session);

    if (need === undefined) {
      return undefined;
    }

    if (need.kind === 'armed' && need.expiresAt <= now()) {
      // The token that carried it is gone, so the approval it asked for is gone too.
      needs.delete(session);

      return undefined;
    }

    return need;
  };

  /** Forgets announcements past their window: an item that lands later opens a fresh decision. */
  const pruneAnnouncements = (at: number): void => {
    for (const [tabId, list] of announcements) {
      const live = list.filter(entry => (entry.startedAt ?? 0) + ANNOUNCEMENT_TTL_MS >= at);

      if (live.length === 0) {
        announcements.delete(tabId);
      } else {
        announcements.set(tabId, live);
      }
    }
  };

  const announcementMatches = (entry: DownloadHoldAnnouncement, url: string | undefined): boolean =>
    url === undefined ||
    entry.url === undefined ||
    entry.url === url ||
    pageOf(entry.url) === pageOf(url);

  /** The announcement this item claims, marked claimed: the strongest attribution there is. */
  const claim = (item: DownloadHoldItem, tabId: number): DownloadHoldAnnouncement | undefined => {
    const list = announcements.get(tabId);
    const url = item.url === undefined || item.url === '' ? undefined : item.url;
    const found = list?.findLast(entry => !entry.claimed && announcementMatches(entry, url));

    if (found !== undefined) {
      found.claimed = true;
    }

    return found;
  };

  /**
   * The agent tab whose page the referrer names, exactly. The page is the
   * document that started the file, so another page of the same origin is
   * another tab's file — the user's own download, in the tab next to the
   * agent's — and claiming it by origin alone would refuse and report it.
   */
  const tabByReferrer = (referrer: string | undefined): number | undefined => {
    const page = pageOf(referrer);

    if (page === undefined) {
      return undefined;
    }

    for (const [tabId, tab] of tabs) {
      if (pageOf(tab.page) === page) {
        return tabId;
      }
    }

    return undefined;
  };

  /**
   * The tab whose call is navigating to this item's file: the item's url (or its
   * final url, after redirects) names the page the runtime asked for, or the
   * expectation is live on that tab and the item carries no referrer at all.
   * A url match wins over a merely live expectation: an earlier call's
   * expectation stays live for its settle window, so it would otherwise claim a
   * later call's file on another tab — and name that earlier call's step with it.
   * Only a live expectation can claim an unreferred item, so a user's typed-URL
   * download — no expectation on its tab — still passes as foreign.
   */
  const tabByNavigation = (item: DownloadHoldItem, at: number): number | undefined => {
    const named = pageOf(item.url) ?? pageOf(item.finalUrl);
    const live = [...navigations.entries()].filter(
      ([tabId, navigation]) => navigation.until >= at && tabs.has(tabId)
    );
    const matched = live.find(
      ([, navigation]) => named !== undefined && pageOf(navigation.url) === named
    );

    if (matched !== undefined) {
      return matched[0];
    }

    // An item with no url, or one redirected away from the url the call sent: the newest expectation is the tie.
    const [newest] = live.toSorted((left, right) => right[1].until - left[1].until);

    // An item that carries a referrer is attributed by it, never by an expectation.
    return pageOf(item.referrer) === undefined ? newest?.[0] : undefined;
  };

  const classify = (item: DownloadHoldItem): Attribution => {
    if (item.byExtensionId !== undefined) {
      return { kind: 'foreign' };
    }

    // No agent tab is registered: no click of the agent's can be the cause.
    if (tabs.size === 0) {
      return { kind: 'foreign' };
    }

    if (pageOf(item.referrer) === undefined) {
      // No referrer at all: a page with `no-referrer`, or one the browser withheld. The
      // announcement, which Chrome sends a millisecond before the item, is the only tie left —
      // And a navigation this runtime itself sent is the other: the browser reports neither a
      // referrer nor an announcement for it, so the call's own expectation is the only record.
      const navigating = tabByNavigation(item, now());

      if (navigating !== undefined) {
        return { kind: 'owned', tabId: navigating };
      }

      return { kind: 'wait' };
    }

    const tabId = tabByReferrer(item.referrer);

    // A referrer naming no agent tab started this: another page's file, answered at once.
    return tabId === undefined ? { kind: 'foreign' } : { kind: 'owned', tabId };
  };

  /** One read of an item's own state. */
  const lookUp = async (itemId: number): Promise<ItemLookup> => {
    if (search === undefined) {
      return { kind: 'unknown' };
    }

    try {
      const found = (await search(itemId)) ?? [];
      const item = found.find(candidate => candidate.id === itemId);

      return item === undefined ? { kind: 'missing' } : { item, kind: 'found' };
    } catch {
      return { kind: 'unknown' };
    }
  };

  /** Marks the need spent: the approval bought this one item and no other. */
  const spend = (need: ApprovalNeed, itemId: number, filename: string): ApprovalNeed => {
    const spent: ApprovalNeed = {
      filename,
      itemId,
      kind: 'spent',
      session: need.session,
      step: need.step,
      tabId: need.tabId,
      target: need.target,
    };

    needs.set(need.session, spent);

    return spent;
  };

  /** `held` → `escaped`: the hold cannot prove the file is gone, so the model is told it may exist. */
  const escape = (state: TrackedDownload, reason: EscapedReason): TrackedDownload => {
    if (state.kind !== 'held' && state.kind !== 'blocked') {
      return state;
    }

    const next: TrackedDownload = {
      filename: state.filename,
      itemId: state.itemId,
      kind: 'escaped',
      need: state.need,
      reason,
      since: state.since,
      tabId: state.tabId,
      url: state.url,
    };

    tracked.set(state.itemId, next);

    return next;
  };

  /** `held` → `allowed`: the need is spent and `suggest` lets the file land under the browser's name. */
  const allow = (state: TrackedDownload, suggest: SuggestFilename): void => {
    if (state.kind !== 'held') {
      return;
    }

    tracked.set(state.itemId, {
      filename: state.filename,
      itemId: state.itemId,
      kind: 'allowed',
      need: spend(state.need, state.itemId, state.filename),
      since: state.since,
      tabId: state.tabId,
      url: state.url,
    });
    suggest();
  };

  /**
   * `held` → `blocked`: cancel before `suggest`, confirm the state, erase the
   * history entry, then answer Chrome. A cancel that threw, an item the browser
   * had already completed, or one it cannot describe is `escaped` instead: the
   * file may exist, and the report says so.
   */
  const block = async (state: TrackedDownload, suggest: SuggestFilename): Promise<void> => {
    if (state.kind !== 'held') {
      return;
    }

    let cancelled = true;

    try {
      await cancel(state.itemId);
    } catch {
      cancelled = false;
    }

    if (!cancelled) {
      report(escape(state, 'cancel-failed'));
      suggest();

      return;
    }

    const listed = await lookUp(state.itemId);
    const blocked: TrackedDownload = {
      filename: state.filename,
      itemId: state.itemId,
      kind: 'blocked',
      need: state.need,
      since: state.since,
      tabId: state.tabId,
      url: state.url,
    };

    tracked.set(state.itemId, blocked);

    // The browser could not describe the item: the cancel landed, and its file is unproven.
    // An item it says is complete was never stopped, so the report must say it may exist.
    let settled: TrackedDownload = blocked;

    if (listed.kind === 'unknown') {
      settled = escape(blocked, 'unobserved');
    } else if (listed.kind === 'found' && listed.item.state === 'complete') {
      settled = escape(blocked, 'complete');
    }

    if (erase !== undefined) {
      try {
        await erase(state.itemId);
      } catch {
        // The history entry stays; the file is already gone.
      }
    }

    // Only after the cancel: `suggest` satisfies "exactly once", and no file can be renamed into place.
    suggest();
    report(settled);
  };

  /** The armed need a download of this tab and file spends. */
  const armedFor = (
    tab: DownloadHoldTab,
    item: DownloadHoldItem,
    announcement: DownloadHoldAnnouncement | undefined
  ): ApprovalNeed | undefined => {
    const need = needOf(tab.session);

    return need?.kind === 'armed' &&
      need.tabId === tab.tabId &&
      targetMatches(need.target, item, announcement)
      ? need
      : undefined;
  };

  /** What carries a file no approval asked for: the step whose download it is. */
  const ownerOf = (tab: DownloadHoldTab, item: DownloadHoldItem): ApprovalNeed | undefined => {
    const url = item.url === undefined || item.url === '' ? undefined : item.url;

    return url === undefined
      ? undefined
      : {
          expiresAt: now(),
          kind: 'armed',
          session: tab.session,
          step: tab.step,
          tabId: tab.tabId,
          target: targetOf(url),
        };
  };

  /** Waits up to {@link ATTRIBUTION_WAIT_MS} for an announcement to name the item's tab. */
  const waitForAnnouncement = async (item: DownloadHoldItem): Promise<number | undefined> => {
    const url = item.url === undefined || item.url === '' ? undefined : item.url;
    const until = now() + ATTRIBUTION_WAIT_MS;

    for (;;) {
      for (const [tabId, list] of announcements) {
        if (list.some(entry => !entry.claimed && announcementMatches(entry, url))) {
          return tabId;
        }
      }

      if (now() >= until) {
        return undefined;
      }

      // eslint-disable-next-line no-await-in-loop -- one bounded poll for the announcement Chrome sends first
      await waitFor(HOLD_POLL_MS);
    }
  };

  /**
   * The decision for one owned download, run while Chrome holds its item: it
   * answers Chrome synchronously when the file is the approved one, and reports
   * whether the answer is still owed when the file has to be cancelled first.
   */
  const decide = (
    item: DownloadHoldItem,
    tab: DownloadHoldTab,
    suggest: SuggestFilename
  ): boolean => {
    const announcement = claim(item, tab.tabId);
    const filename = nameOfItem(item, announcement);
    const url = item.url === undefined || item.url === '' ? undefined : item.url;
    const armed = armedFor(tab, item, announcement);
    const need = armed ?? ownerOf(tab, item);

    if (need === undefined) {
      // Nothing can tell a model about this file, so nothing may hold it: it is the user's.
      suggest();

      return false;
    }

    const state: TrackedDownload = {
      filename,
      itemId: item.id,
      kind: 'held',
      need,
      since: now(),
      tabId: tab.tabId,
      url,
    };

    tracked.set(item.id, state);

    if (armed === undefined) {
      void block(state, suggest);

      return true;
    }

    allow(state, suggest);

    return false;
  };

  const handle = (item: DownloadHoldItem, suggest: SuggestFilename): boolean => {
    pruneAnnouncements(now());

    const attribution = classify(item);

    if (attribution.kind === 'foreign') {
      suggest();

      return false;
    }

    if (attribution.kind === 'owned') {
      const tab = tabs.get(attribution.tabId);

      if (tab === undefined) {
        suggest();

        return false;
      }

      return decide(item, tab, suggest);
    }

    void (async (): Promise<void> => {
      const tabId = await waitForAnnouncement(item);

      // A download nothing attributed passes once the wait is over: a page with
      // `no-referrer` that is no agent tab's has to stay the user's, untouched. A
      // guarded call's file is announced a millisecond before its item, so it is
      // claimed inside the wait and decided as the agent's.
      if (tabId === undefined) {
        suggest();

        return;
      }

      const tab = tabs.get(tabId);

      if (tab === undefined) {
        suggest();

        return;
      }

      decide(item, tab, suggest);
    })();

    // The answer is owed: Chrome keeps the item un-completed until `suggest` runs below.
    return true;
  };

  /** The tripwire: an announcement no item claims is reported as possibly saved, never as nothing. */
  const watch = (download: DownloadHoldAnnouncement): void => {
    const key = announcementKey(download);

    if (watched.has(key)) {
      return;
    }

    watched.add(key);
    setTimeout(() => {
      watched.delete(key);

      const session = tabs.get(download.tabId)?.session;
      const open = announcements
        .get(download.tabId)
        ?.some(entry => !entry.claimed && announcementKey(entry) === key);

      if (session === undefined || open !== true) {
        return;
      }

      // No item ever claimed it: the browser raised the item where this guard could
      // not see it, or never raised one at all. Either way the file may exist.
      const need = needs.get(session) ?? {
        expiresAt: now(),
        kind: 'armed' as const,
        session,
        step: tabs.get(download.tabId)?.step,
        tabId: download.tabId,
        target: targetOf(download.url ?? ''),
      };

      report({
        filename:
          download.suggestedFilename ?? requestedName(download.url) ?? 'the downloaded file',
        itemId: undefined,
        kind: 'escaped',
        need,
        reason: 'unobserved',
        since: now(),
        tabId: download.tabId,
        url: download.url,
      });
    }, TRIPWIRE_MS);
  };

  return {
    announce: download => {
      const list = announcements.get(download.tabId);
      // A browser that names no time still named the file now: without a stamp the pruner
      // Would take it for an ancient announcement and drop it before its item could claim it.
      const entry = { ...download, claimed: false, startedAt: download.startedAt ?? now() };

      // An announcement only says where a click's file is going: the item is the only
      // thing decided, so an announcement never spends a need by itself.
      if (list === undefined) {
        announcements.set(download.tabId, [entry]);
      } else {
        list.push(entry);
      }

      watch(entry);
    },
    arm: need => {
      needs.set(need.session, need);
    },
    closeSession: session => {
      needs.delete(session);
      owed.delete(session);

      for (const [tabId, tab] of tabs) {
        if (tab.session === session) {
          tabs.delete(tabId);
          announcements.delete(tabId);
          navigations.delete(tabId);
        }
      }

      for (const [itemId, state] of tracked) {
        if (state.need.session === session) {
          tracked.delete(itemId);
        }
      }
    },
    drain: session => {
      const reports = owed.get(session) ?? [];

      owed.delete(session);

      // A decided item is remembered until its report is read: a diagnostic reads
      // the states, and a session that has read its reports needs nothing more.
      for (const [itemId, state] of tracked) {
        if (state.need.session === session && state.kind !== 'held') {
          tracked.delete(itemId);
        }
      }

      return reports;
    },
    escape: (download, session) => {
      // The item will never exist: nothing was listening for it. The file may, so it is reported now.
      const [entry] = announcements.get(download.tabId) ?? [];

      if (entry !== undefined) {
        entry.claimed = true;
      }

      report({
        filename:
          download.suggestedFilename ?? requestedName(download.url) ?? 'the downloaded file',
        itemId: undefined,
        kind: 'escaped',
        need: needs.get(session) ?? {
          expiresAt: now(),
          kind: 'armed',
          session,
          step: tabs.get(download.tabId)?.step,
          tabId: download.tabId,
          target: targetOf(download.url ?? ''),
        },
        reason: 'unobserved',
        since: now(),
        tabId: download.tabId,
        url: download.url,
      });
    },
    handle,
    navigate: navigation => {
      navigations.set(navigation.tabId, navigation);
    },
    needOf,
    settle: async (session, window) => {
      const until = window.since + window.timeoutMs;
      const graceUntil = window.since + window.graceMs;
      let state: DownloadSettle = 'no_sign';

      for (;;) {
        const states = [...tracked.values()].filter(
          one => one.need.session === session && one.since >= window.since
        );

        if (!states.some(one => one.kind === 'held') && states.length > 0) {
          return 'decided';
        }

        // A download started: the browser creates the item a moment after it announces the file, so the call
        // Waits for that item instead of answering before it exists.
        if (state === 'no_sign' && window.sign()) {
          state = 'waiting_for_item';
        }

        if (state === 'waiting_for_item' && now() >= until) {
          // Signed, and nothing was decided inside the bound: the caller reports the file as possibly saved.
          return state;
        }

        if (state === 'no_sign' && now() >= graceUntil) {
          return state;
        }

        // eslint-disable-next-line no-await-in-loop -- one bounded poll for this call's own decision
        await waitFor(HOLD_POLL_MS);
      }
    },
    tab: input => {
      if ('detach' in input) {
        announcements.delete(input.detach);
        tabs.delete(input.detach);
        navigations.delete(input.detach);

        return;
      }

      tabs.set(input.tabId, input);
    },
    tracked: itemId => tracked.get(itemId),
  };
};
