/**
 * In-memory `SESSION_INGEST` double for the Workers-runtime integration suite.
 *
 * `wrangler.test.jsonc` deliberately binds no `SESSION_INGEST` service and no
 * Postgres database, so the real `/kilo` persisted-read and session-resolution
 * paths are unreachable there. This double keeps those paths exercisable by
 * reading its state from the facade Durable Object's own storage, which the
 * test controls through `runInDurableObject`. It models only the four methods
 * the facade calls; every other contract method fails loudly so a test cannot
 * silently depend on behavior this double does not define.
 */
import {
  decodeCloudAgentRootSessionsCursor,
  encodeCloudAgentRootSessionsCursor,
} from '@kilocode/session-ingest-contracts';
import type {
  CloudAgentRootSessionSummary,
  CloudAgentRootSessionsPage,
  GetCloudAgentRootSessionMessagesParams,
  GetCloudAgentRootSessionMessagesResult,
  GetCloudAgentRootSessionSnapshotParams,
  GetCloudAgentRootSessionSnapshotResult,
  KiloSdkSessionInfo,
  KiloSdkStoredMessage,
  ListCloudAgentRootSessionsParams,
  ResolveCloudAgentRootSessionForKiloSessionParams,
  ResolveCloudAgentRootSessionForKiloSessionResult,
  SessionIngestBinding,
  SessionIngestRpcMethods,
} from '../../../src/session-ingest-binding.js';

export const TEST_SESSION_INGEST_ROOTS_KEY = 'test:session-ingest:roots';
export const TEST_SESSION_INGEST_MESSAGES_KEY = 'test:session-ingest:messages';
export const TEST_SESSION_INGEST_SNAPSHOTS_KEY = 'test:session-ingest:snapshots';

export type TestSessionIngestRoot = {
  kiloSessionId: string;
  cloudAgentSessionId: string;
  title?: string | null;
  created?: number;
  updated?: number;
  organizationId?: string | null;
  gitUrl?: string | null;
  gitBranch?: string | null;
  profileId?: string | null;
  createdOnPlatform?: string;
};

export type TestSessionIngestState = {
  roots?: readonly TestSessionIngestRoot[];
  messages?: Readonly<Record<string, readonly KiloSdkStoredMessage[]>>;
  snapshots?: Readonly<Record<string, KiloSdkSessionInfo>>;
};

type StorageLike = Pick<DurableObjectStorage, 'get' | 'put' | 'delete'>;

const UNSUPPORTED_METHOD = 'SESSION_INGEST method is not modeled by the integration test double';

function summary(root: TestSessionIngestRoot): CloudAgentRootSessionSummary {
  const created = root.created ?? 1_700_000_000_000;
  return {
    kiloSessionId: root.kiloSessionId,
    cloudAgentSessionId: root.cloudAgentSessionId,
    userId: 'test_user',
    organizationId: root.organizationId ?? null,
    title: root.title ?? null,
    gitUrl: root.gitUrl ?? null,
    gitBranch: root.gitBranch ?? null,
    profileId: root.profileId ?? null,
    createdOnPlatform: root.createdOnPlatform ?? 'cloud-agent',
    created,
    updated: root.updated ?? created,
  };
}

async function readRoots(storage: StorageLike): Promise<TestSessionIngestRoot[]> {
  return (await storage.get<TestSessionIngestRoot[]>(TEST_SESSION_INGEST_ROOTS_KEY)) ?? [];
}

/**
 * Installs or replaces the double's state. Call inside `runInDurableObject` so
 * the write lands on the same storage the facade Durable Object reads.
 */
export async function writeTestSessionIngestState(
  storage: StorageLike,
  state: TestSessionIngestState
): Promise<void> {
  if (state.roots !== undefined) {
    await storage.put(TEST_SESSION_INGEST_ROOTS_KEY, [...state.roots]);
  }
  if (state.messages !== undefined)
    await storage.put(TEST_SESSION_INGEST_MESSAGES_KEY, state.messages);
  if (state.snapshots !== undefined) {
    await storage.put(TEST_SESSION_INGEST_SNAPSHOTS_KEY, state.snapshots);
  }
}

export async function clearTestSessionIngestState(storage: StorageLike): Promise<void> {
  await storage.delete([
    TEST_SESSION_INGEST_ROOTS_KEY,
    TEST_SESSION_INGEST_MESSAGES_KEY,
    TEST_SESSION_INGEST_SNAPSHOTS_KEY,
  ]);
}

