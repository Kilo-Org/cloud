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
  /** The element the gate classified this step on, when it classified one: an approval for its file binds it too. */
  readonly element?: string | undefined;
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
  | { readonly kind: 'url'; readonly page?: string | undefined; readonly url: string }
  /** One url alone, never its page: a refusal whose own file is unknown arms only the file the browser named. */
  | { readonly kind: 'exact'; readonly url: string };

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
 * A download attributed to an agent tab whose decision is in flight: Chrome holds the item until `suggest` runs, so
 * the item id is always known and every later state is reached from here.
 */
export interface HeldDownload {
  readonly filename: string;
  readonly itemId: number;
  readonly kind: 'held';
  readonly need: ApprovalNeed;
  readonly since: number;
  readonly tabId: number;
  readonly url: string | undefined;
}

/**
 * One download the hold is deciding. Every state carries the need its token
 * carries, so the need lives exactly as long as the token does and nothing
 * outlives it into a later session.
 */
export type TrackedDownload =
  | HeldDownload
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

/**
 * What a call has seen of a download, as one state rather than a pair of flags.
 * - `download`: something the call can name said a file started — the tab's announcement, or a load the browser
 *   answered as a file.
 * - `pending`: a Document the call started has no answer from the browser yet. It may become a file, so a call may
 *   not answer `no_sign` while one is outstanding: a click's attachment response arrives a few milliseconds after the
 *   click returned, and a settle that gave up before then answered "nothing happened" for a file it had just saved.
 * - `none`: nothing of the call's can still become a file.
 */
export type DownloadSign = 'download' | 'none' | 'pending';

/**
 * How a call's settle ends, as one state rather than a pair of flags:
 * - `no_sign`: nothing suggested a download, so the call answered after the short grace.
 * - `waiting_for_item`: a download started and no item was decided inside the bound; the file may exist.
 * - `decided`: the hold decided the item, and its report is what the call answers with.
 */
export type DownloadSettle = 'decided' | 'no_sign' | 'waiting_for_item';

/** How long one call waits for its own download's decision after the tool answered. */
export interface SettleWindow {
  /** The call's own start: a decision older than this belongs to a call already answered. Only the filter. */
  readonly since: number;
  /** How long to wait for a sign at all, measured from the settle: only a call with nothing pending pays it. */
  readonly graceMs: number;
  /** What the call has seen so far: the sign, a Document of its own still outstanding, or nothing. */
  readonly sign: () => DownloadSign;
  /** How long to wait for the call's decision, measured from the settle's own entry: never `since + timeoutMs`. */
  readonly timeoutMs: number;
}

