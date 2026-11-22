// Pure error-view selector for every organization-scoped profile read: the
// Manage Profiles list and the profile-editor section reads (skills, variables,
// repo bindings, agents, commands, instructions, kilo commands and MCP).
//
// Each of those reads answers for an organization context, and each can fail
// because the caller no longer has access to the stored organization (a
// membership removed elsewhere, a deleted organization). Those answers are
// terminal: the same request can never start succeeding, so the screen must
// name the state instead of reporting a server fault and offering a Retry that
// cannot work. A terminal refusal that is not an access outcome reads as
// unavailable, because the not-found copy says so and the server copy would ask
// for a retry no control offers. A confirmed-offline device is a connectivity
// failure, not a server one, and stays retryable.
//
// The variant and retry decision reuse the shared tRPC helpers, so these reads
// and the organization Members list classify an error the same way.

import { type QueryErrorVariant } from '@/components/query-error';
import { type BannerState } from '@/lib/offline-banner-state';
import {
  isTerminalTrpcCode,
  isTrpcClientError,
  readTrpcErrorField,
  trpcErrorVariant,
} from '@/lib/trpc-error';

export type ProfileReadErrorView = {
  variant: QueryErrorVariant;
  showRetry: boolean;
  /** The read's own load-failure title, or null to use the variant's copy. */
  titleKey: 'profiles.loadFailed' | null;
};

export function selectProfileReadErrorView({
  error,
  connectivity,
}: Readonly<{ error: unknown; connectivity: BannerState }>): ProfileReadErrorView {
  if (connectivity === 'offline') {
    // The read may recover as soon as the connection returns, and the error
    // body says nothing about the request itself.
    return { variant: 'offline', showRetry: true, titleKey: 'profiles.loadFailed' };
  }
  const code = readTrpcErrorField(error, 'code');
  // Only a tRPC client error carries a server verdict: a non-tRPC error whose
  // bare top-level `code` happens to look terminal (a domain or transport code)
  // never proved the request itself is doomed, so it stays retryable.
  const terminal = isTrpcClientError(error) && isTerminalTrpcCode(code);
  const reported = trpcErrorVariant(error);
  // A terminal refusal that is not an access outcome (a malformed id in a deep
  // link, an unprocessable read) means this profile cannot be opened. The
  // not-found copy states that; the server copy would ask for a retry no
  // control offers.
  const variant = terminal && reported === 'server' ? 'not-found' : reported;
  return {
    variant,
    showRetry: !terminal,
    // A permission or not-found state has its own title and description; the
    // read's "couldn't load" title would describe the wrong cause.
    titleKey: variant === 'server' ? 'profiles.loadFailed' : null,
  };
}
