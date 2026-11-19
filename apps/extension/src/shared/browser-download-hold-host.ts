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
import { z } from 'zod';
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

/** Where the record lives, under one key, so a reader sees one whole value. The prefix selects `storage.session`. */
export const DOWNLOAD_HOLD_STATE_KEY = 'session:kiloDownloadHoldState' as const;

const stepSchema = z.object({
  argumentHash: z.string(),
  description: z.string(),
  noun: z.string(),
  origin: z.string(),
  session: z.string(),
  tabId: z.number(),
  toolName: z.string(),
});

const targetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('url'), page: z.string().optional(), url: z.string() }),
  z.object({ kind: z.literal('scheme'), name: z.string().optional(), scheme: z.string() }),
]);

const needSchema = z.discriminatedUnion('kind', [
  z.object({
    expiresAt: z.number(),
    kind: z.literal('armed'),
    session: z.string(),
    step: stepSchema.optional(),
    tabId: z.number(),
    target: targetSchema,
  }),
  z.object({
    filename: z.string(),
    itemId: z.number(),
    kind: z.literal('spent'),
    session: z.string(),
    step: stepSchema.optional(),
    tabId: z.number(),
    target: targetSchema,
  }),
]);

const reportSchema = z.object({
  filename: z.string(),
  kept: z.boolean(),
  since: z.number(),
  step: stepSchema.optional(),
  tabId: z.number(),
  url: z.string().optional(),
});

const tabSchema = z.object({
  page: z.string(),
  session: z.string(),
  step: stepSchema.optional(),
  tabId: z.number(),
});

const sessionStateSchema = z.object({
  need: needSchema.optional(),
  owed: z.array(reportSchema),
  tabs: z.array(tabSchema),
});

const stateSchema = z.record(z.string(), sessionStateSchema);

type HoldState = z.infer<typeof stateSchema>;

/** The `storage.session` slice the record needs: the same area the tab leases live in. */
interface SessionStorageApi {
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- storage hands back whatever an earlier write left; `readState` parses it with the record schema.
  readonly getItem: (key: typeof DOWNLOAD_HOLD_STATE_KEY) => Promise<unknown>;
  readonly setItem: (key: typeof DOWNLOAD_HOLD_STATE_KEY, value: unknown) => Promise<void> | void;
}

/** The `chrome.downloads` slice the hold needs. */
interface DownloadsApi extends DeterminingFilenameDownloadsApi {
  readonly cancel: (downloadId: number) => Promise<void>;
  readonly erase?: ((query: { readonly id: number }) => Promise<void> | undefined) | undefined;
  readonly search?: (query: {
    readonly id?: number;
  }) => Promise<readonly { readonly id: number; readonly state?: string }[]> | undefined;
}

/** The browser globals, read lazily so the listener can register at import time. */
export interface DownloadHoldGlobals {
  readonly downloads: () => DownloadsApi | undefined;
  readonly permissions?: (() => DownloadHoldPermissionsApi | undefined) | undefined;
  /** `chrome.storage.session`; absent in a browser without it, where the live hold is the only copy. */
  readonly sessionStorage?: (() => SessionStorageApi | undefined) | undefined;
}

const readState = async (api: SessionStorageApi | undefined): Promise<HoldState> => {
  if (api === undefined) {
    return {};
  }

  try {
    const parsed = stateSchema.safeParse(await api.getItem(DOWNLOAD_HOLD_STATE_KEY));

    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
};

const writeState = async (api: SessionStorageApi | undefined, state: HoldState): Promise<void> => {
  if (api === undefined) {
    return;
  }

  try {
    await api.setItem(DOWNLOAD_HOLD_STATE_KEY, state);
  } catch {
    // A write that fails leaves the previous record: a decision then owns fewer tabs, never more.
  }
};

/**
 * Builds the hold and installs its listener. The record is restored in the
 * background: a download that arrives first is decided by the live hold alone,
 * which is all a worker that never slept ever has.
 */
export const startDownloadHold = (globals: DownloadHoldGlobals): DownloadHold => {
  const storageOf = (): SessionStorageApi | undefined => globals.sessionStorage?.();
  /** The record as this worker knows it: every write replaces it whole. */
  const state: HoldState = {};
  /** The sessions this worker decided about before its record was read: what it knows is newer than the record. */
  const touched = new Set<string>();
  /** Restored once, before the first write: a write must not erase a record this worker has not read yet. */
  const { promise: hydration, resolve: hydrated } = Promise.withResolvers<void>();

  const recordOf = (session: string) => {
    const existing = state[session];

    if (existing !== undefined) {
      return existing;
    }

    const created: HoldState[string] = { owed: [], tabs: [] };

    state[session] = created;
    touched.add(session);

    return created;
  };

  const write = async (): Promise<void> => {
    // A write before the record is read would replace it with this worker's partial view of it.
    await hydration;
    await writeState(storageOf(), state);
  };

  const hold = createDownloadHold({
    cancel: async itemId => {
      const api = globals.downloads();

      if (api === undefined) {
        throw new Error('The downloads permission is gone.');
      }

      await api.cancel(itemId);
    },
    erase: itemId => globals.downloads()?.erase?.({ id: itemId }),
    onReport: (report, session) => {
      recordOf(session).owed = [...recordOf(session).owed, report];
      void write();
    },
    search: async itemId => (await globals.downloads()?.search?.({ id: itemId })) ?? [],
  });

  installDownloadHoldOnGrant({
    downloads: globals.downloads,
    handle: (item, suggest) => hold.handle(item, suggest),
    permissions: globals.permissions?.(),
  });

  void (async (): Promise<void> => {
    const stored = await readState(storageOf());

    for (const [session, record] of Object.entries(stored)) {
      // A session this worker already decided about is the newer truth: the record is only what it missed.
      if (!touched.has(session)) {
        state[session] = record;

        for (const tab of record.tabs) {
          hold.tab({
            page: tab.page,
            session: tab.session,
            step: tab.step === undefined ? undefined : { ...tab.step },
            tabId: tab.tabId,
          });
        }

        if (record.need !== undefined) {
          hold.arm({
            ...record.need,
            step: record.need.step === undefined ? undefined : { ...record.need.step },
          });
        }
      }
    }

    hydrated();
  })();

  return {
    announce: download => {
      hold.announce(download);
    },
    arm: need => {
      hold.arm(need);
      recordOf(need.session).need = need;
      void write();
    },
    closeSession: session => {
      hold.closeSession(session);
      delete state[session];
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
    handle: (item: DownloadHoldItem, suggest: SuggestFilename) => hold.handle(item, suggest),
    navigate: navigation => {
      hold.navigate(navigation);
    },
    needOf: session => hold.needOf(session),
    settle: (session, window) => hold.settle(session, window),
    tab: input => {
      hold.tab(input);

      if ('detach' in input) {
        for (const record of Object.values(state)) {
          record.tabs = record.tabs.filter(tab => tab.tabId !== input.detach);
        }
      } else {
        const record = recordOf(input.session);

        record.tabs = [...record.tabs.filter(tab => tab.tabId !== input.tabId), input];
      }

      void write();
    },
    tracked: itemId => hold.tracked(itemId),
  };
};
