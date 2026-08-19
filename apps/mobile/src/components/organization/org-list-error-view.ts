// Pure error-view selector for the organization Members list.
//
// Unlike the PR Review classifier, this does NOT treat PRECONDITION_FAILED as
// a reconnect state: an org list has no connect gate. The variant comes from
// the tRPC code, and the retry decision is `!isTerminalTrpcCode(code)` — which
// also covers BAD_REQUEST and UNPROCESSABLE_CONTENT, so a Retry is never
// offered on a permanent error.

import { isTerminalTrpcCode, readTrpcErrorField } from '@/lib/trpc-error';

export type OrgListErrorView = {
  variant: 'permission' | 'not-found' | 'server';
  showRetry: boolean;
};

export function selectOrgListErrorView(error: unknown): OrgListErrorView {
  const code = readTrpcErrorField(error, 'code');

  let variant: 'permission' | 'not-found' | 'server' = 'server';
  if (code === 'FORBIDDEN' || code === 'UNAUTHORIZED') {
    variant = 'permission';
  } else if (code === 'NOT_FOUND') {
    variant = 'not-found';
  }

  return { variant, showRetry: !isTerminalTrpcCode(code) };
}
