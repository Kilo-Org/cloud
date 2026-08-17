import { type PersistedClient } from '@tanstack/react-query-persist-client';

/**
 * Shared read-cache test fixtures. Lives next to the modules under test so the
 * persister suite and the mount suite build the same persisted-client shape.
 */

/** The exact tRPC query key the authoritative user id is read from. */
export const GET_ME_QUERY_KEY: readonly unknown[] = [['user', 'getMe'], { type: 'query' }];

/**
 * A recent, un-busted persisted client carrying one successful getMe query.
 * The read cache passes no `buster`, so the library's empty default is the
 * un-busted value.
 */
export function makePersistedClient(data: unknown, buster = ''): PersistedClient {
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
