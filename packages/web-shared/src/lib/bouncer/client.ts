import 'server-only';

import { createHash } from 'crypto';

import * as z from 'zod';

import { BOUNCER_URL, INTERNAL_API_SECRET } from '@kilocode/web-shared/lib/config.server';

/**
 * Client for the bouncer worker (https://bouncer.kiloapps.io, repo Kilo-Org/bouncer).
 *
 * A bouncer failure must never fail the caller: every best-effort function here resolves, and it
 * logs on failure. The request contracts mirror the typia types in the bouncer repo
 * (`src/credit-event.ts`, `src/usage-event.ts`, `src/decide.ts`). Bouncer rejects an invalid body
 * with 400.
 *
 * `decide` returns bouncer's verdict, or null on a timeout, transport error, non-2xx, or a body that
 * is not a `DecideResponse`; the gateway rejects a request only when the verdict says
 * `enforced: true`, and sends it upstream in every other case. `reportUsageEvent` stays best-effort
 * transport. `deliverCreditEventWireBody` and `deliverUsageEventWireBody` return an explicit
 * delivery result instead of swallowing it: the durable outbox drainers are their callers, and they
 * must distinguish a real HTTP success from a failure so a transport error can never mark an event
 * delivered. Webhooks and store notifications never call them: they only enqueue to the outbox.
 */

/** Bouncer keeps ids to 128 characters. */
const MAX_ID_LENGTH = 128;

/**
 * Per-delivery budget for one credit event. Webhooks no longer await bouncer (they enqueue to the
 * durable outbox), so this bounds one outbox drainer delivery, keeping a pass inside its cron
 * function limit.
 */
const CREDIT_TIMEOUT_MS = 5_000;
/** Usage reports run after the inference response and have a larger trial budget. */
const USAGE_TIMEOUT_MS = 30_000;
/**
 * Per-delivery budget for one usage event from the durable usage-event outbox, so the immediate
 * delivery after the usage write and one drainer delivery both stay short.
 */
const USAGE_OUTBOX_TIMEOUT_MS = 5_000;
/** A lease release runs in `after()` once the request has ended. */
const RELEASE_TIMEOUT_MS = 5_000;

/** Signup runs on the auth critical path, before Stripe or the user insert. */
const SIGNUP_TIMEOUT_MS = 500;
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
  /**
   * The bounded opaque client-fingerprint digest from the Vercel `x-vercel-ja4-digest`
   * header, when the request carried a valid one. It describes the client TLS/HTTP
   * fingerprint of the peer that reached Kilo's edge (often shared proxy
   * infrastructure, not the end user or a device), so it is correlation evidence
   * only. Omit it when the header is missing or invalid; never truncate it.
   */
  ja4?: string | null;
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
  /**
   * Apple `originalTransactionId`, which labels the subscription transaction chain (not the Apple
   * ID). Google has no stable account key, so it omits this. It cannot correlate separate credit
   * pack purchases, whose identity is `referenceId`.
   */
  originalTransactionId?: string | null;
  /** Apple `transactionId`, or the Google order id. */
  referenceId: string;
  /** Report production events only; bouncer logs this field. */
  environment?: 'production' | 'sandbox';
};

export type StoreEventKind =
  | { type: 'store.purchase'; amountCents?: number }
  | { type: 'store.refund'; reason: StoreReason }
  /** Apple `CONSUMPTION_REQUEST`: the customer asked for a refund; the outcome is still open. */
  | { type: 'store.refund_requested' }
  /** Apple `REFUND_DECLINED`: the store declined the refund request. */
  | { type: 'store.refund_declined' }
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
            /** The payer's `microdollars_used` at charge time. */
            accountUsedMicrodollars?: number | null;
            ipCountry?: string | null;
            cardCountry?: string | null;
          }
        | { type: 'charge.succeeded'; amountCents: number }
        | { type: 'charge.failed' }
        | { type: 'charge.disputed' | 'charge.dispute_won'; disputeId: string }
        | { type: 'charge.early_fraud_warning' }
      ))
  | StoreCreditEvent;

/** The inference API family a usage event came from. */
export type ApiKind =
  | 'chat_completions'
  | 'responses'
  | 'messages'
  | 'fim_completions'
  | 'edit_completions'
  | 'embeddings'
  | 'audio_transcriptions'
  | 'systemone';

