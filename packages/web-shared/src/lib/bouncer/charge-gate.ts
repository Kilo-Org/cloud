import 'server-only';

import { randomUUID } from 'crypto';

import { TRPCError } from '@trpc/server';

import {
  bouncerAccountId,
  chargeDecide,
  type ChargeDecideResponse,
  type CreditFlow,
} from '@kilocode/web-shared/lib/bouncer/client';

/**
 * The refusal a checkout procedure returns when bouncer's charge standing blocks the payer. It says
 * nothing about why, so a card tester learns nothing from it.
 */
export const CHARGE_GATE_BLOCKED_MESSAGE = 'We could not start this payment. Contact support.';

/** A charge-gate question about one payer, before a checkout or after a declined charge. */
export type ChargeStandingRequest = {
  stage: 'checkout' | 'failure';
  /** An id for bouncer's audit log: the checkout attempt, or the charge id on a failure. */
  requestId: string;
  /** `user:<id>` or `org:<id>`, the same payer key the credit events use. */
  accountId: string;
  userId?: string;
  ip?: string | null;
  ja4?: string | null;
  flow?: CreditFlow;
};

/**
 * Asks bouncer for the payer's charge standing. Resolves to `null` when bouncer does not answer
 * (timeout, transport error, non-2xx, or an unknown body), which every caller treats as allowed.
 * The flags are internal: they are logged with an enforced verdict and never leave the server.
 */
export async function chargeStanding(
  request: ChargeStandingRequest
): Promise<ChargeDecideResponse | null> {
  const verdict = await chargeDecide(request);
  if (verdict?.enforced) {
    // Bouncer logs every verdict with its flags; log only the refusals applied here.
    console.warn('[bouncer] charge refused', {
      requestId: request.requestId,
      stage: request.stage,
      flow: request.flow,
      code: verdict.code,
      flags: verdict.flags,
    });
  }
  return verdict;
}

/** The payer and client facts a checkout procedure already has. */
export type ChargeCheckoutGateParams = {
  userId: string;
  /** The payer organization, for an org charge. */
  organizationId?: string | null;
  flow: CreditFlow;
  ip?: string | null;
  ja4?: string | null;
  /** An id for bouncer's audit log; defaults to a fresh id for this attempt. */
  requestId?: string;
};

/**
 * Asks bouncer whether this checkout may proceed. Resolves to `null` when bouncer does not answer,
 * which the caller treats as allowed. A route handler that cannot throw a tRPC error maps the
 * verdict to its own response instead of using `assertChargeAllowed`.
 */
export async function decideCheckoutCharge(
  params: ChargeCheckoutGateParams
): Promise<ChargeDecideResponse | null> {
  return chargeStanding({
    stage: 'checkout',
    requestId: params.requestId ?? `checkout:${randomUUID()}`,
    accountId: bouncerAccountId(params.userId, params.organizationId),
    userId: params.userId,
    ip: params.ip,
    ja4: params.ja4,
    flow: params.flow,
  });
}

/**
 * Refuses a checkout before Stripe creates or reuses a session when bouncer says the payer's
 * standing blocks charging. An unavailable verdict allows the checkout, so a bouncer outage never
 * stops paying customers.
 */
export async function assertChargeAllowed(params: ChargeCheckoutGateParams): Promise<void> {
  const verdict = await decideCheckoutCharge(params);
  if (verdict?.enforced) {
    throw new TRPCError({ code: 'FORBIDDEN', message: CHARGE_GATE_BLOCKED_MESSAGE });
  }
}
