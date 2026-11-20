/**
 * Where the download hold lives in the service worker: one hold, one
 * `onDeterminingFilename` listener, and the session storage that keeps a woken
 * worker's decisions honest.
 *
 * Chrome dispatches the event from a router that exists only when a listener
 * was registered at the moment the download was created, so the listener is
 * installed synchronously when this module is imported — before the worker does
 * anything else — and again when the optional `downloads` permission is
 * granted, because until then the event does not exist.
 *
 * The worker may be asleep when a download arrives. Its hold then starts empty,
 * so the agent tabs and approvals a decision reads are mirrored into session
 * storage as they change, and `suggest` is answered from that record rather than
 * from a session this worker has not restored. Session storage dies with the
 * browser session, which is exactly the lifetime of every fact in it.
 */
import { createDownloadHold } from './browser-download-hold';
import type {
  DownloadHold,
  DownloadHoldItem,
  DownloadHoldReport,
  SuggestFilename,
} from './browser-download-hold';
import { installDownloadHoldOnGrant } from './browser-download-hold-listener';
import type {
  DeterminingFilenameDownloadsApi,
  DownloadHoldPermissionsApi,
} from './browser-download-hold-listener';
import { readState, restoreSessions, writeState } from './browser-download-hold-record';
import type { HoldState, SessionStorageApi } from './browser-download-hold-record';

export { DOWNLOAD_HOLD_STATE_KEY } from './browser-download-hold-record';

/** The `chrome.downloads` slice the hold needs. */
interface DownloadsApi extends DeterminingFilenameDownloadsApi {
  readonly cancel: (downloadId: number) => Promise<void>;
  readonly search?: (query: {
    readonly id?: number;
  }) => Promise<readonly { readonly id: number; readonly state?: string }[]> | undefined;
}

/** The browser globals, read lazily so the listener can register at import time. */
export interface DownloadHoldGlobals {
  readonly downloads: () => DownloadsApi | undefined;
  /**
   * The extension's own origin, `chrome.runtime.getURL('')`. It is the only signal at startup: the event itself is
   * absent until the optional `downloads` permission is granted, in Chrome exactly as it is on Firefox.
   */
  readonly extensionOrigin: () => string | undefined;
  readonly permissions?: (() => DownloadHoldPermissionsApi | undefined) | undefined;
  /** `chrome.storage.session`; absent in a browser without it, where the live hold is the only copy. */
  readonly sessionStorage?: (() => SessionStorageApi | undefined) | undefined;
}

/**
 * Builds the hold and installs its listener, or `undefined` in a browser that can never raise the event it answers:
 * Firefox has no `onDeterminingFilename`, and its guard cancels a file after it starts instead.
 *
 * Chrome returns the hold even before the optional `downloads` permission is granted — the event does not exist yet,
 * and the grant is what makes it — so the browser's identity decides, never the permission or the event itself.
 *
 * The record is restored in the background so the listener exists before the first download, but no decision is
 * taken against the live hold until that read lands: a download whose event woke this worker is classified from the
 * record, never from an empty hold.
 */
