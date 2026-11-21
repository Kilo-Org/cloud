/* eslint-disable max-lines -- The controller owns session, group and tab-id state that reads as one state machine; splitting it would scatter the id bookkeeping. */
import { z } from 'zod';

/**
 * One Chrome tab group per agent session, titled `Kilo · <title>`. Every
 * injected member is optional: Firefox before 139 has no `tabGroups` API.
 */
export const BROWSER_TAB_GROUP_COLOR = 'grey';

/** The ended group keeps its tabs; the title and collapsed state say so. */
export const browserTabGroupEndedTitle = (): string => 'Kilo · ended';

/** Exact live title, with the middle dot and the spaces around it. */
export const browserTabGroupTitle = (title: string): string => `Kilo · ${title}`;

type MaybeAsync<Value> = Value | Promise<Value>;

export interface BrowserTabGroupInfo {
  readonly collapsed?: boolean | undefined;
  readonly color?: string | undefined;
  readonly id?: number | undefined;
  readonly title?: string | undefined;
  readonly windowId?: number | undefined;
}
export type BrowserTabGroupUpdate = Pick<BrowserTabGroupInfo, 'collapsed' | 'color' | 'title'>;
export interface BrowserActiveTabInfo {
  readonly active?: boolean | undefined;
  readonly id?: number | undefined;
}
export type BrowserTabQuery = Pick<BrowserActiveTabInfo, 'active'> & {
  readonly lastFocusedWindow?: boolean | undefined;
};

/** The injected browser surface; responses are validated at every call. */
export interface BrowserTabGroupsApi {
  /**
   * `tabs.group`: with `groupId` a tab joins that group; without it the tab's
   * window gets a new group. chrome rejects an empty `tabIds`.
   */
  readonly group?: (options: {
    readonly groupId?: number;
    readonly tabIds: number[];
  }) => MaybeAsync<number>;
  readonly queryGroup?: (groupId: number) => MaybeAsync<readonly BrowserTabGroupInfo[]>;
  /** `tabGroups.update`: the only way to set a title or collapsed state. */
  readonly update?: (groupId: number, props: BrowserTabGroupUpdate) => MaybeAsync<void>;
  readonly get?: (groupId: number) => MaybeAsync<BrowserTabGroupInfo | undefined>;
  /** `tabs.get(tabId).groupId`: the live group a tab is in, `-1` or undefined when ungrouped. */
  readonly tabGroupOf?: (tabId: number) => MaybeAsync<number | undefined>;
  /** `tabs.query`: resolves the active tab when a share names none. */
  readonly tabQuery?: (query: BrowserTabQuery) => MaybeAsync<readonly BrowserActiveTabInfo[]>;
}
export interface BrowserTabGroupSessionSummary {
  readonly ended: boolean;
  readonly groupId?: number | undefined;
  readonly sessionHandle: string;
  readonly tabs: readonly number[];
  readonly title: string;
}
export interface BrowserSessionRef {
  readonly sessionHandle: string;
}
export interface BrowserOpenSessionInput extends BrowserSessionRef {
  readonly controllerId: string;
  readonly title: string;
}
export interface BrowserShareTabInput extends BrowserSessionRef {
  readonly tabId?: number | undefined;
}
export interface BrowserTabGroupOpenResult {
  readonly groupId?: number | undefined;
}
/** `shareActiveTab`'s outcome; only `shared` grouped and recorded the tab. */
export type BrowserShareTabResult =
  | { readonly kind: 'shared'; readonly groupId?: number | undefined; readonly tabId: number }
  /** The browser reported no active tab. */
  | { readonly kind: 'no_tab' }
  /** The tab is in another live session's reach (D9). */
  | { readonly kind: 'held'; readonly tabId: number }
  | { readonly kind: 'no_session' };
/** `adoptEnded`'s outcome: `kept` is a session that already owns tabs, `none` means nothing had ended. */
export type BrowserTabGroupAdoptResult =
  | { readonly groupId?: number | undefined; readonly kind: 'adopted' }
  | { readonly kind: 'kept' }
  | { readonly kind: 'none' };

