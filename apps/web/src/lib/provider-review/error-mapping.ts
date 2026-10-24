/**
 * One classified provider refusal → the router's error state.
 *
 * Every provider surface (the mobile/web provider-review router, the Cloud
 * Agent branch listing, and the manual Code Reviewer job) answers the same
 * refusal class with the same code, so a client that handles one surface
 * handles them all. The provider message is fixed copy that never embeds a
 * token, an instance URL, or a workspace identity.
 */
import 'server-only';

import { TRPCError } from '@trpc/server';
import type { ProviderReviewError } from '@kilocode/app-shared/provider-review';

export function providerReviewErrorToTrpcError(error: ProviderReviewError): TRPCError {
  switch (error.kind) {
    case 'not_found':
      return new TRPCError({ code: 'NOT_FOUND', message: error.message, cause: error });
    case 'forbidden':
      return new TRPCError({ code: 'FORBIDDEN', message: error.message, cause: error });
    case 'reconnect':
      // The provider connection must be re-established; the caller's Kilo
      // access is not the problem. This is the mobile reconnect state.
      return new TRPCError({ code: 'PRECONDITION_FAILED', message: error.message, cause: error });
    case 'stale_head':
      return new TRPCError({ code: 'CONFLICT', message: error.message, cause: error });
    case 'bad_request':
      return new TRPCError({ code: 'BAD_REQUEST', message: error.message, cause: error });
    case 'retryable':
      // A provider-side or network failure to retry, never a 500.
      return new TRPCError({ code: 'BAD_GATEWAY', message: error.message, cause: error });
  }
}
