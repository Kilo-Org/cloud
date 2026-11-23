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
      const result = await writer.register(sessionID, sourceID, 'mobile');
      return result.type === 'registered'
        ? { type: 'registered', position: result.state.position }
        : result;
    },
    putBlob: (sessionID, bytes, mime) => writer.putBlob(sessionID, bytes, mime),
    commit: async (sessionID, packet) => {
      const result = await writer.commit(sessionID, packet);
      return result.type === 'committed'
        ? {
            type: 'committed',
            receipt: {
              through: result.receipt.through,
              batchID: result.receipt.batchID,
              digest: result.receipt.digest,
            },
          }
        : result;
    },
    pull: sessionID => writer.pull(sessionID),
  };
  const made: SyncClient = {
    transport,
    listSessions: params =>
      client.listSessions({ ...params, limit: 50, organizationID: organizationId }),
    deleteSession: async sessionID => {
      const result = await client.deleteSession(sessionID, organizationId);
      return result.type === 'retryable' ? { type: 'retryable' } : result;
    },
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
