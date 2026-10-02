import 'server-only';

import { BOUNCER_URL, INTERNAL_API_SECRET } from '@kilocode/web-shared/lib/config.server';

/**
 * Client for the bouncer worker (https://bouncer.kiloapps.io, repo Kilo-Org/bouncer).
 *
 * Every bouncer verdict is report-only (`enforced: false`). Callers must not act on a verdict, and
 * a bouncer failure must never fail the caller: every function here resolves, and it logs on
 * failure. The request contracts mirror the typia types in the bouncer repo (`src/credit-event.ts`,
 * `src/usage-event.ts`, `src/decide.ts`). Bouncer rejects an invalid body with 400.
 */

/** Bouncer keeps ids to 128 characters. */
const MAX_ID_LENGTH = 128;

/** Credit reports can be awaited by Stripe webhooks, so retain their shorter budget. */
const CREDIT_TIMEOUT_MS = 5_000;
/** Usage reports run after the inference response and have a larger trial budget. */
const USAGE_TIMEOUT_MS = 30_000;

export type CreditFlow = 'auto_topup' | 'kilo_pass' | 'kiloclaw' | 'seats' | 'topup';

type CreditSubject = {
  /** The id of one event, for example the Stripe event id. A retry with the same id counts once. */
  eventId: string;
  /** For a webhook, the Stripe `event.created` time. */
  occurredAt?: Date;
  userId: string;
  /** Send it for an org charge. The org is then the payer. */
  orgId?: string | null;
  cardFingerprint?: string | null;
  /** The client IP. Omit it for an off-session charge. */
  ip?: string | null;
};

/** The store that sent a money event. */
export type StoreProvider = 'apple' | 'google';

/** The reason a store refunded, as the caller classified it from the store payload. */
export type StoreReason = 'requested' | 'issue' | 'other';

/**
 * An App Store or Google Play money event. The caller verifies the store payload and resolves the
 * Kilo account, so bouncer never reads a signed JWS and never looks up a user. A store event has no
 * card and no client IP, and bouncer's typia types reject both fields.
 */
type StoreSubject = {
  /** The id of one event, for example the Apple `notificationUUID`. A retry counts once. */
  eventId: string;
  /** When the store sent the event, for example the Apple `signedDate`. */
  occurredAt?: Date | string;
  userId: string;
  /** Send it for an org purchase. The org is then the payer. */
  orgId?: string | null;
  provider: StoreProvider;
  /** Apple `originalTransactionId`. Google has no stable account key, so it omits this. */
  storeAccountKey?: string | null;
  /** Apple `transactionId`, or the Google order id. */
  referenceId: string;
  /** Report production events only; bouncer logs this field. */
  environment?: 'production' | 'sandbox';
};

export type StoreEventKind =
  | { type: 'store.purchase'; amountCents?: number }
  | { type: 'store.refund'; reason: StoreReason }
  | { type: 'store.refund_reversed' }
  | { type: 'store.revoked' };

export type StoreCreditEvent = StoreSubject & StoreEventKind;

export type CreditEvent =
  | (CreditSubject &
      (
        | {
            type: 'charge.attempted';
            flow: CreditFlow;
            amountCents: number;
            accountCreatedAt: Date | string;
            ipCountry?: string | null;
            cardCountry?: string | null;
          }
        | { type: 'charge.succeeded'; amountCents: number }
        | { type: 'charge.failed' }
        | { type: 'charge.disputed' | 'charge.dispute_won'; disputeId: string }
        | { type: 'charge.early_fraud_warning' }
      ))
  | StoreCreditEvent;

export type UsageEvent = {
  requestId: string;
  /** When the request started. */
  occurredAt?: Date;
  /** `org:<id>` for an org request, else `user:<id>`. */
  accountId: string;
  inputTokens: number;
  outputTokens: number;
  /** True if the request came from a known Kilo client: a known feature value or a Kilo version header. */
  clientAttributed: boolean;
  feature?: string | null;
  hasTools: boolean;
  /** The request set `logprobs`, `top_logprobs`, or `logit_bias`. */
  requestedLogprobs: boolean;
  /** The `n` sampling parameter. */
  samples?: number | null;
  /** A 64-bit SimHash of the user prompt, as 16 hex characters. */
  promptSimHash?: string | null;
};

export type DecideTier = 'anonymous' | 'free' | 'paid' | 'team';

export type DecideRequest =
  | { requestId: string; tier: 'anonymous'; ip: string }
  | { requestId: string; tier: Exclude<DecideTier, 'anonymous'>; accountId: string };

export type DecideVerdict = {
  decision: 'allow' | 'block' | 'review' | 'throttle';
  reasons: string[];
  retryAfterMs?: number;
  enforced: false;
};

/** The payer key bouncer uses for an account: the org for an org request, else the user. */
export function bouncerAccountId(userId: string, organizationId?: string | null): string {
  return organizationId ? `org:${organizationId}` : `user:${userId}`;
}

const COUNTRY = /^[A-Z]{2}$/;

function country(value: string | null | undefined): string | undefined {
  const upper = value?.toUpperCase();
  return upper && COUNTRY.test(upper) ? upper : undefined;
}

function id(value: string | null | undefined): string | undefined {
  return value ? value.slice(0, MAX_ID_LENGTH) : undefined;
}