export interface DownloadHold {
  /** The browser announced a download on an agent tab, before its item existed. */
  readonly announce: (download: DownloadHoldAnnouncement) => void;
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

/**
 * How long a settling call that already has a decision keeps listening for the gesture's other files. One click
 * that hands the browser two attachments produces two items milliseconds apart, and the first refusal must not end
 * the call: the sibling's own refusal belongs to that call, not to whichever call happens to come next.
 */
export const SETTLE_QUIET_MS = 400;

/**
 * How long a settle that entered with no sign keeps listening for one: measured on real Chrome, a click's
 * `downloadWillBegin` landed at most 25 ms after the tool answered, so a grace measured from the call start misses it.
 */
export const DOWNLOAD_SIGN_GRACE_MS = 30;

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

/** The origin a url names: what an origin-only referrer can still be compared by. */
const originOf = (url: string | undefined): string | undefined => {
  try {
    return new URL(url ?? '').origin;
  } catch {
    return undefined;
  }
};

/**
 * Whether a url carries nothing but its origin. A cross-origin attachment's referrer is origin-only under Chrome's
 * default `strict-origin-when-cross-origin` policy: the path was withheld from the request, not never there.
 */
const isOriginOnly = (url: string | undefined): boolean => {
  try {
    const parsed = new URL(url ?? '');

    return parsed.pathname === '/' && parsed.search === '' && parsed.hash === '';
  } catch {
    return false;
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
  if (target.kind === 'exact') {
    return item.url === target.url;
  }

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
 * A file this hold already decided on a tab, remembered by the download it was. Chrome raises
 * `downloadWillBegin` before the item for an attachment whose response is already in flight, but after it when the
 * response only becomes a file later: that announcement names a download this tab has settled, never a new one.
 *
 * The identity is the exact url the browser named, never the page: one page downloads `report.txt` again on every
 * click, and a page that regenerates its link (`?click=2`) is a second download of a file the hold has not decided.
 */
interface SettledFile {
  /** The url the browser named for the item, exactly: the one identity an announcement and an item share. */
  readonly url: string;
  /** When the hold decided it, so only an announcement that arrives afterwards can be that late arrival. */
  readonly since: number;
}

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
  now = Date.now,
  onReport,
  onSpent,
  search,
}: {
  readonly cancel: (itemId: number) => Promise<void>;
  readonly now?: () => number;
  /** Called once per report as it is queued, so a worker that sleeps before the next call does not lose it. */
  readonly onReport?: ((report: DownloadHoldReport, session: string) => void) | undefined;
  /** Called the moment an armed approval is spent, so a record keeps the one file it bought spent across a restart. */
  readonly onSpent?: ((need: ApprovalNeed) => void) | undefined;
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
  /** The files each tab has already had decided, by the url the browser named: what a late announcement belongs to. */
  const settledFiles = new Map<number, SettledFile[]>();

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

  /**
   * Remembers a file this tab has decided, so a `downloadWillBegin` that names it afterwards is read as that
   * download's own late announcement instead of a second, unobserved file. The url is the identity, exactly: the
   * name is not enough — a page that downloads `report.txt` twice has two files — and the page is not either, since
   * a page that regenerates its link downloads a different file the hold has not decided.
   */
  const noteSettled = (tabId: number, url: string | undefined, since: number): void => {
    if (url === undefined || url === '') {
      return;
    }

    const live = (settledFiles.get(tabId) ?? []).filter(
      entry => entry.since + ANNOUNCEMENT_TTL_MS >= since
    );

    settledFiles.set(tabId, [...live, { since, url }]);
  };

  /**
   * Whether this announcement names a download the tab settled already. The ordering says nothing: the browser
   * raises `downloadWillBegin` before the item while the response is in flight and after it when the response only
   * becomes a file later, and either way the announcement is that settled download's own event.
   */
  const isSettled = (tabId: number, url: string | undefined, at: number): boolean =>
    url !== undefined &&
    url !== '' &&
    (settledFiles.get(tabId) ?? []).some(
      entry => entry.url === url && Math.abs(at - entry.since) <= ANNOUNCEMENT_TTL_MS
    );

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

    // An origin-only referrer names no page: a cross-origin attachment's document (and a same-origin one, which the
    // Browser also reduces) reports `origin/`, so the page it came from was withheld, not absent. The origin is then
    // The strongest tie there is — and it is enough to fail closed, because the file is attributed to whichever agent
    // Tab shares it rather than saved unanswered.
    const origin = isOriginOnly(referrer) ? originOf(referrer) : undefined;

    if (origin === undefined) {
      return undefined;
    }

    for (const [tabId, tab] of tabs) {
      if (originOf(tab.page) === origin) {
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

  /**
   * The agent tab whose unclaimed announcement already named this item's url. Only a url the announcement carries
   * counts: an announcement with none would otherwise claim the next item on any tab, and a user's own file would be
   * cancelled and reported as the agent's.
   */
  const tabByAnnouncement = (item: DownloadHoldItem): number | undefined => {
    const url = item.url === undefined || item.url === '' ? undefined : item.url;

    if (url === undefined) {
      return undefined;
    }

    for (const [tabId, list] of announcements) {
      if (tabs.has(tabId) && list.some(entry => !entry.claimed && entry.url === url)) {
        return tabId;
      }
    }

    return undefined;
  };

  const classify = (item: DownloadHoldItem): Attribution => {
    if (item.byExtensionId !== undefined) {
      return { kind: 'foreign' };
    }

    // No agent tab is registered: no click of the agent's can be the cause.
    if (tabs.size === 0) {
      return { kind: 'foreign' };
    }

    // The browser named this exact file on an agent tab a moment before the item: owned whichever way the referrer
    // Points, which is what an origin-only or withheld referrer leaves to read.
    const announced = tabByAnnouncement(item);

    if (announced !== undefined) {
      return { kind: 'owned', tabId: announced };
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
    // The one file the approval bought is spent: a record that keeps the armed need would let a restarted worker
    // Arm the same approval again, and a second file would land without a new human answer.
    onSpent?.(spent);

    return spent;
  };

  /**
   * `held` → `escaped`: the hold cannot prove the file is gone, so the model is told it may exist. The state is
   * returned rather than written: a settling download stays `held` until its report is queued, so a call's settle
   * never reads a verdict the model has not been told yet.
   */
  const escape = (state: TrackedDownload, reason: EscapedReason): TrackedDownload => {
    if (state.kind !== 'held' && state.kind !== 'blocked') {
      return state;
    }

    return {
      filename: state.filename,
      itemId: state.itemId,
      kind: 'escaped',
      need: state.need,
      reason,
      since: state.since,
      tabId: state.tabId,
      url: state.url,
    };
  };

  /** `held` → `allowed`: the need is spent and `suggest` lets the file land under the browser's name. */
  const allow = (state: HeldDownload, suggest: SuggestFilename): void => {
    tracked.set(state.itemId, {
      filename: state.filename,
      itemId: state.itemId,
      kind: 'allowed',
      need: spend(state.need, state.itemId, state.filename),
      since: state.since,
      tabId: state.tabId,
      url: state.url,
    });
    noteSettled(state.tabId, state.url, state.since);
    suggest();
  };

  /**
   * `held` → `blocked`: cancel before `suggest`, confirm the state, then answer Chrome. A cancel that threw, an item
   * the browser had already completed, or one it cannot describe is `escaped` instead: the file may exist, and the
   * report says so.
   *
   * The stopped item is left in the browser's download list, as the runtime's own guard leaves it: the cancel is
   * Chrome's own proof that no file exists, and the user can still see that the attempt was interrupted. The verdict
   * is written last, after its report is queued: a call's settle ends on a settled state, and the call that reads its
   * reports must not find a verdict it was never told about.
   */
  const block = async (state: HeldDownload, suggest: SuggestFilename): Promise<void> => {
    let cancelled = true;

    try {
      await cancel(state.itemId);
    } catch {
      cancelled = false;
    }

    // The browser refused to cancel: the file may exist, and the model is told so before anything else.
    const settled = cancelled ? await settledFor(state) : escape(state, 'cancel-failed');

    // Only after the cancel: `suggest` satisfies "exactly once", and no file can be renamed into place.
    suggest();
    report(settled);
    tracked.set(state.itemId, settled);
    noteSettled(state.tabId, state.url, state.since);
  };

  /** The state a cancelled item settled into: `blocked`, or `escaped` when the browser says otherwise. */
  const settledFor = async (state: HeldDownload): Promise<TrackedDownload> => {
    const blocked: TrackedDownload = {
      filename: state.filename,
      itemId: state.itemId,
      kind: 'blocked',
      need: state.need,
      since: state.since,
      tabId: state.tabId,
      url: state.url,
    };
    const listed = await lookUp(state.itemId);

    // The browser could not describe the item: the cancel landed, and its file is unproven.
    // An item it says is complete was never stopped, so the report must say it may exist.
    if (listed.kind === 'unknown') {
      return escape(blocked, 'unobserved');
    }

    return listed.kind === 'found' && listed.item.state === 'complete'
      ? escape(blocked, 'complete')
      : blocked;
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

    const state: HeldDownload = {
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

      // Chrome names an attachment's download before its item while the response is in flight, and after it when the
      // Response only becomes a file later. An announcement that names a download this tab already settled is that
      // download's own event: it is nothing to watch, and the tripwire must not report a file the hold already
      // answered for. The url decides it exactly; a page that downloads the same name again is a new download.
      if (isSettled(download.tabId, download.url, entry.startedAt)) {
        return;
      }

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
          settledFiles.delete(tabId);
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
    handle,
    navigate: navigation => {
      navigations.set(navigation.tabId, navigation);
    },
    needOf,
    settle: async (session, window) => {
      // The wait is measured from this settle, never from the call's start: a tool slower than the bound would
      // Otherwise reach its own settle with the deadline already past, and answer over an item still in flight.
      const until = now() + window.timeoutMs;
      // The grace is measured from this settle: the tab's announcement lands after the tool answered, and a grace
      // Spent before the settle began would miss it. Nothing is released early while the call still has a Document.
      const graceUntil = now() + window.graceMs;
      /** Whether the browser announced a file for this call: the item then exists a moment later. */
      let signed = false;
      /** When this call's decided set last grew: the gesture's next item restarts the quiet window. */
      let decidedAt: number | undefined = 0;
      let decidedSeen = '';

      for (;;) {
        const states = [...tracked.values()].filter(
          one => one.need.session === session && one.since >= window.since
        );
        const decided = states.filter(one => one.kind !== 'held');
        const signature = decided.map(one => `${String(one.itemId)}:${one.kind}`).join(',');

        if (signature !== decidedSeen) {
          decidedSeen = signature;
          decidedAt = decided.length === 0 ? undefined : now();
        }

        // One gesture can hand the browser several files: a decision that stopped the first is not the whole answer
        // While the click's other item is still on its way, so the call keeps listening until the gesture has been
        // Quiet for the window, or the call's own bound is spent.
        const quiet = decidedAt !== undefined && now() - decidedAt >= SETTLE_QUIET_MS;

        if (decided.length > 0 && decided.length === states.length && (now() >= until || quiet)) {
          return 'decided';
        }

        const sign = window.sign();

        // A download started: the browser creates the item a moment after it announces the file, so the call
        // Waits for that item instead of answering before it exists.
        if (sign === 'download') {
          signed = true;
        }

        if (now() >= until) {
          // A decision this call owns is its answer; an item of its own it could not decide, or a file the browser
          // Announced and never created, may exist; nothing at all is a call that started no download.
          if (decided.length > 0) {
            return 'decided';
          }

          return states.length > 0 || signed ? 'waiting_for_item' : 'no_sign';
        }

        // An item of this call exists and its decision is not written yet: the call may not answer over it, however
        // The announcement fared — the item itself is proof the browser started the file.
        if (states.length === 0 && !signed && sign !== 'pending' && now() >= graceUntil) {
          return 'no_sign';
        }

        // eslint-disable-next-line no-await-in-loop -- one bounded poll for this call's own decision
        await waitFor(HOLD_POLL_MS);
      }
    },
    tab: input => {
      if ('detach' in input) {
        announcements.delete(input.detach);
        settledFiles.delete(input.detach);
        tabs.delete(input.detach);
        navigations.delete(input.detach);

        return;
      }

      tabs.set(input.tabId, input);
    },
    tracked: itemId => tracked.get(itemId),
  };
};