type UsageEventFields = {
  requestId: string;
  /** When the request started. */
  occurredAt?: Date;
  /** The API family; every new caller supplies it, older in-flight requests may omit it. */
  apiKind?: ApiKind;
  /** The request's client IP as a bare IPv4/IPv6 literal, when one resolved. */
  ip?: string | null;
  /**
   * The bounded opaque client-fingerprint digest from the Vercel `x-vercel-ja4-digest`
   * header, when the request carried a valid one. Omit it when the header is missing or
   * invalid. It fingerprints the client TLS/HTTP characteristics of the peer that reached
   * Kilo's edge, not a person or device.
   */
  ja4?: string | null;
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
  /** The request's charged cost in microdollars, after free-model and BYOK zeroing. */
  costMicrodollars?: number | null;
};

/**
 * A usage event: a signed-in request carries `accountId` (`org:<id>` or `user:<id>`) and an
 * optional `ip`; an anonymous request carries `tier: 'anonymous'`, a required `ip`, and no
 * `accountId`, so it can never be joined to a payer.
 */
export type UsageEvent =
  | (UsageEventFields & { accountId: string })
  | (UsageEventFields & { tier: 'anonymous'; ip: string });

export type DecideTier = 'anonymous' | 'free' | 'paid' | 'team';

export type DecideRequest =
  | { requestId: string; tier: 'anonymous'; ip: string; ja4?: string | null }
  | {
      requestId: string;
      tier: Exclude<DecideTier, 'anonymous'>;
      accountId: string;
      /** The authenticated actor, independently of the paying account. */
      userId?: string;
      /** The request's client IP as a bare IPv4/IPv6 literal, when one resolved. */
      ip?: string | null;
      /**
       * The bounded opaque client-fingerprint digest from the Vercel `x-vercel-ja4-digest`
       * header, when the request carried a valid one. Omit it when the header is missing or
       * invalid. It fingerprints the client TLS/HTTP characteristics of the peer that reached
       * Kilo's edge, not a person or device.
       */
      ja4?: string | null;
      /** `created_at` of the paying user, or of the organization for an `org:` account. */
      accountCreatedAt?: Date | string | null;
      /** `microdollars_used` of the paying user or organization. */
      usedMicrodollars?: number | null;
      /** `total_microdollars_acquired` of the paying user or organization. */
      acquiredMicrodollars?: number | null;
    };

/**
 * Bouncer's decide verdict. `enforced: true` is the only answer that rejects a request; `code` says
 * how. `flags` are internal: log them server-side and never return them to a client. `spendWatch`
 * asks the gateway to send this request's usage event through the durable usage-event outbox.
 */
const decideResponseSchema = z.object({
  enforced: z.boolean(),
  code: z.enum(['rate_limited', 'spend_limited', 'restricted']).optional(),
  retryAfterMs: z.number().nonnegative().optional(),
  spendWatch: z.boolean(),
  flags: z.array(
    z.object({
      name: z.string(),
      decision: z.enum(['review', 'throttle', 'block']),
      enforced: z.boolean(),
      until: z.number().nullable(),
      // Log-only metadata; a new source must not invalidate the whole verdict.
      source: z.string().optional(),
    })
  ),
});

export type DecideResponse = z.infer<typeof decideResponseSchema>;
export type DecideFlag = DecideResponse['flags'][number];

const signupRequestSchema = z.strictObject({
  operationId: z.string().min(1).max(MAX_ID_LENGTH),
  ip: z.union([z.ipv4(), z.ipv6()]),
});

const signupFlagSchema = z.strictObject({
  name: z.enum(['signup:burst', 'signup:sustained', 'signup:saturated']),
  decision: z.enum(['review', 'throttle', 'block']),
  enforced: z.boolean(),
  until: z.number().nonnegative().nullable(),
  source: z.string().max(MAX_ID_LENGTH).optional(),
});

/** Only a complete, known enforced rejection may prevent an account from being created. */
const signupResponseSchema = z.discriminatedUnion('enforced', [
  z.strictObject({
    enforced: z.literal(false),
    flags: z.array(signupFlagSchema).max(3),
  }),
  z.strictObject({
    enforced: z.literal(true),
    code: z.literal('signup_rate_limited'),
    retryAfterMs: z
      .number()
      .int()
      .nonnegative()
      // Allow clock and request-order skew beyond the longest supported window.
      .max(31 * 24 * 60 * 60 * 1000),
    flags: z.array(signupFlagSchema).max(3),
  }),
]);

export type SignupDecideResponse = z.infer<typeof signupResponseSchema>;

