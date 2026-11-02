import { type QueryErrorVariant } from '@/components/query-error';
import {
  isPermissionDeniedError,
  isTerminalTrpcCode,
  readTrpcErrorField,
  trpcErrorVariant,
} from '@/lib/trpc-error';

/** How the Overview presents a failed profile read. */
export type ProfileOverviewErrorView = {
  variant: QueryErrorVariant;
  /** Offer Retry only when asking the server again can plausibly succeed. */
  showRetry: boolean;
  /**
   * The server no longer serves this profile, so the Profiles list row that
   * led here is stale. The list is refreshed so the dead row leaves it.
   */
  staleRow: boolean;
};

type Connectivity = 'offline' | 'online' | 'unknown';

/**
 * Classify a failed `agentProfiles.get`. The error code wins over connectivity:
 * a request the server answered (NOT_FOUND, a denied permission) cannot be
 * fixed by retrying, however the device reports its network. Only an error
 * without a code — an aborted or refused request — is judged by connectivity,
 * where a confirmed-offline device gets the connectivity copy and everything
 * else the generic server variant, both with Retry.
 */
export function selectProfileOverviewErrorView(
  error: unknown,
  connectivity: Connectivity
): ProfileOverviewErrorView {
  const code = readTrpcErrorField(error, 'code');
  if (code === 'NOT_FOUND') {
    return { variant: 'not-found', showRetry: false, staleRow: true };
  }
  if (isPermissionDeniedError(error)) {
    return { variant: 'permission', showRetry: false, staleRow: false };
  }
  if (isTerminalTrpcCode(code)) {
    // Any other terminal refusal (a malformed id in a deep link, an
    // unprocessable read) means the same thing to the reader: this profile
    // cannot be opened. The not-found copy states that without the server
    // variant's "please try again", which no control offers.
    return { variant: 'not-found', showRetry: false, staleRow: false };
  }
  return {
    variant: connectivity === 'offline' ? 'offline' : trpcErrorVariant(error),
    showRetry: true,
    staleRow: false,
  };
}