export interface BrowserTabGroupController {
  readonly adoptEnded: (input: BrowserSessionRef) => Promise<BrowserTabGroupAdoptResult>;
  readonly closeSession: (input: BrowserSessionRef) => Promise<void>;
  readonly isTabAllowed: (sessionHandle: string, tabId: number) => boolean;
  readonly listSessions: () => BrowserTabGroupSessionSummary[];
  readonly noteTabAdded: (tabId: number, groupId?: number) => void;
  readonly noteTabRemoved: (tabId: number) => void;
  readonly openSession: (input: BrowserOpenSessionInput) => Promise<BrowserTabGroupOpenResult>;
  /**
   * Reads the sessions an earlier service worker stored. A session this worker
   * already knows wins over its stored copy, and a tab removed before the read
   * finished stays removed. Never rejects: it answers false when storage could
   * not be read, and the next call reads again; nothing is written until a read
   * succeeds, so the stored sessions survive a failed read.
   */
  readonly restore: () => Promise<boolean>;
  readonly sessionForTab: (tabId: number) => string | undefined;
  readonly shareActiveTab: (input: BrowserShareTabInput) => Promise<BrowserShareTabResult>;
  readonly tabsForSession: (sessionHandle: string) => number[];
}

/** Where sessions and their groups outlive the service worker (SPEC: state in `storage.session`). */
export const TAB_GROUP_SESSIONS_STORAGE_KEY = 'session:kiloBrowserTabGroupSessions';
/** Ended groups kept for `/browser adopt`; every conversation leaves one, and they now outlive the worker. */
const ENDED_SESSION_LIMIT = 64;

const tabGroupIdSchema = z.number().int().nonnegative();
const activeTabInfosSchema = z.array(
  z.object({ active: z.boolean().optional(), id: z.number().optional() })
);
const persistedTabGroupSessionSchema = z.object({
  ended: z.boolean(),
  endedAt: z.number().optional(),
  groupId: tabGroupIdSchema.optional(),
  sessionHandle: z.string().min(1),
  tabs: z.array(z.number().int()),
  title: z.string(),
});
const persistedTabGroupSessionsSchema = z.array(persistedTabGroupSessionSchema);

export type PersistedTabGroupSession = z.infer<typeof persistedTabGroupSessionSchema>;

export interface BrowserTabGroupPersistence {
  /** `undefined` when storage held nothing usable: no session survives. */
  readonly read: () => Promise<PersistedTabGroupSession[] | undefined>;
  readonly write: (sessions: readonly PersistedTabGroupSession[]) => Promise<void>;
}

/**
 * Sessions survive a service-worker restart in `storage.session`: a CLI whose
 * worker restarted keeps its handle, its group and its tabs, and an ended
 * group stays adoptable (D12).
 */
export const createStorageSessionTabGroupPersistence = (storageArea: {
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- storage hands back whatever an earlier write left; `read` parses it with the session schema.
  readonly getItem: (key: typeof TAB_GROUP_SESSIONS_STORAGE_KEY) => unknown;
  readonly setItem: (
    key: typeof TAB_GROUP_SESSIONS_STORAGE_KEY,
    value: PersistedTabGroupSession[]
  ) => Promise<void> | void;
}): BrowserTabGroupPersistence => ({
  read: async () => {
    const parsed = persistedTabGroupSessionsSchema.safeParse(
      await storageArea.getItem(TAB_GROUP_SESSIONS_STORAGE_KEY)
    );

    return parsed.success ? parsed.data : undefined;
  },
  write: async sessions => {
    await storageArea.setItem(TAB_GROUP_SESSIONS_STORAGE_KEY, [...sessions]);
  },
});

interface SessionState {
  ended: boolean;
  endedAt?: number | undefined;
  groupId?: number | undefined;
  sessionHandle: string;
  tabs: number[];
  title: string;
}

/**
 * `now` supplies the ended ordering. The factory keeps it monotonic, so a
 * coarse or real-clock source can never tie two sessions: the newest closed
 * session always wins `adoptEnded`.
 */
