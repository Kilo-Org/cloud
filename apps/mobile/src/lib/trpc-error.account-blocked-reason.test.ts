import { describe, expect, it } from 'vitest';

import { isAccountBlockedTrpcError, readAccountBlockedReason } from '@/lib/trpc-error';

// The blocked-account reason reader: the wire field is the only thing that
// tells the two refusals apart, so its presence, absence and unknown values all
// need their own case. `isAccountBlockedTrpcError` (the presence check) lives in
// `trpc-error.test.ts`; the last case here joins the two, because a newer
// server's unknown reason must not turn a blocked refusal into an unexplained
// error on an older build.

describe('readAccountBlockedReason', () => {
  it('reads the account refusal off a direct envelope', () => {
    expect(
      readAccountBlockedReason({
        data: { code: 'FORBIDDEN', accountBlocked: true, accountBlockedReason: 'account_blocked' },
      })
    ).toBe('account_blocked');
  });

  it('reads the domain refusal off a shaped envelope', () => {
    expect(
      readAccountBlockedReason({
        shape: {
          data: {
            code: 'FORBIDDEN',
            accountBlocked: true,
            accountBlockedReason: 'email_domain_blocked',
          },
        },
      })
    ).toBe('email_domain_blocked');
  });

  it('reads the reason off a real tRPC client error', () => {
    const error = Object.assign(new Error('Access denied'), {
      data: {
        code: 'FORBIDDEN',
        accountBlocked: true,
        accountBlockedReason: 'email_domain_blocked',
      },
    });
    expect(readAccountBlockedReason(error)).toBe('email_domain_blocked');
  });

  it('is null when the envelope carries no reason', () => {
    expect(
      readAccountBlockedReason({ data: { code: 'FORBIDDEN', accountBlocked: true } })
    ).toBeNull();
  });

  it('is null for a reason this client does not know', () => {
    expect(
      readAccountBlockedReason({
        data: { code: 'FORBIDDEN', accountBlocked: true, accountBlockedReason: 'rate_limited' },
      })
    ).toBeNull();
  });

  it('keeps the blocked flag when a future server names a reason this build does not know', () => {
    // An older client must not read a newer refusal as an unexplained error.
    const futureRefusal = {
      data: { code: 'FORBIDDEN', accountBlocked: true, accountBlockedReason: 'rate_limited' },
    };
    expect(isAccountBlockedTrpcError(futureRefusal)).toBe(true);
    expect(readAccountBlockedReason(futureRefusal)).toBeNull();
  });

  it('is null when there is no error at all', () => {
    expect(readAccountBlockedReason(undefined)).toBeNull();
    expect(readAccountBlockedReason(null)).toBeNull();
    expect(readAccountBlockedReason(new Error('network down'))).toBeNull();
  });
});