/** The explicit outcome of delivering one outbox event, for a durable outbox drainer. */
export type BouncerDeliveryResult =
  | { delivered: true; status: number }
  | {
      delivered: false;
      /**
       * True when retrying cannot help in this environment (for example bouncer is not configured),
       * so the row should fail terminally instead of backing off.
       */
      permanent: boolean;
      status: number | null;
      error: string;
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

/**
 * A microdollar amount as bouncer's typia types accept it: a non-negative integer (it may exceed
 * uint32). Anything else is dropped rather than sent, so one odd value cannot fail the whole body.
 */
function microdollars(value: number | null | undefined): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  return Number.isSafeInteger(rounded) && rounded >= 0 ? rounded : undefined;
}

/**
 * Bouncer's accepted client-fingerprint digest: a bounded, opaque token. The Vercel
 * `x-vercel-ja4-digest` header may carry a standard JA4 string or a hash, so this only bounds
 * the shape (`^[a-z0-9_]{1,128}$`) instead of decoding TLS fields. Trim and lowercase, then keep
 * the value only while it matches; an over-long or otherwise invalid value is dropped whole —
 * never truncated or substringed, so an identity is never silently rewritten.
 */
const JA4_DIGEST = /^[a-z0-9_]{1,128}$/;

export function normalizeJa4(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && JA4_DIGEST.test(normalized) ? normalized : undefined;
}

/**
 * The wire identity of a source event id, and therefore the outbox dedupe key. A source id within
 * bouncer's 128-character limit passes through unchanged; a longer one is replaced by its SHA-256
 * hex digest (64 chars). Truncating instead would let two ids sharing a 128-character prefix but
 * differing past it collapse to one wire identity, silently dropping the second financial signal.
 * Source ids are normally well under 128 characters, so the hash is a rare boundary case.
 */
export function bouncerWireEventId(eventId: string): string {
  return eventId.length <= MAX_ID_LENGTH
    ? eventId
    : createHash('sha256').update(eventId).digest('hex');
}

function isoTime(value: Date | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const date = typeof value === 'string' ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Drops `undefined` fields, so the body carries only what bouncer's typia types accept. */
function compact<T extends Record<string, unknown>>(body: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
}

type PostResult =
  | { ok: true; status: number; response: Response }
  | { ok: false; status: number | null; error: string };

/**
 * One POST to the worker with an explicit result. Never throws: a transport error, timeout, or
 * non-2xx status becomes `{ ok: false }` carrying the status when one was received. A 2xx returns
 * the raw `Response` and never reads the body, so a body-less or non-JSON success (for example a
 * 204) is still a real delivery and cannot fail a financial report. The error name is preserved
 * because an abort reason is a DOMException, which is not always `instanceof Error`.
 */
async function postWithResult(
  path: string,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<PostResult> {
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
      return { ok: false, status: response.status, error: `http_${response.status}` };
    }
    return { ok: true, status: response.status, response };
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name;
    return {
      ok: false,
      status: null,
      error: typeof name === 'string' ? name : String(error),
    };
  }
}

/**
 * Best-effort POST for usage/decide: resolves to null on any failure and logs it. Only these
 * verdict-shaped callers read a JSON body; a body-less/non-JSON success resolves to null.
 */
