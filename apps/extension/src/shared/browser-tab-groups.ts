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
export interface BrowserShareTabResult {
  readonly groupId?: number | undefined;
  readonly tabId: number;
}

export interface BrowserTabGroupController {
  readonly adoptEnded: (input: BrowserSessionRef) => Promise<BrowserTabGroupOpenResult>;
  readonly closeSession: (input: BrowserSessionRef) => Promise<void>;
  readonly isTabAllowed: (sessionHandle: string, tabId: number) => boolean;
  readonly listSessions: () => BrowserTabGroupSessionSummary[];
  readonly noteTabAdded: (tabId: number, groupId?: number) => void;
  readonly noteTabRemoved: (tabId: number) => void;
  readonly openSession: (input: BrowserOpenSessionInput) => Promise<BrowserTabGroupOpenResult>;
  readonly sessionForTab: (tabId: number) => string | undefined;
  readonly shareActiveTab: (input: BrowserShareTabInput) => Promise<BrowserShareTabResult>;
  readonly tabsForSession: (sessionHandle: string) => number[];
}

const tabGroupIdSchema = z.number().int().nonnegative();
const activeTabInfosSchema = z.array(
  z.object({ active: z.boolean().optional(), id: z.number().optional() })
);

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
}: {
  readonly api: BrowserTabGroupsApi;
  readonly now?: (() => number) | undefined;
}): BrowserTabGroupController => {
  const sessions = new Map<string, SessionState>();
  let clock = 0;

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
    return created;
  };
  const recordTab = (session: SessionState, tabId: number): void => {
    if (!session.tabs.includes(tabId)) {
      session.tabs.push(tabId);
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
  const updateGroup = async (groupId: number, props: BrowserTabGroupUpdate): Promise<void> => {
    const { update } = api;
    if (update !== undefined) {
      await attempt(() => update(groupId, props));
    }
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
    if (session.groupId !== undefined) {
      // The group outlives the session; its tab ids stay targetable only after adoption.
      await updateGroup(session.groupId, {
        collapsed: true,
        color: BROWSER_TAB_GROUP_COLOR,
        title: browserTabGroupEndedTitle(),
      });
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
      await updateGroup(groupId, {
        color: BROWSER_TAB_GROUP_COLOR,
        title: browserTabGroupTitle(session.title),
      });
    }

    return session.groupId;
  };

  const adoptEnded = async ({
    sessionHandle,
  }: BrowserSessionRef): Promise<BrowserTabGroupOpenResult> => {
    const ended = [...sessions.values()].filter(session => session.ended);
    const adopted = ended.reduce<SessionState | undefined>(
      (best, session) =>
        best === undefined || (session.endedAt ?? 0) > (best.endedAt ?? 0) ? session : best,
      ended[0]
    );
    if (adopted === undefined) {
      ensureSession(sessionHandle);
      return {};
    }
    adopted.ended = false;
    delete adopted.endedAt;
    if (adopted.groupId === undefined) {
      return {};
    }
    // `update` cannot clear a colour, so the collapsed state alone reports "live".
    await updateGroup(adopted.groupId, {
      collapsed: false,
      title: browserTabGroupTitle(adopted.title),
    });
    return { groupId: adopted.groupId };
  };

  const shareActiveTab = async (input: BrowserShareTabInput): Promise<BrowserShareTabResult> => {
    const session = sessions.get(input.sessionHandle);
    const resolved = input.tabId ?? (await activeTabId());
    // 0 is not a tab id: no tab was known, so nothing was grouped or recorded.
    if (resolved === undefined) {
      return session?.groupId === undefined ? { tabId: 0 } : { groupId: session.groupId, tabId: 0 };
    }
    if (session === undefined) {
      return { tabId: resolved };
    }
    recordTab(session, resolved);
    if (api.group !== undefined) {
      await groupTab(session, resolved);
    }
    return session.groupId === undefined
      ? { tabId: resolved }
      : { groupId: session.groupId, tabId: resolved };
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
    for (const session of sessions.values()) {
      session.tabs = session.tabs.filter(id => id !== tabId);
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

  return {
    adoptEnded,
    closeSession,
    isTabAllowed,
    listSessions,
    noteTabAdded,
    noteTabRemoved,
    openSession,
    sessionForTab,
    shareActiveTab,
    tabsForSession,
  };
};