function isoTime(value: Date | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const date = typeof value === 'string' ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Drops `undefined` fields, so the body carries only what bouncer's typia types accept. */
function compact<T extends Record<string, unknown>>(body: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(body).filter(([, value]) => value !== undefined)
  ) as Partial<T>;
}

async function post(
  path: string,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<unknown> {
  if (!BOUNCER_URL || !INTERNAL_API_SECRET) return null;
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(`${BOUNCER_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-api-key': INTERNAL_API_SECRET },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      cache: 'no-store',
    });
    if (!response.ok) {
      console.error('[bouncer] request failed', { path, status: response.status });
      return null;
    }
    return await response.json();
  } catch (error) {
    // The abort reason is a DOMException, which is not always `instanceof Error`: match on the name.
    const name = (error as { name?: unknown } | null)?.name;
    // A decide timeout is expected on a slow call; it is not worth an error line each time.
    if (!(name === 'TimeoutError' && path === DECIDE_PATH)) {
      console.error('[bouncer] request error', {
        path,
        error: typeof name === 'string' ? name : String(error),
      });
    }
    return null;
  }
}

const CREDIT_EVENT_PATH = '/api/v1/credit-event';
const USAGE_EVENT_PATH = '/api/v1/usage-event';
const DECIDE_PATH = '/api/v1/decide';

const STORE_EVENT_TYPES: Record<StoreCreditEvent['type'], true> = {
  'store.purchase': true,
  'store.refund': true,
  'store.refund_reversed': true,
  'store.revoked': true,
};

function isStoreCreditEvent(event: CreditEvent): event is StoreCreditEvent {
  return event.type in STORE_EVENT_TYPES;
}

/** Reports one charge step. Resolves on any failure. */
export async function reportCreditEvent(event: CreditEvent): Promise<void> {
  if (isStoreCreditEvent(event)) {
    await post(
      CREDIT_EVENT_PATH,
      compact({
        // A store event carries no card and no client IP: bouncer's typia types reject both.
        eventId: id(event.eventId),
        occurredAt: isoTime(event.occurredAt),
        userId: id(event.userId),
        orgId: id(event.orgId),
        provider: event.provider,
        storeAccountKey: id(event.storeAccountKey),
        referenceId: id(event.referenceId),
        environment: event.environment,
        type: event.type,
        amountCents:
          event.type === 'store.purchase' && event.amountCents !== undefined
            ? Math.max(0, Math.round(event.amountCents))
            : undefined,
        reason: event.type === 'store.refund' ? event.reason : undefined,
      }),
      CREDIT_TIMEOUT_MS
    );
    return;
  }
  const common = {
    eventId: id(event.eventId),
    occurredAt: isoTime(event.occurredAt),
    userId: id(event.userId),
    orgId: id(event.orgId),
    cardFingerprint: id(event.cardFingerprint),
    ip: event.ip ?? undefined,
  };
  let body: Record<string, unknown>;
  switch (event.type) {
    case 'charge.attempted':
      body = {
        ...common,
        type: event.type,
        flow: event.flow,
        amountCents: Math.max(0, Math.round(event.amountCents)),
        accountCreatedAt: isoTime(event.accountCreatedAt),
        ipCountry: country(event.ipCountry),
        cardCountry: country(event.cardCountry),
      };
      break;
    case 'charge.succeeded':
      body = {
        ...common,
        type: event.type,
        amountCents: Math.max(0, Math.round(event.amountCents)),
      };
      break;
    case 'charge.disputed':
    case 'charge.dispute_won':
      body = { ...common, type: event.type, disputeId: id(event.disputeId) };
      break;
    case 'charge.failed':
    case 'charge.early_fraud_warning':
      body = { ...common, type: event.type };
      break;
  }
  await post(CREDIT_EVENT_PATH, compact(body), CREDIT_TIMEOUT_MS);
}

/** Reports one inference request after its upstream response. Resolves on any failure. */
export async function reportUsageEvent(event: UsageEvent): Promise<void> {
  const body = compact({
    requestId: id(event.requestId),
    occurredAt: isoTime(event.occurredAt),
    accountId: event.accountId,
    inputTokens: Math.max(0, Math.round(event.inputTokens)),
    outputTokens: Math.max(0, Math.round(event.outputTokens)),
    clientAttributed: event.clientAttributed,
    feature: event.feature ? event.feature.slice(0, 64) : undefined,
    hasTools: event.hasTools,
    requestedLogprobs: event.requestedLogprobs,
    samples: event.samples && event.samples >= 1 ? Math.round(event.samples) : undefined,
    promptSimHash: event.promptSimHash ?? undefined,
  });
  await post(USAGE_EVENT_PATH, body, USAGE_TIMEOUT_MS);
}

/**
 * Asks bouncer for a report-only verdict. Resolves to `null` on a timeout or any error,
 * so the gateway always sends the request.
 */
export async function decide(
  request: DecideRequest,
  { timeoutMs, signal }: { timeoutMs: number; signal?: AbortSignal }
): Promise<DecideVerdict | null> {
  const body =
    request.tier === 'anonymous'
      ? { requestId: id(request.requestId), tier: request.tier, ip: request.ip }
      : { requestId: id(request.requestId), tier: request.tier, accountId: request.accountId };
  return (await post(DECIDE_PATH, body, timeoutMs, signal)) as DecideVerdict | null;
}
