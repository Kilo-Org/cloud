import { type QueryErrorVariant } from '@/components/query-error';
import { selectProfileReadErrorView } from '@/components/profiles/profile-read-error-view';
import { isTrpcClientError, readTrpcErrorField } from '@/lib/trpc-error';

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
  /** Replaces the variant's own description, or null. */
  descriptionKey: 'organization.boundary.accessDeniedDescription' | null;
};

type Connectivity = 'offline' | 'online' | 'unknown';

/**
 * Classify a failed `agentProfiles.get`. The precedence lives in the shared
 * section selector ({@link selectProfileReadErrorView}) so the Overview and the
 * profile-editor section reads cannot disagree: a coded verdict wins over
 * connectivity, and only an error without a tRPC envelope is judged by
 * connectivity. This function adds the Overview's own extra: a stale-row flag,
 * which only the Profiles list row that led here can carry.
 */
export function selectProfileOverviewErrorView(
  error: unknown,
  connectivity: Connectivity
): ProfileOverviewErrorView {
  const read = selectProfileReadErrorView({
    error,
    connectivity,
    loadFailedTitleKey: 'profiles.loadFailed',
  });
  return {
    // Only the fields the Overview renders: the load-failure title is decided
    // by the screen itself, so the selector's `titleKey` is not carried here.
    variant: read.variant,
    showRetry: read.showRetry,
    descriptionKey: read.descriptionKey,
    staleRow: isTrpcClientError(error) && readTrpcErrorField(error, 'code') === 'NOT_FOUND',
  };
}
