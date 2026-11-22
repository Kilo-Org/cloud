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
// for a retry no control offers.
//
// The precedence is fixed, in this order:
//
// 1. A terminal coded tRPC verdict wins. The server answered and no retry can
//    change the answer, so the state and the absence of Retry follow the code
//    however the device reports its network.
// 2. A confirmed-offline device is then a connectivity failure, not a server
//    one, and stays retryable. A coded refusal that is not terminal (a server
//    fault, a deadline) still yields to it here: the device cannot reach the
//    server now, and the answer may differ once it can.
// 3. Everything else is the variant the shared helpers report, retryable.
//
// The variant and retry decision reuse the shared tRPC helpers, so these reads
// and the organization Members list classify an error the same way.

import { type QueryErrorVariant } from '@/components/query-error';
import { type BannerState } from '@/lib/offline-banner-state';
import {
  isPermissionDeniedError,
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
  /** Replaces the variant's own description, or null. */
  descriptionKey: 'organization.boundary.accessDeniedDescription' | null;
};

export function selectProfileReadErrorView({
  error,
  connectivity,
}: Readonly<{ error: unknown; connectivity: BannerState }>): ProfileReadErrorView {
  const envelope = isTrpcClientError(error);
  const code = envelope ? readTrpcErrorField(error, 'code') : undefined;
  // A coded verdict comes first: the server answered, so Retry cannot change
  // the answer, and the answer is not a connectivity problem however the device
  // reports its network.
  if (isTerminalTrpcCode(code)) {
    if (isPermissionDeniedError(error)) {
      // The permission title already says access was denied, so the variant's
      // own description would repeat it. The added line names who can act.
      return {
        variant: 'permission',
        showRetry: false,
        titleKey: null,
        descriptionKey: 'organization.boundary.accessDeniedDescription',
      };
    }
    // A terminal refusal that is not an access outcome (a malformed id in a deep
    // link, an unprocessable read) means this profile cannot be opened. The
    // not-found copy states that; the server copy would ask for a retry no
    // control offers.
    return { variant: 'not-found', showRetry: false, titleKey: null, descriptionKey: null };
  }
  // A refusal that is not terminal is judged by connectivity: the server may
  // answer differently once the device can reach it, and a confirmed-offline
  // device is the honest cause until then. So is an error with no envelope at
  // all, whose body says nothing about the request itself.
  if (connectivity === 'offline') {
    return {
      variant: 'offline',
      showRetry: true,
      titleKey: 'profiles.loadFailed',
      descriptionKey: null,
    };
  }
  // Only a tRPC client error carries a server verdict: a non-tRPC error whose
  // bare top-level `code` happens to look terminal or access-like (a domain or
  // transport code) proved nothing about the request, so it stays retryable and
  // keeps the neutral copy. A client deadline is the one non-envelope failure
  // with its own reading, and it stays retryable too.
  const reported = trpcErrorVariant(error);
  const answered = envelope || reported === 'timeout' ? reported : 'server';
  return {
    variant: answered,
    showRetry: true,
    // A permission or not-found state has its own title and description; the
    // read's "couldn't load" title would describe the wrong cause. A slow
    // response keeps the variant's own copy.
    titleKey: answered === 'server' ? 'profiles.loadFailed' : null,
    descriptionKey: null,
  };
}
