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
import type { DownloadHold } from './browser-download-hold';

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
 * A live entry is newer where both carry a fact — the report it queued, the approval it saw spent — so it wins those;
 * the record is the only copy of everything else the session had before the worker slept: its other tabs, an approval
 * a human granted, the reports a previous worker queued. A tab the worker detached is dropped from both.
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
  const tabs = stored.tabs.filter(
    tab =>
      !detached.has(tab.tabId) && existing?.tabs.some(entry => entry.tabId === tab.tabId) !== true
  );

  return {
    need: existing?.need ?? stored.need,
    owed: [...stored.owed, ...(existing?.owed ?? [])],
    tabs: [...tabs, ...(existing?.tabs ?? [])],
  };
};

/**
 * Applies a stored record to a session's live mirror and the hold. Each session's record is merged into what the
 * worker already knows (see {@link mergeSession}), a closed session is dropped whole, and only the facts the record
 * alone carried are registered: the tabs the hold does not have, and the approval it has no need for.
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
  readonly hold: Pick<DownloadHold, 'arm' | 'tab'>;
  readonly state: HoldState;
  readonly stored: HoldState;
}): void => {
  for (const [session, record] of Object.entries(stored)) {
    // A session closed before the record was read is gone for good: its tabs and its need died with it.
    if (!closed.has(session)) {
      const existing = state[session];
      const merged = mergeSession({ detached, existing, stored: record });

      state[session] = merged;

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

      if (merged.need === record.need && record.need !== undefined) {
        hold.arm({
          ...record.need,
          step: record.need.step === undefined ? undefined : { ...record.need.step },
        });
      }
    }
  }
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
