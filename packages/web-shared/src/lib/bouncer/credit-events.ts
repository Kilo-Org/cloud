import 'server-only';

import { randomUUID } from 'crypto';

import { reportCreditEvent, type CreditFlow } from '@/lib/bouncer/client';

/** `x-vercel-ip-country` from request headers, for a bouncer `ipCountry`. */
export function ipCountryFromHeaders(headers?: Headers | null): string | null {
  return headers?.get('x-vercel-ip-country')?.trim() || null;
}

/**
 * The context a `charge.attempted` needs in addition to the flow-specific fields. `accountCreatedAt`
 * is `users.created_at` for a personal charge and `organizations.created_at` for an org charge.
 */
export type ChargeAttemptContext = {
  accountCreatedAt: Date | string;
  /** The client IP. Omit it for an off-session charge. */
  ip?: string | null;
  ipCountry?: string | null;
  cardFingerprint?: string | null;
  cardCountry?: string | null;
};

/**
 * Reports a `charge.attempted` for a charge or checkout the caller is about to create.
 *
 * Fire-and-forget: it is never awaited on the user's checkout path, and a bouncer failure must
 * never affect the checkout (the client resolves on any failure). Every call generates a fresh
 * `eventId`; a Stripe webhook outcome later carries the Stripe event id.
 */
export function reportChargeAttempted(
  params: {
    flow: CreditFlow;
    userId: string;
    orgId?: string | null;
    amountCents: number;
  } & ChargeAttemptContext
): void {
  void reportCreditEvent({
    type: 'charge.attempted',
    eventId: randomUUID(),
    flow: params.flow,
    userId: params.userId,
    orgId: params.orgId,
    amountCents: params.amountCents,
    accountCreatedAt: params.accountCreatedAt,
    ip: params.ip,
    ipCountry: params.ipCountry,
    cardFingerprint: params.cardFingerprint,
    cardCountry: params.cardCountry,
  });
}
