/**
 * The record a woken service worker restores its download hold from: the one
 * `storage.session` value, its schema, and the two functions that read and
 * write it whole.
 *
 * Session storage dies with the browser session, which is exactly the lifetime
 * of every fact in it: an approval a human gave for one file, and the reports a
 * session still owes its model.
 */
import { z } from 'zod';
import type { DownloadHold, DownloadHoldReport } from './browser-download-hold';

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
  z.object({ kind: z.literal('exact'), url: z.string() }),
  z.object({ kind: z.literal('scheme'), name: z.string().optional(), scheme: z.string() }),
  z.object({ kind: z.literal('url'), page: z.string().optional(), url: z.string() }),
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

export type HoldState = z.infer<typeof stateSchema>;

/**
 * One session's stored record merged with what this worker already knows about it.
 *
 * The live entry is what this worker has seen since it woke — a call's tab registered before the tool ran, the
 * approval it armed, the report it queued — so it wins every fact both carry. The record is the only copy of
 * everything else the session had before the worker slept. A tab detached since then survives in neither.
 */
export const mergeSession = ({
  detached,
  existing,
  stored,
}: {
  readonly detached: ReadonlySet<number>;
  readonly existing: HoldState[string] | undefined;
  readonly stored: HoldState[string];
}): HoldState[string] => {
  const recorded = stored.tabs.filter(
    tab =>
      !detached.has(tab.tabId) && existing?.tabs.some(entry => entry.tabId === tab.tabId) !== true
  );
  const live = (existing?.tabs ?? []).filter(tab => !detached.has(tab.tabId));

  return {
    need: existing?.need ?? stored.need,
    owed: [...stored.owed, ...(existing?.owed ?? [])],
    tabs: [...recorded, ...live],
  };
};

/**
 * Applies a stored record to a session's live mirror and the hold. Each session's record is merged into what the
 * worker already knows (see {@link mergeSession}), a closed session is dropped whole, and only the facts the record
 * alone carried reach the hold: a tab it does not have, and an approval it has no need for. What a waking call
 * registered and armed before this read is therefore never replaced by the older record.
 */
export const restoreSessions = ({
  closed,
  detached,
  hold,
  state,
  stored,
}: {
  readonly closed: ReadonlySet<string>;
  readonly detached: ReadonlySet<number>;
  readonly hold: Pick<DownloadHold, 'arm' | 'needOf' | 'tab'>;
  readonly state: HoldState;
  readonly stored: HoldState;
}): void => {
  for (const [session, record] of Object.entries(stored)) {
    // A session closed before the record was read is gone for good: its tabs and its need died with it.
    if (!closed.has(session)) {
      const existing = state[session];
      const merged = mergeSession({ detached, existing, stored: record });

      state[session] = merged;

      // The live mirror is the authority for the tabs this worker registered: one it already holds keeps its page
      // And step, and the record's older copy of the same tab id is not put back over it.
      for (const tab of merged.tabs) {
        if (existing?.tabs.some(entry => entry.tabId === tab.tabId) !== true) {
          hold.tab({
            page: tab.page,
            session: tab.session,
            step: tab.step === undefined ? undefined : { ...tab.step },
            tabId: tab.tabId,
          });
        }
      }

      // The hold itself answers an approval the waking call armed: the record's is only the tie when it has none. A
      // Mirror alone would say nothing, because the call's need is in both by then while the hold may have dropped an
      // Older token as expired.
      if (record.need !== undefined && hold.needOf(session) === undefined) {
        hold.arm({
          ...record.need,
          step: record.need.step === undefined ? undefined : { ...record.need.step },
        });
      }
    }
  }
};

/**
 * One session's reports as the model reads them: the ones the live hold drained, then the mirror's, each file named
 * once — the same download is queued by whichever side saw it, and a session that reads its reports needs it once.
 */
export const mergeReports = (
  live: readonly DownloadHoldReport[],
  owed: HoldState[string]['owed']
): HoldState[string]['owed'] => {
  const seen = [...owed, ...live];

  return seen.filter(
    (report, index) =>
      seen.findIndex(
        candidate => candidate.filename === report.filename && candidate.tabId === report.tabId
      ) === index
  );
};

/** The `storage.session` slice the record needs: the same area the tab leases live in. */
export interface SessionStorageApi {
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- storage hands back whatever an earlier write left; `readState` parses it with the record schema.
  readonly getItem: (key: typeof DOWNLOAD_HOLD_STATE_KEY) => Promise<unknown>;
  readonly setItem: (key: typeof DOWNLOAD_HOLD_STATE_KEY, value: unknown) => Promise<void> | void;
}

export const readState = async (api: SessionStorageApi | undefined): Promise<HoldState> => {
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

export const writeState = async (
  api: SessionStorageApi | undefined,
  state: HoldState
): Promise<void> => {
  if (api === undefined) {
    return;
  }

  try {
    await api.setItem(DOWNLOAD_HOLD_STATE_KEY, state);
  } catch {
    // A write that fails leaves the previous record: a decision then owns fewer tabs, never more.
  }
};
