import 'server-only';

import { randomUUID } from 'crypto';

import type { NextResponse } from 'next/server';

import type { BouncerUsageContext } from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import {
  bouncerAccountId,
  normalizeJa4,
  type DecideResponse,
} from '@kilocode/web-shared/lib/bouncer/client';
import {
  bouncerRejectionResponse,
  payerSharingIp,
  startBouncerDecide,
  type BouncerDecideParams,
} from '@kilocode/web-shared/lib/bouncer/inference';
import type { FeatureValue } from '@kilocode/web-shared/lib/feature-detection';

type BouncerAccountInputs = Pick<NonNullable<BouncerDecideParams['account']>, 'tier' | 'payer'>;

/** Usage fields that differ by route; identity fields come from the request. */
export type BouncerUsageFields = Pick<
  BouncerUsageContext,
  'occurredAt' | 'clientAttributed' | 'requestedLogprobs' | 'samples' | 'promptSimHash'
>;

type BouncerRequestBase = {
  /** Shared by the decide and the usage event so bouncer can correlate them. */
  readonly requestId: string;
  usage(fields: BouncerUsageFields): BouncerUsageContext;
  /**
   * Maps the verdict to a rejection, or records its `spendWatch` on the usage context and returns
   * null so the request is sent upstream.
   */
  apply(
    verdict: DecideResponse | null,
    usage: BouncerUsageContext | undefined
  ): NextResponse | null;
};

export type SignedInBouncerRequest = BouncerRequestBase & {
  readonly kind: 'signed-in';
  /** Starts this request's only decide; see {@link startBouncerDecide}. */
  decide(
    account: BouncerAccountInputs | Promise<BouncerAccountInputs>
  ): Promise<DecideResponse | null>;
};

export type AnonymousBouncerRequest = BouncerRequestBase & {
  readonly kind: 'anonymous';
  /** Starts this request's only decide; see {@link startBouncerDecide}. */
  decide(): Promise<DecideResponse | null>;
};

type BouncerRequestInput = {
  /** The bare IP literal from {@link bareIpLiteral}. */
  ip: string | undefined;
  ja4Digest: string | null | undefined;
};

function bouncerRequestBase(
  requestId: string,
  accountId: string | null,
  usageIp: string | undefined
): BouncerRequestBase {
  return {
    requestId,
    usage: fields => ({ requestId, accountId, clientIp: usageIp, ...fields }),
    apply(verdict, usage) {
      const rejection = bouncerRejectionResponse(verdict, requestId);
      if (rejection) return rejection;
      if (usage) usage.spendWatch = verdict?.spendWatch === true;
      return null;
    },
  };
}

function oneDecide<Args extends unknown[]>(
  start: (...args: Args) => Promise<DecideResponse | null>
): (...args: Args) => Promise<DecideResponse | null> {
  let started = false;
  return (...args) => {
    if (started) throw new Error('Bouncer decide already started for this request');
    started = true;
    return start(...args);
  };
}

/**
 * Bouncer identity for a signed-in request. Decide gets the raw IP; the usage row gets the
 * payer-safe IP that drops shared Kilo infrastructure.
 */
export function signedInBouncerRequest(
  input: BouncerRequestInput & {
    userId: string;
    organizationId: string | undefined;
    feature: FeatureValue | null;
  }
): SignedInBouncerRequest {
  const requestId = randomUUID();
  const accountId = bouncerAccountId(input.userId, input.organizationId);
  const ja4 = normalizeJa4(input.ja4Digest);
  return {
    kind: 'signed-in',
    ...bouncerRequestBase(requestId, accountId, payerSharingIp(input.ip, input.feature)),
    decide: oneDecide(account =>
      startBouncerDecide(
        Promise.resolve(account).then(({ tier, payer }) => ({
          requestId,
          ip: input.ip,
          ja4,
          account: { accountId, userId: input.userId, tier, payer },
        }))
      )
    ),
  };
}

/**
 * Bouncer identity for an anonymous request. Bouncer keys it on the raw IP, so the usage row keeps
 * that IP and has no account, which keeps it out of payer sharing.
 */
export function anonymousBouncerRequest(input: BouncerRequestInput): AnonymousBouncerRequest {
  const requestId = randomUUID();
  const ja4 = normalizeJa4(input.ja4Digest);
  return {
    kind: 'anonymous',
    ...bouncerRequestBase(requestId, null, input.ip),
    decide: oneDecide(() => startBouncerDecide({ requestId, ip: input.ip, ja4 })),
  };
}
