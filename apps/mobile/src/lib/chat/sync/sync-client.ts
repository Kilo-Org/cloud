import {
  NativeSyncClient,
  NativeSyncWriter,
  type ListedSession,
} from '@kilocode/cloud-agent-sdk';

import { SESSION_SYNC_URL } from '@/lib/config';
import { getAuthenticatedOwner } from '@/lib/context-scope';
import { nativeRemoteCredential } from '@/lib/native-remote-credential';

import type { SyncTransport } from './sync-engine';

/**
 * The production transport: the SDK writer over the session-sync service,
 * credentialed the way the native-remote screen is. One client per auth
 * epoch and organization, so a sign-out can never write under the previous
 * account's grant.
 */

export type SyncClient = {
  readonly transport: SyncTransport;
  readonly listSessions: (params: {
    readonly cursor?: string;
    readonly q?: string;
    readonly client?: 'cli' | 'mobile' | 'cloud-agent';
    readonly archived?: boolean;
  }) => Promise<{ readonly items: ListedSession[]; readonly cursor: string | null }>;
  readonly deleteSession: (
    sessionID: string
  ) => Promise<
    | { readonly type: 'deleted' }
    | { readonly type: 'not_found' }
    | { readonly type: 'retryable' }
    | { readonly type: 'failed'; readonly code: string }
  >;
  /** Answers whether a runner is live on the session right now (H6). */
  readonly probeLive: (sessionID: string) => Promise<boolean>;
  /** Sends one message to the live runner; false when no runner took it. */
  readonly sendLiveMessage: (sessionID: string, text: string) => Promise<boolean>;
};

const clients = new Map<string, SyncClient>();

/**
 * Runs one SDK call, answering the thrown error instead of raising it. Every
 * thrown answer — the network, a 5xx, 429, a 404 route, a body that no
 * longer parses against an older service — becomes retryable.
 */
async function pausedOnOutage<T>(call: () => Promise<T>): Promise<T | Error> {
  try {
    return await call();
  } catch (error) {
    return error instanceof Error ? error : new Error('sync unavailable');
  }
}

/**
 * Maps any service refusal onto the paused state. A refusal here means the
 * deployment or this session cannot take the write yet (an older service
 * with no join support, a session another writer created, a route it does
 * not serve), never that the person's chat is broken: sync parks and the
 * next attempt tries again.
 */
function pausedWhenUnavailable<T extends { readonly type: string }>(
  result: T | Error
): T | { readonly type: 'retryable' } {
  if (result instanceof Error || result.type === 'failed') {
    return { type: 'retryable' };
  }
  return result;
}

export function syncClientFor(organizationId: string | undefined): SyncClient {
  const epoch = getAuthenticatedOwner().authEpoch;
  const key = `${epoch}:${organizationId ?? 'personal'}`;
  const held = clients.get(key);
  if (held !== undefined) {
    return held;
  }
  const client = new NativeSyncClient({
    baseUrl: SESSION_SYNC_URL,
    getCredential: () => nativeRemoteCredential(epoch),
  });
  const writer = new NativeSyncWriter(client, organizationId);
  const transport: SyncTransport = {
    register: async (sessionID, sourceID) => {
      const result = await pausedOnOutage(() => writer.register(sessionID, sourceID, 'mobile'));
      return result.type === 'registered'
        ? { type: 'registered', position: result.state.position }
        : pausedWhenUnavailable(result);
    },
    putBlob: async (sessionID, bytes, mime) => {
      const result = await pausedOnOutage(() => writer.putBlob(sessionID, bytes, mime));
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
    commit: async (sessionID, packet) => {
      const result = await pausedOnOutage(() => writer.commit(sessionID, packet));
      if (result.type === 'committed') {
        return {
          type: 'committed',
          receipt: {
            through: result.receipt.through,
            batchID: result.receipt.batchID,
            digest: result.receipt.digest,
          },
        };
      }
      return pausedWhenUnavailable(result);
    },
    pull: async sessionID => pausedWhenUnavailable(await pausedOnOutage(() => writer.pull(sessionID))),
  };
  const made: SyncClient = {
    transport,
    listSessions: async params => {
      const result = await pausedOnOutage(() =>
        client.listSessions({ ...params, limit: 50, organizationID: organizationId })
      );
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
    deleteSession: async sessionID =>
      pausedWhenUnavailable(
        await pausedOnOutage(() => client.deleteSession(sessionID, organizationId))
      ),
    probeLive: sessionID =>
      new Promise<boolean>(resolve => {
        const timer = setTimeout(() => {
          connection.close();
          resolve(false);
        }, 3000);
        const connection = client.connectSession(
          sessionID,
          state => {
            if (state.connection === 'connected') {
              clearTimeout(timer);
              connection.close();
              resolve(state.runnerConnected);
            }
          },
          organizationId
        );
      }),
    sendLiveMessage: (sessionID, text) =>
      new Promise<boolean>(resolve => {
        const timer = setTimeout(() => {
          connection.close();
          resolve(false);
        }, 5000);
        const connection = client.connectSession(
          sessionID,
          state => {
            if (state.connection === 'connected' && state.runnerConnected) {
              clearTimeout(timer);
              void (async () => {
                try {
                  await connection.sendMessage(text);
                  resolve(true);
                } catch {
                  resolve(false);
                } finally {
                  connection.close();
                }
              })();
            } else if (state.connection === 'connected') {
              clearTimeout(timer);
              connection.close();
              resolve(false);
            }
          },
          organizationId
        );
      }),
  };
  clients.set(key, made);
  return made;
}

/** Drops every cached client, which signing out does beside its other teardown. */
export function forgetSyncClients(): void {
  clients.clear();
}
