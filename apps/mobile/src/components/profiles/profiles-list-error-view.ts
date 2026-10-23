// Pure error-view selector for the Manage Profiles list.
//
// The list reads `agentProfiles.listCombined` in an organization context, and
// that read can fail because the caller no longer has access to the stored
// organization (a membership removed elsewhere, a deleted organization). Those
// answers are terminal: the same request can never start succeeding, so the
// screen must name the state instead of reporting a server fault and offering a
// Retry that cannot work. A confirmed-offline device is a connectivity
// failure, not a server one, and stays retryable.
//
// The variant and retry decision reuse the shared tRPC helpers, so this screen
// and the organization Members list classify an error the same way.

import { type QueryErrorVariant } from '@/components/query-error';
import { type BannerState } from '@/lib/offline-banner-state';
import { isTerminalTrpcCode, readTrpcErrorField, trpcErrorVariant } from '@/lib/trpc-error';

export type ProfilesListErrorView = {
  variant: QueryErrorVariant;
  showRetry: boolean;
  /** The list's own load-failure title, or null to use the variant's copy. */
  titleKey: 'profiles.loadFailed' | null;
};

export function selectProfilesListErrorView({
  error,
  connectivity,
}: Readonly<{ error: unknown; connectivity: BannerState }>): ProfilesListErrorView {
  if (connectivity === 'offline') {
    // The list may recover as soon as the connection returns, and the error
    // body says nothing about the request itself.
    return { variant: 'offline', showRetry: true, titleKey: 'profiles.loadFailed' };
  }
  const code = readTrpcErrorField(error, 'code');
  const variant = trpcErrorVariant(code);
  return {
    variant,
    showRetry: !isTerminalTrpcCode(code),
    // A permission or not-found state has its own title and description; the
    // list's "couldn't load" title would describe the wrong cause.
    titleKey: variant === 'server' ? 'profiles.loadFailed' : null,
  };
}
