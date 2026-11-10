// Pure error-view selector for the organization Members list.
//
// Unlike the PR Review classifier, this does NOT treat PRECONDITION_FAILED as
// a reconnect state: an org list has no connect gate. The variant comes from
// the tRPC code, and the retry decision is `!isTerminalTrpcCode(code)` — which
// also covers BAD_REQUEST and UNPROCESSABLE_CONTENT, so a Retry is never
// offered on a permanent error.

import { type QueryErrorVariant } from '@/components/query-error';
import { isTerminalTrpcCode, readTrpcErrorField, trpcErrorVariant } from '@/lib/trpc-error';

export type OrgListErrorView = {
  variant: QueryErrorVariant;
  showRetry: boolean;
};

export function selectOrgListErrorView(error: unknown): OrgListErrorView {
  const code = readTrpcErrorField(error, 'code');
  return { variant: trpcErrorVariant(error), showRetry: !isTerminalTrpcCode(code) };
}