export const startDownloadHold = (globals: DownloadHoldGlobals): DownloadHold | undefined => {
  // Only Chrome raises the event. Firefox has none, and a browser that will not name its own origin cannot prove it
  // Does: neither gets a hold, so the runtime's cancel-after-start guard is the one that arms for its downloads.
  if (globals.extensionOrigin()?.startsWith('chrome-extension://') !== true) {
    return undefined;
  }

  const storageOf = (): SessionStorageApi | undefined => globals.sessionStorage?.();
  /** The record as this worker knows it: every write replaces it whole. */
  const state: HoldState = {};
  /** Sessions this worker closed before its record was read: restoring one would bring back a tab that is gone. */
  const closed = new Set<string>();
  /** Tabs this worker forgot before its record was read: restoring one would re-register a page that is gone. */
  const detached = new Set<number>();
  /** Registrations made before the record was read: applied after it, so neither the record nor the call is lost. */
  const pending: (() => void)[] = [];
  /** Restored once, before the first write: a write must not erase a record this worker has not read yet. */
  const { promise: hydration, resolve: hydrated } = Promise.withResolvers<void>();

  /**
   * Whether a decision may read the hold: `restoring` until the record is applied, so no decision and no write is
   * taken against the partial view a woken worker starts with.
   */
  let decision:
    | { readonly kind: 'restoring'; readonly record: Promise<void> }
    | { readonly kind: 'ready' } = { kind: 'restoring', record: hydration };

  /** The session's mirror entry, created empty: what a report or a registration is recorded into. */
  const recordOf = (session: string) => {
    const existing = state[session];

    if (existing !== undefined) {
      return existing;
    }

    const created: HoldState[string] = { owed: [], tabs: [] };

    state[session] = created;

    return created;
  };

  const write = async (): Promise<void> => {
    // A write before the record is read would replace it with this worker's partial view of it.
    await hydration;
    await writeState(storageOf(), state);
  };

  /**
   * A tab or an approval registered by a call that woke this worker, applied after the record is read: the record is
   * the session's whole history, and writing this registration into the live entry first would leave its rest behind.
   */
  const register = (apply: () => void): void => {
    if (decision.kind === 'restoring') {
      pending.push(apply);
    } else {
      apply();
      void write();
    }
  };

  const hold = createDownloadHold({
    cancel: async itemId => {
      const api = globals.downloads();

      if (api === undefined) {
        throw new Error('The downloads permission is gone.');
      }

      await api.cancel(itemId);
    },
    onReport: (report, session) => {
      recordOf(session).owed = [...recordOf(session).owed, report];
      void write();
    },
    onSpent: need => {
      // The record keeps the approval exactly as the hold now holds it: spent. A worker that restarts inside the
      // Token's lifetime then refuses the second file instead of arming the approval the first file already spent.
      recordOf(need.session).need = need;
      void write();
    },
    search: async itemId => (await globals.downloads()?.search?.({ id: itemId })) ?? [],
  });

  /** How a download is answered: at once once the record is read, or owed until it is (Chrome holds the item 15 s). */
  const decide = (item: DownloadHoldItem, suggest: SuggestFilename): boolean => {
    if (decision.kind === 'ready') {
      return hold.handle(item, suggest);
    }

    const restored = decision.record;

    void (async (): Promise<void> => {
      await restored;
      hold.handle(item, suggest);
    })();

    return true;
  };

  installDownloadHoldOnGrant({
    downloads: globals.downloads,
    handle: decide,
    permissions: globals.permissions?.(),
  });

  void (async (): Promise<void> => {
    try {
      restoreSessions({ closed, detached, hold, state, stored: await readState(storageOf()) });
    } catch {
      // A record that cannot be applied leaves the live hold: fewer tabs are owned, never more.
    } finally {
      // The registrations made before the read are applied last, so the call that woke this worker is what the hold
      // And the record both end with — and the merged record is persisted once, now that both halves are in it.
      if (pending.length > 0) {
        for (const apply of pending.splice(0)) {
          apply();
        }

        void write();
      }

      // Once the record is read it is the authority: a later detach edits it directly, so the pre-read list is spent.
      // It clears only now, so a tab detached mid-restore is not re-registered by a registration still waiting here.
      detached.clear();

      // Whatever the record said, the hold is answerable now: a decision may wait no longer than the read, and never
      // Hangs on one that threw.
      decision = { kind: 'ready' };
      hydrated();
    }
  })();

  return {
    announce: download => {
      hold.announce(download);
    },
    arm: need => {
      hold.arm(need);
      register(() => {
        recordOf(need.session).need = need;
      });
    },
    closeSession: session => {
      hold.closeSession(session);
      delete state[session];
      // A session closed before the record was read is gone for good: restoring it would re-register a tab of a
      // Session that no longer exists, and a download on that page would be reported to nobody.
      closed.add(session);
      void write();
    },
    drain: session => {
      const record = state[session];
      const seen: (DownloadHoldReport | HoldState[string]['owed'][number])[] = [
        ...(record?.owed ?? []),
        ...hold.drain(session),
      ];
      const reports = seen.filter(
        (report, index) =>
          seen.findIndex(
            candidate => candidate.filename === report.filename && candidate.tabId === report.tabId
          ) === index
      );

      if (record !== undefined) {
        record.owed = [];
        void write();
      }

      return reports.map(report => ({
        filename: report.filename,
        kept: report.kept,
        since: report.since,
        step: report.step === undefined ? undefined : { ...report.step },
        tabId: report.tabId,
        url: report.url,
      }));
    },
    escape: hold.escape,
    handle: decide,
    navigate: navigation => {
      hold.navigate(navigation);
    },
    needOf: session => hold.needOf(session),
    settle: async (session, window) => {
      // A call that woke this worker may reach its settle before the record is read: the decisions it is waiting for
      // Are the record's, so it waits for the same read a waking download does.
      await hydration;

      return hold.settle(session, window);
    },
    tab: input => {
      if ('detach' in input) {
        // A tab forgotten before the record was read may not come back: the record still lists it.
        detached.add(input.detach);

        for (const record of Object.values(state)) {
          record.tabs = record.tabs.filter(tab => tab.tabId !== input.detach);
        }

        hold.tab(input);
        void write();

        return;
      }

      // The hold learns the tab now: a download is attributed by it the moment the tool runs. Its mirror waits for
      // The record only when the record has not been read, so the session's other tabs are never replaced by this one.
      hold.tab(input);
      register(() => {
        const record = recordOf(input.session);

        record.tabs = [...record.tabs.filter(tab => tab.tabId !== input.tabId), input];
      });
    },
    tracked: itemId => hold.tracked(itemId),
  };
};
