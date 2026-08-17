import { type PersistedClient } from '@tanstack/react-query-persist-client';

import { SCHEMA_VERSION } from '@/lib/persist/read-cache';

/**
 * Shared read-cache test fixtures. Lives next to the modules under test so the
 * persister suite and the mount suite build the same persisted-client shape.
 */

/** The exact tRPC query key the authoritative user id is read from. */
export const GET_ME_QUERY_KEY: readonly unknown[] = [['user', 'getMe'], { type: 'query' }];

/** A recent, un-busted persisted client carrying one successful getMe query. */
export function makePersistedClient(
  data: unknown,
  buster = String(SCHEMA_VERSION)
): PersistedClient {
  return {
    timestamp: Date.now(),
    buster,
    clientState: {
      mutations: [],
      queries: [
        {
          queryKey: GET_ME_QUERY_KEY,
          state: { status: 'success', data, dataUpdatedAt: Date.now() },
        },
      ],
    },
  } as unknown as PersistedClient;
}