function pageRoots(
  roots: readonly TestSessionIngestRoot[],
  params: ListCloudAgentRootSessionsParams
): CloudAgentRootSessionsPage {
  const limit = params.limit ?? 100;
  const sorted = [...roots]
    .map(summary)
    .sort(
      (left, right) =>
        right.updated - left.updated || right.kiloSessionId.localeCompare(left.kiloSessionId)
    )
    .filter(item => params.start === undefined || item.updated >= params.start);
  const cursor =
    params.cursor === undefined ? null : decodeCloudAgentRootSessionsCursor(params.cursor);
  const cursorUpdated = cursor === null ? 0 : new Date(cursor.updatedAt).getTime();
  const remaining =
    cursor === null
      ? sorted
      : sorted.filter(
          item =>
            item.updated < cursorUpdated ||
            (item.updated === cursorUpdated && item.kiloSessionId < cursor.sessionId)
        );
  const items = remaining.slice(0, limit);
  if (remaining.length <= limit) return { items, nextCursor: null };
  const last = items[items.length - 1];
  return {
    items,
    nextCursor:
      last === undefined
        ? null
        : encodeCloudAgentRootSessionsCursor({
            updatedAt: new Date(last.updated).toISOString(),
            sessionId: last.kiloSessionId,
          }),
  };
}

export function createTestSessionIngestDouble(storage: StorageLike): SessionIngestBinding {
  const methods: SessionIngestRpcMethods = {
    async resolveCloudAgentRootSessionForKiloSession(
      params: ResolveCloudAgentRootSessionForKiloSessionParams
    ): Promise<ResolveCloudAgentRootSessionForKiloSessionResult> {
      const roots = await readRoots(storage);
      const match = roots.find(root => root.kiloSessionId === params.kiloSessionId);
      return match ? { cloudAgentSessionId: match.cloudAgentSessionId } : null;
    },
    async listCloudAgentRootSessions(
      params: ListCloudAgentRootSessionsParams
    ): Promise<CloudAgentRootSessionsPage> {
      return pageRoots(await readRoots(storage), params);
    },
    async getCloudAgentRootSessionSnapshot(
      params: GetCloudAgentRootSessionSnapshotParams
    ): Promise<GetCloudAgentRootSessionSnapshotResult> {
      const roots = await readRoots(storage);
      const root = roots.find(candidate => candidate.kiloSessionId === params.kiloSessionId);
      if (!root) return null;
      const snapshots =
        (await storage.get<Record<string, KiloSdkSessionInfo>>(
          TEST_SESSION_INGEST_SNAPSHOTS_KEY
        )) ?? {};
      const info = snapshots[params.kiloSessionId];
      if (!info)
        return {
          kiloSessionId: root.kiloSessionId,
          cloudAgentSessionId: root.cloudAgentSessionId,
          snapshot: { kind: 'pending' },
        };
      return {
        kiloSessionId: root.kiloSessionId,
        cloudAgentSessionId: root.cloudAgentSessionId,
        snapshot: { kind: 'value', info, byteLength: JSON.stringify(info).length },
      };
    },
    async getCloudAgentRootSessionMessages(
      params: GetCloudAgentRootSessionMessagesParams
    ): Promise<GetCloudAgentRootSessionMessagesResult> {
      const roots = await readRoots(storage);
      const root = roots.find(candidate => candidate.kiloSessionId === params.kiloSessionId);
      if (!root) return null;
      const messages =
        (await storage.get<Record<string, KiloSdkStoredMessage[]>>(
          TEST_SESSION_INGEST_MESSAGES_KEY
        )) ?? {};
      return {
        kiloSessionId: root.kiloSessionId,
        cloudAgentSessionId: root.cloudAgentSessionId,
        history: {
          messages: messages[params.kiloSessionId] ?? [],
          nextCursor: null,
          omittedItemCount: 0,
        },
      };
    },
    async beginCloudAgentWorktreeDeletion(): Promise<never> {
      throw new Error(UNSUPPORTED_METHOD);
    },
    async retireCloudAgentWorktreeIfSoleMember(): Promise<never> {
      throw new Error(UNSUPPORTED_METHOD);
    },
    async recordCloudAgentWorktreeCleanup(): Promise<never> {
      throw new Error(UNSUPPORTED_METHOD);
    },
    async completeCloudAgentWorktreeDeletion(): Promise<never> {
      throw new Error(UNSUPPORTED_METHOD);
    },
    async canDestroyCloudAgentWorktreeSandbox(): Promise<never> {
      throw new Error(UNSUPPORTED_METHOD);
    },
    async createSessionForCloudAgent(): Promise<never> {
      throw new Error(UNSUPPORTED_METHOD);
    },
    async deleteSessionForCloudAgent(): Promise<never> {
      throw new Error(UNSUPPORTED_METHOD);
    },
    async getSessionMessages(): Promise<never> {
      throw new Error(UNSUPPORTED_METHOD);
    },
  };

  return {
    fetch: () => Promise.resolve(new Response('', { status: 501 })),
    connect: () => {
      throw new Error('connect is not implemented on the test SESSION_INGEST double');
    },
    ...methods,
  } as SessionIngestBinding;
}
