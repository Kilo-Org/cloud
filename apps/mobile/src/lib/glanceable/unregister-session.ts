import { getAuthTokenForRequest } from '@/lib/auth/token-owner';
import { isUnauthorizedTrpcError } from '@/lib/auth/trpc-unauthorized';
import { trpcClient } from '@/lib/trpc';

/**
 * Session gate for activity-token deletes. The server deletes a row only for
 * the authenticated owner, so a delete without a session (signed out, or the
 * sign-in teardown window) or with a token the server already refused can only
 * answer 401. The caller keeps its tokens for the next authorized cleanup
 * instead of sending a call that cannot succeed.
 */

// The access token the server refused (context-level 401) for a delete. A
// refresh or a sign-in publishes a different token, which lifts the block.
let refusedToken: string | null = null;

/** The token a delete would send now, or null when the delete cannot authorize. */
export async function readUnregisterAuthToken(): Promise<string | null> {
  try {
    const token = await getAuthTokenForRequest();
    return token === refusedToken ? null : token;
  } catch {
    // A locked keychain cannot supply the token now; a later cleanup retries.
    return null;
  }
}

/** Blocks further deletes with `token` when the server refused its session. */
function noteUnregisterFailure(token: string, error: unknown): void {
  if (isUnauthorizedTrpcError(error)) {
    refusedToken = token;
  }
}

export function _resetUnregisterSessionForTests(): void {
  refusedToken = null;
}

/** Every token in the given record sets, once, in first-seen order. */
export function unionTokens(records: readonly Set<string>[]): string[] {
  const merged = new Set<string>();
  for (const record of records) {
    for (const token of record) {
      merged.add(token);
    }
  }
  return [...merged];
}

/**
 * Delete each token for the authenticated owner and drop every deleted token
 * from the given record sets. Returns the tokens whose delete failed, so the
 * caller keeps them for a later cleanup.
 */
// eslint-disable-next-line max-params -- the token, the session gate, and the record sets a delete reconciles
export async function deleteActivityTokens(
  tokens: readonly string[],
  authToken: string,
  records: readonly Set<string>[],
  sessionId?: string
): Promise<string[]> {
  const results = await Promise.all(
    tokens.map(async token => {
      try {
        await trpcClient.user.unregisterActivityToken.mutate({ token, sessionId });
        for (const record of records) {
          record.delete(token);
        }
        return true;
      } catch (error) {
        noteUnregisterFailure(authToken, error);
        return false;
      }
    })
  );
  return tokens.filter((_token, index) => !results[index]);
}