async function post(
  path: string,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<unknown> {
  if (!BOUNCER_URL || !INTERNAL_API_SECRET) return null;
  const result = await postWithResult(path, body, timeoutMs, signal);
  if (result.ok) {
    try {
      return await result.response.json();
    } catch {
      return null;
    }
  }
  // A decide timeout is expected on a slow call; it is not worth an error line each time.
  if (!(result.error === 'TimeoutError' && path === DECIDE_PATH)) {
    console.error('[bouncer] request failed', { path, status: result.status, error: result.error });
  }
  return null;
}

/**
 * The durable outbox sender targets v2 so a pre-v2 bouncer deploy answers 404 and the event is
 * retried visibly, instead of a v1 typia type silently dropping the renamed/unknown fields.
 */
const CREDIT_EVENT_PATH = '/api/v2/credit-event';
const USAGE_EVENT_PATH = '/api/v1/usage-event';
const DECIDE_PATH = '/api/v1/decide';
const SIGNUP_DECIDE_PATH = '/api/v1/signup-decide';
const RELEASE_PATH = '/api/v1/release';

const STORE_EVENT_TYPES: Record<StoreCreditEvent['type'], true> = {
  'store.purchase': true,
  'store.refund': true,
  'store.refund_requested': true,
  'store.refund_declined': true,
  'store.refund_reversed': true,
  'store.revoked': true,
};

function isStoreCreditEvent(event: CreditEvent): event is StoreCreditEvent {
  return event.type in STORE_EVENT_TYPES;
}

/**
 * Shapes one credit event into the exact body bouncer's typia types accept: `undefined` fields are
 * dropped and every id is truncated to bouncer's 128-character limit. This is the wire boundary:
 * the outbox persists this body, so the payload it stores is the JSON-serializable contract and the
 * drainer never re-derives it. `eventId` is the wire identity from `bouncerWireEventId` (never
 * truncated), and the outbox dedupe key uses the same value, so two source events never collapse to
 * one identity; the other ids keep the truncating limitation.
 */
export function creditEventWireBody(event: CreditEvent): Record<string, unknown> {
  if (isStoreCreditEvent(event)) {
    return compact({
      // A store event carries no card, client IP, or client fingerprint:
      // bouncer's typia types reject all three.
      eventId: bouncerWireEventId(event.eventId),
      occurredAt: isoTime(event.occurredAt),
      userId: id(event.userId),
      orgId: id(event.orgId),
      provider: event.provider,
      originalTransactionId: id(event.originalTransactionId),
      referenceId: id(event.referenceId),
      environment: event.environment,
      type: event.type,
      amountCents:
        event.type === 'store.purchase' && event.amountCents !== undefined
          ? Math.max(0, Math.round(event.amountCents))
          : undefined,
      reason: event.type === 'store.refund' ? event.reason : undefined,
    });
  }
  const common = {
    eventId: bouncerWireEventId(event.eventId),
    occurredAt: isoTime(event.occurredAt),
    userId: id(event.userId),
    orgId: id(event.orgId),
    cardFingerprint: id(event.cardFingerprint),
    ip: event.ip ?? undefined,
    ja4: normalizeJa4(event.ja4),
  };
  switch (event.type) {
    case 'charge.attempted':
      return compact({
        ...common,
        type: event.type,
        flow: event.flow,
        amountCents: Math.max(0, Math.round(event.amountCents)),
        accountCreatedAt: isoTime(event.accountCreatedAt),
        accountUsedMicrodollars: microdollars(event.accountUsedMicrodollars),
        ipCountry: country(event.ipCountry),
        cardCountry: country(event.cardCountry),
      });
    case 'charge.succeeded':
      return compact({
        ...common,
        type: event.type,
        amountCents: Math.max(0, Math.round(event.amountCents)),
      });
    case 'charge.disputed':
    case 'charge.dispute_won':
      return compact({ ...common, type: event.type, disputeId: id(event.disputeId) });
    case 'charge.failed':
    case 'charge.early_fraud_warning':
      return compact({ ...common, type: event.type });
  }
}

/**
 * Delivers one credit event, returning the real outcome. Convenience wrapper over
 * `deliverCreditEventWireBody` for a caller holding a typed event; the outbox drainer uses the wire
 * version, since it persists and re-sends the shaped body. Unlike the best-effort transport this
 * never swallows an HTTP status, so a `false` result is retried (or failed when `permanent`).
 *
 * Every HTTP failure is retryable so a transient proxy error, secret rotation, or a bouncer deploy
 * lag does not drop a financial signal; the outbox bounds retries and surfaces a terminal failure.
 */
export async function deliverCreditEvent(
  event: CreditEvent,
  signal?: AbortSignal
): Promise<BouncerDeliveryResult> {
  return deliverCreditEventWireBody(creditEventWireBody(event), signal);
}

/**
 * Delivers an already-shaped wire body, the form the outbox persists. The caller (the drainer)
 * validates the persisted JSON before calling; this function adds no current-time or other field
 * of its own, so a retry sends exactly the body that was originally enqueued.
 */
export async function deliverCreditEventWireBody(
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<BouncerDeliveryResult> {
  return deliverWireBody(CREDIT_EVENT_PATH, body, CREDIT_TIMEOUT_MS, signal);
}

/**
 * Delivers an already-shaped usage-event wire body from the durable usage-event outbox, returning
 * the real outcome. Bouncer dedupes a usage event by `requestId`, so a redelivery counts once.
 */
export async function deliverUsageEventWireBody(
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<BouncerDeliveryResult> {
  return deliverWireBody(USAGE_EVENT_PATH, body, USAGE_OUTBOX_TIMEOUT_MS, signal);
}

async function deliverWireBody(
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<BouncerDeliveryResult> {
  if (!BOUNCER_URL || !INTERNAL_API_SECRET) {
    return { delivered: false, permanent: true, status: null, error: 'bouncer_not_configured' };
  }
  const result = await postWithResult(path, body, timeoutMs, signal);
  if (result.ok) {
    // Drain the tiny acknowledgement body so the connection is reusable. The 2xx status is
    // authoritative for delivery; a read error is ignored and never causes a redelivery.
    await result.response.arrayBuffer().catch(() => undefined);
    return { delivered: true, status: result.status };
  }
  return { delivered: false, permanent: false, status: result.status, error: result.error };
}

/**
 * Shapes one usage event into the exact body bouncer's typia types accept. The usage-event outbox
 * persists this body, so a retry sends exactly what was enqueued.
 */
export function usageEventWireBody(event: UsageEvent): Record<string, unknown> {
  const common = {
    requestId: id(event.requestId),
    occurredAt: isoTime(event.occurredAt),
    apiKind: event.apiKind,
    ip: event.ip ?? undefined,
    ja4: normalizeJa4(event.ja4),
    inputTokens: Math.max(0, Math.round(event.inputTokens)),
    outputTokens: Math.max(0, Math.round(event.outputTokens)),
    clientAttributed: event.clientAttributed,
    feature: event.feature ? event.feature.slice(0, 64) : undefined,
    hasTools: event.hasTools,
    requestedLogprobs: event.requestedLogprobs,
    samples: event.samples && event.samples >= 1 ? Math.round(event.samples) : undefined,
    promptSimHash: event.promptSimHash ?? undefined,
    costMicrodollars: microdollars(event.costMicrodollars),
  };
  // An anonymous request carries only the tier and its required ip; a signed-in one adds accountId.
  return 'tier' in event
    ? compact({ ...common, tier: event.tier })
    : compact({ ...common, accountId: event.accountId });
}

/** Reports one inference request after its upstream response. Resolves on any failure. */
export async function reportUsageEvent(event: UsageEvent): Promise<void> {
  await post(USAGE_EVENT_PATH, usageEventWireBody(event), USAGE_TIMEOUT_MS);
}

/**
 * Releases the concurrency lease a watched account's decide took for `requestId`, for a request
 * that ended without a usage event (a usage event releases it itself). Best-effort: resolves on any
 * failure, and a lost release only holds the slot until bouncer's lease TTL.
 */
export async function releaseDecideLease(request: {
  requestId: string;
  accountId: string;
}): Promise<void> {
  await post(
    RELEASE_PATH,
    { requestId: id(request.requestId), accountId: request.accountId },
    RELEASE_TIMEOUT_MS
  );
}

/**
 * Asks bouncer for a verdict. Resolves to `null` on a timeout, transport error, non-2xx, or a body
 * that is not a `DecideResponse` (for example a pre-enforcement bouncer), so the gateway then sends
 * the request. Never rejects.
 */
export async function decide(
  request: DecideRequest,
  { timeoutMs, signal }: { timeoutMs: number; signal?: AbortSignal }
): Promise<DecideResponse | null> {
  const body =
    request.tier === 'anonymous'
      ? {
          requestId: id(request.requestId),
          tier: request.tier,
          ip: request.ip,
          ja4: normalizeJa4(request.ja4),
        }
      : compact({
          requestId: id(request.requestId),
          tier: request.tier,
          accountId: request.accountId,
          userId: request.userId,
          ip: request.ip ?? undefined,
          ja4: normalizeJa4(request.ja4),
          accountCreatedAt: isoTime(request.accountCreatedAt ?? undefined),
          usedMicrodollars: microdollars(request.usedMicrodollars),
          acquiredMicrodollars: microdollars(request.acquiredMicrodollars),
        });
  const response = await post(DECIDE_PATH, body, timeoutMs, signal);
  if (response === null) return null;
  const parsed = decideResponseSchema.safeParse(response);
  if (!parsed.success) {
    console.error('[bouncer] decide returned an unknown verdict shape', {
      issues: parsed.error.issues.map(issue => ({ path: issue.path.join('.'), code: issue.code })),
    });
    return null;
  }
  return parsed.data;
}

/** Best-effort signup admission, using the same internal key as inference decide. Never retries. */
export async function signupDecide(
  request: { operationId: string; ip: string },
  { timeoutMs = SIGNUP_TIMEOUT_MS, signal }: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<SignupDecideResponse | null> {
  const parsedRequest = signupRequestSchema.safeParse(request);
  if (!parsedRequest.success) return null;
  const response = await post(SIGNUP_DECIDE_PATH, parsedRequest.data, timeoutMs, signal);
  if (response === null) return null;
  const parsed = signupResponseSchema.safeParse(response);
  if (!parsed.success) {
    console.error('[bouncer] signup-decide returned an unknown verdict shape', {
      operationId: request.operationId,
      issues: parsed.error.issues.map(issue => ({ path: issue.path.join('.'), code: issue.code })),
    });
    return null;
  }
  return parsed.data;
}
