import * as z from 'zod';

/**
 * Runtime validator for the persisted credit-event wire body.
 *
 * The outbox stores JSON, which is untrusted at the dispatch boundary: a row may have been written
 * by an older deploy, so the drainer validates it before sending. The schema checks the structural
 * essentials (the discriminant, the dedupe ids, and the store-side provider/reference) and forwards
 * every declared field untouched; bouncer validates the rest, so a malformed field surfaces as a
 * visible 400 that retries rather than being silently dropped here. Fields are optional and strings
 * only, matching exactly what the serializer emits: persisted JSON cannot contain a Date.
 */
const chargeEventType = z.enum([
  'charge.attempted',
  'charge.succeeded',
  'charge.failed',
  'charge.disputed',
  'charge.dispute_won',
  'charge.early_fraud_warning',
]);

const storeEventType = z.enum([
  'store.purchase',
  'store.refund',
  'store.refund_requested',
  'store.refund_declined',
  'store.refund_reversed',
  'store.revoked',
]);

const chargeBodySchema = z
  .object({
    type: chargeEventType,
    eventId: z.string().min(1),
    userId: z.string().min(1),
    orgId: z.string().optional(),
    occurredAt: z.string().optional(),
    cardFingerprint: z.string().optional(),
    ip: z.string().optional(),
    flow: z.string().optional(),
    amountCents: z.number().optional(),
    accountCreatedAt: z.string().optional(),
    ipCountry: z.string().optional(),
    cardCountry: z.string().optional(),
    disputeId: z.string().optional(),
  })
  .passthrough();

const storeBodySchema = z
  .object({
    type: storeEventType,
    eventId: z.string().min(1),
    userId: z.string().min(1),
    orgId: z.string().optional(),
    occurredAt: z.string().optional(),
    provider: z.enum(['apple', 'google']),
    originalTransactionId: z.string().optional(),
    referenceId: z.string().min(1),
    environment: z.enum(['production', 'sandbox']).optional(),
    amountCents: z.number().optional(),
    reason: z.enum(['requested', 'issue', 'other']).optional(),
  })
  .passthrough();

const creditEventBodySchema = z.union([storeBodySchema, chargeBodySchema]);

/**
 * Validates a persisted wire body, returning it with all fields preserved, or null when it is not a
 * recognizable credit event.
 */
export function parseBouncerCreditEventBody(value: unknown): Record<string, unknown> | null {
  const parsed = creditEventBodySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
