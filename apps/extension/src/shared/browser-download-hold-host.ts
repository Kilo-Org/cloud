/* eslint-disable max-lines -- the host is one lifecycle: the read that hydrates the mirror, the mirror itself, and the close that ends both share the closed/detached sets every writer consults, so splitting them would separate each guard from the state it checks. */
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
import type { DownloadHold, DownloadHoldItem, SuggestFilename } from './browser-download-hold';
import { installDownloadHoldOnGrant } from './browser-download-hold-listener';
import type {
  DeterminingFilenameDownloadsApi,
  DownloadHoldPermissionsApi,
} from './browser-download-hold-listener';
import {
  mergeReports,
  readState,
  restoreSessions,
  writeState,
} from './browser-download-hold-record';
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
  /**
   * Sessions whose downloads have ended in this worker: `session.close`, or a caller dispose, which leaves the
   * session's group and registry row live so a later call of that session is still admitted. Either way the record
   * keeps nothing for the session from here on. A handle that reopens is a fresh one from `session.open`, so a handle
   * this set holds never becomes live again.
   */
  const closed = new Set<string>();
  /** Tabs this worker forgot before its record was read: restoring one would re-register a page that is gone. */
  const detached = new Set<number>();
  /** A registration made before the record was read; a close or detach since then wins over it (see `applyPending`). */
  const pending: { apply: () => void; session: string; tabId?: number }[] = [];
  /** Restored once, before the first write: a write must not erase a record this worker has not read yet. */
  const { promise: hydration, resolve: hydrated } = Promise.withResolvers<void>();

  /**
   * Whether a decision may read the hold: `restoring` until the record is applied, so no decision and no write is
   * taken against the partial view a woken worker starts with.
   */
  let decision:
    | { readonly kind: 'restoring'; readonly record: Promise<void> }
    | { readonly kind: 'ready' } = { kind: 'restoring', record: hydration };

  /**
   * The session's mirror entry, created empty: what a report, a spend or a registration is recorded into. A session
   * that has closed has none: that is the one place an entry is created, so the record holds a session's facts only
   * while the session is live.
   */
  const recordOf = (session: string): HoldState[string] | undefined => {
    if (closed.has(session)) {
      return undefined;
    }

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
   * A tab or an approval a waking call registered: written after the record is read, so the record's older copy of the
   * same fact cannot replace it, and dropped when a close or a detach has since ended what it names.
   */
  const register = (session: string, apply: () => void, tabId?: number): void => {
    if (decision.kind === 'restoring') {
      pending.push(tabId === undefined ? { apply, session } : { apply, session, tabId });
    } else {
      apply();
      void write();
    }
  };

  /** Applies what a waking call registered, minus the sessions and tabs a close or a detach has since ended. */
  const applyPending = (): void => {
    for (const { apply, session, tabId } of pending.splice(0)) {
      if (!closed.has(session) && (tabId === undefined || !detached.has(tabId))) {
        apply();
      }
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
      const record = recordOf(session);

      if (record === undefined) {
        // A closed session keeps no report: there is no model left to read it, and the record is a live session's.
        return;
      }

      record.owed = [...record.owed, report];
      void write();
    },
    onSpent: need => {
      const record = recordOf(need.session);

      if (record === undefined) {
        return;
      }

      // The record keeps the approval exactly as the hold now holds it: spent. A worker that restarts inside the
      // Token's lifetime then refuses the second file instead of arming the approval the first file already spent.
      record.need = need;
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

  // The install again for the call about to start a download: a refused registration has no grant edge to lean on (a
  // Throw needs the event, and the event needs the grant), so `tab()` — sent before the tool runs — is the last place
  // A guard can land before the file. A no-op once the listener has registered.
  const install = installDownloadHoldOnGrant({
    downloads: globals.downloads,
    handle: decide,
    permissions: globals.permissions?.(),
  });

  void (async (): Promise<void> => {
    try {
      const stored = await readState(storageOf());

      // A registration that arrived while the record was being read is this worker's newest fact, so it lands first
      // And the record merges into it — never over it. The drain reads `closed`/`detached` again, so a close or a
      // Detach during the read still wins over a call that started before it.
      applyPending();
      restoreSessions({ closed, detached, hold, state, stored });
    } catch {
      // A record that cannot be applied leaves the live hold: fewer tabs are owned, never more.
    } finally {
      // Whatever was registered while the record was applied lands last, over the record's older copy.
      applyPending();
      void write();
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
      // A closed session holds no approval, and keeps none in the record.
      if (closed.has(need.session)) {
        return;
      }

      hold.arm(need);

      register(need.session, () => {
        const record = recordOf(need.session);

        if (record !== undefined) {
          record.need = need;
        }
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
      const reports = mergeReports(hold.drain(session), record?.owed ?? []);

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

      // The hold learns the tab now, and the install runs again: a download is attributed the moment the tool runs,
      // And a registration the browser refused earlier has no other edge before this file. The mirror waits for the
      // Record only when the record has not been read, so the session's other tabs are never replaced by this one.
      if (!closed.has(input.session)) {
        hold.tab(input);
      }

      install();
      register(
        input.session,
        () => {
          const record = recordOf(input.session);

          if (record !== undefined) {
            record.tabs = [...record.tabs.filter(tab => tab.tabId !== input.tabId), input];
          }
        },
        input.tabId
      );
    },
    tracked: itemId => hold.tracked(itemId),
  };
};