export const createBrowserTabGroupController = ({
  api,
  now,
  persistence,
}: {
  readonly api: BrowserTabGroupsApi;
  readonly now?: (() => number) | undefined;
  readonly persistence?: BrowserTabGroupPersistence | undefined;
}): BrowserTabGroupController => {
  const sessions = new Map<string, SessionState>();
  let clock = 0;
  let restoring: Promise<boolean> | undefined = undefined;
  let restored = persistence === undefined;
  /* Tabs closed while the stored sessions are read: the stored copy must not bring them back. */
  const removedBeforeRestore = new Set<number>();
  /* A write is owed; a burst of changes writes only the newest state. */
  let dirty = false;
  let writing = false;

  const snapshotSessions = (): PersistedTabGroupSession[] =>
    [...sessions.values()].map(session => {
      const stored: PersistedTabGroupSession = {
        ended: session.ended,
        sessionHandle: session.sessionHandle,
        tabs: [...session.tabs],
        title: session.title,
      };

      if (session.endedAt !== undefined) {
        stored.endedAt = session.endedAt;
      }

      if (session.groupId !== undefined) {
        stored.groupId = session.groupId;
      }

      return stored;
    });

  /** Only the newest ended sessions stay; adoption always takes the newest first. */
  const pruneEnded = (): void => {
    const ended = [...sessions.values()]
      .filter(session => session.ended)
      .toSorted((first, second) => (first.endedAt ?? 0) - (second.endedAt ?? 0));

    for (const session of ended.slice(0, Math.max(0, ended.length - ENDED_SESSION_LIMIT))) {
      sessions.delete(session.sessionHandle);
    }
  };

  const merge = (stored: readonly PersistedTabGroupSession[]): void => {
    for (const entry of stored) {
      // A session this worker already changed is newer than anything an earlier worker stored.
      if (!sessions.has(entry.sessionHandle)) {
        sessions.set(entry.sessionHandle, {
          ended: entry.ended,
          ...(entry.endedAt === undefined ? {} : { endedAt: entry.endedAt }),
          ...(entry.groupId === undefined ? {} : { groupId: entry.groupId }),
          sessionHandle: entry.sessionHandle,
          tabs: entry.tabs.filter(tabId => !removedBeforeRestore.has(tabId)),
          title: entry.title,
        });
        clock = Math.max(clock, entry.endedAt ?? 0);
      }
    }
  };

  const restore = (): Promise<boolean> => {
    if (persistence === undefined) {
      return Promise.resolve(true);
    }

    restoring ??= (async () => {
      try {
        merge((await persistence.read()) ?? []);
      } catch (error) {
        console.warn('Failed to read browser tab group sessions:', error);
        // Unread is not empty: forget this attempt so the next call reads again.
        restoring = undefined;
        return false;
      }

      restored = true;
      removedBeforeRestore.clear();

      // Changes made while the stored sessions were unreadable are written now.
      if (dirty) {
        persist();
      }

      return true;
    })();

    return restoring;
  };

  const drain = async (store: BrowserTabGroupPersistence): Promise<void> => {
    try {
      // The first write waits for the read: writing this worker's sessions first would erase the stored ones.
      // A failed read writes nothing; `dirty` stays set for the next attempt.
      if (!(await restore())) {
        return;
      }

      while (dirty) {
        dirty = false;

        try {
          // eslint-disable-next-line no-await-in-loop -- one write at a time, always the newest state
          await store.write(snapshotSessions());
        } catch (error) {
          console.warn('Failed to persist browser tab group sessions:', error);
        }
      }
    } finally {
      writing = false;
    }
  };

  const persist = (): void => {
    if (persistence === undefined) {
      return;
    }

    dirty = true;

    if (!writing) {
      writing = true;
      void drain(persistence);
    }
  };

  const attempt = async <Value>(run: () => MaybeAsync<Value>): Promise<Value | undefined> => {
    try {
      return await run();
    } catch (error) {
      console.warn('Browser tab group call failed:', error);
      return undefined;
    }
  };
  const ensureSession = (sessionHandle: string): SessionState => {
    const existing = sessions.get(sessionHandle);
    if (existing !== undefined) {
      return existing;
    }
    const created: SessionState = { ended: false, sessionHandle, tabs: [], title: sessionHandle };
    sessions.set(sessionHandle, created);
    persist();
    return created;
  };
  /** A tab sits in one group at a time: joining this session's group takes it out of every other session's record. */
  const recordTab = (session: SessionState, tabId: number): void => {
    for (const other of sessions.values()) {
      if (other !== session) {
        other.tabs = other.tabs.filter(id => id !== tabId);
      }
    }
    if (!session.tabs.includes(tabId)) {
      session.tabs.push(tabId);
      persist();
    }
  };
  const createGroup = async (tabIds: number[], groupId?: number): Promise<number | undefined> => {
    const { group } = api;
    if (group === undefined) {
      return undefined;
    }
    const parsed = tabGroupIdSchema.safeParse(
      await attempt(() => group(groupId === undefined ? { tabIds } : { groupId, tabIds }))
    );
    return parsed.success ? parsed.data : undefined;
  };
  const updateGroup = async (groupId: number, props: BrowserTabGroupUpdate): Promise<boolean> => {
    const { update } = api;
    if (update === undefined) {
      return false;
    }
    try {
      await update(groupId, props);
      return true;
    } catch (error) {
      console.warn('Browser tab group call failed:', error);
      return false;
    }
  };

  /**
   * The group a session's tabs are in right now. The recorded id is preferred,
   * but a group id can be missing (the first grouping never reported one) or
   * stale (Chrome recreated the group), and the tabs always know the truth.
   */
  const liveGroupId = async (session: SessionState): Promise<number | undefined> => {
    const { tabGroupOf } = api;
    if (session.groupId !== undefined || tabGroupOf === undefined) {
      return session.groupId;
    }
    for (const tabId of session.tabs) {
      // eslint-disable-next-line no-await-in-loop -- one tab lookup per tab, in order
      const groupId = await attempt(() => tabGroupOf(tabId));
      if (groupId !== undefined && groupId >= 0) {
        return groupId;
      }
    }
    return undefined;
  };
  const activeTabId = async (): Promise<number | undefined> => {
    const { tabQuery } = api;
    if (tabQuery === undefined) {
      return undefined;
    }
    const parsed = activeTabInfosSchema.safeParse(
      await attempt(() => tabQuery({ active: true, lastFocusedWindow: true }))
    );
    if (!parsed.success) {
      return undefined;
    }
    return parsed.data.find(tab => tab.active === true)?.id ?? parsed.data[0]?.id;
  };

  const openSession = (input: BrowserOpenSessionInput): Promise<BrowserTabGroupOpenResult> => {
    const session = ensureSession(input.sessionHandle);
    session.ended = false;
    delete session.endedAt;
    session.title = input.title;
    persist();
    // Chrome rejects an empty tabs.group, so the group is created with the first tab.
    return Promise.resolve(session.groupId === undefined ? {} : { groupId: session.groupId });
  };

  const closeSession = async ({ sessionHandle }: BrowserSessionRef): Promise<void> => {
    const session = sessions.get(sessionHandle);
    if (session === undefined) {
      return;
    }
    clock = now === undefined ? clock + 1 : Math.max(clock + 1, now());
    session.ended = true;
    session.endedAt = clock;
    pruneEnded();
    persist();
    const props = {
      collapsed: true,
      color: BROWSER_TAB_GROUP_COLOR,
      title: browserTabGroupEndedTitle(),
    } as const;
    const groupId = await liveGroupId(session);
    if (groupId === undefined) {
      return;
    }
    // The group outlives the session; its tab ids stay targetable only after adoption.
    session.groupId = groupId;
    persist();
    if (await updateGroup(groupId, props)) {
      return;
    }
    // A recorded id that no longer updates is stale: retry once with the group the tab is actually in.
    const recovered = await liveGroupId({ ...session, groupId: undefined });
    if (recovered !== undefined && recovered !== groupId) {
      session.groupId = recovered;
      persist();
      await updateGroup(recovered, props);
    }
  };

  /** Moves a tab into the session's group, creating and titling the group on first use. */
  const groupTab = async (session: SessionState, tabId: number): Promise<number | undefined> => {
    const groupId = await createGroup([tabId], session.groupId);

    if (groupId === undefined) {
      return session.groupId;
    }

    if (session.groupId === undefined) {
      session.groupId = groupId;
      persist();
      await updateGroup(groupId, {
        color: BROWSER_TAB_GROUP_COLOR,
        title: browserTabGroupTitle(session.title),
      });
    }

    return session.groupId;
  };

  /**
   * `/browser adopt`: the newest ended group becomes the calling session's group.
   * The ended handle is retired so the adopted tabs are the new session's reach
   * (D9), and a session that already owns tabs keeps them instead.
   */
  const adoptEnded = async ({
    sessionHandle,
  }: BrowserSessionRef): Promise<BrowserTabGroupAdoptResult> => {
    const ended = [...sessions.values()].filter(session => session.ended);
    const adopted = ended.reduce<SessionState | undefined>(
      (best, session) =>
        best === undefined || (session.endedAt ?? 0) > (best.endedAt ?? 0) ? session : best,
      ended[0]
    );
    const existing = sessions.get(sessionHandle);

    if (existing !== undefined && existing.tabs.length > 0) {
      return { kind: 'kept' };
    }
    if (adopted === undefined) {
      ensureSession(sessionHandle);
      return { kind: 'none' };
    }

    // The group outlives its session's handle: re-key it to the caller, or the caller could not reach a single tab in it.
    sessions.delete(adopted.sessionHandle);
    adopted.sessionHandle = sessionHandle;
    sessions.set(sessionHandle, adopted);
    adopted.ended = false;
    delete adopted.endedAt;
    persist();
    if (adopted.groupId === undefined) {
      return { kind: 'adopted' };
    }
    // `update` cannot clear a colour, so the collapsed state alone reports "live".
    await updateGroup(adopted.groupId, {
      collapsed: false,
      title: browserTabGroupTitle(adopted.title),
    });
    return { groupId: adopted.groupId, kind: 'adopted' };
  };

  const shareActiveTab = async (input: BrowserShareTabInput): Promise<BrowserShareTabResult> => {
    const session = sessions.get(input.sessionHandle);
    const resolved = input.tabId ?? (await activeTabId());
    if (resolved === undefined) {
      return { kind: 'no_tab' };
    }
    if (session === undefined) {
      return { kind: 'no_session' };
    }
    // `/browser share` names no tab: the user's active tab must not reach into another live session's group (D9).
    // A tab the runtime names itself (a session's new tab, a popup of its own tab) is the caller's already.
    const holder = input.tabId === undefined ? sessionForTab(resolved) : undefined;
    if (holder !== undefined && holder !== input.sessionHandle) {
      return { kind: 'held', tabId: resolved };
    }
    recordTab(session, resolved);
    if (api.group !== undefined) {
      await groupTab(session, resolved);
    }
    return session.groupId === undefined
      ? { kind: 'shared', tabId: resolved }
      : { groupId: session.groupId, kind: 'shared', tabId: resolved };
  };

  const tabsForSession = (sessionHandle: string): number[] => {
    const session = sessions.get(sessionHandle);
    // An ended session's tabs are not targetable until a new session adopts it.
    return session === undefined || session.ended ? [] : [...session.tabs];
  };
  const sessionForTab = (tabId: number): string | undefined =>
    [...sessions.values()].find(session => !session.ended && session.tabs.includes(tabId))
      ?.sessionHandle;
  const isTabAllowed = (sessionHandle: string, tabId: number): boolean =>
    tabsForSession(sessionHandle).includes(tabId);
  const listSessions = (): BrowserTabGroupSessionSummary[] => {
    const summaries: BrowserTabGroupSessionSummary[] = [];
    for (const session of sessions.values()) {
      summaries.push({
        ended: session.ended,
        ...(session.groupId === undefined ? {} : { groupId: session.groupId }),
        sessionHandle: session.sessionHandle,
        tabs: [...session.tabs],
        title: session.title,
      });
    }
    return summaries;
  };
  const noteTabRemoved = (tabId: number): void => {
    if (!restored) {
      removedBeforeRestore.add(tabId);
    }

    for (const session of sessions.values()) {
      if (session.tabs.includes(tabId)) {
        session.tabs = session.tabs.filter(id => id !== tabId);
        persist();
      }
    }
  };
  const noteTabAdded = (tabId: number, groupId?: number): void => {
    const session =
      groupId === undefined
        ? undefined
        : [...sessions.values()].find(
            candidate => !candidate.ended && candidate.groupId === groupId
          );
    // An ended session's group still exists, but it must not swallow new tabs.
    if (session !== undefined) {
      recordTab(session, tabId);
    }
  };

  // The read starts with the controller, so only tabs closed while it runs need remembering.
  void restore();

  return {
    adoptEnded,
    closeSession,
    isTabAllowed,
    listSessions,
    noteTabAdded,
    noteTabRemoved,
    openSession,
    restore,
    sessionForTab,
    shareActiveTab,
    tabsForSession,
  };
};
