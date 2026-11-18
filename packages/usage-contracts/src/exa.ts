import { z } from 'zod';

export const EXA_USAGE_WRITE_PATH = '/api/internal/exa-usage/record';

export const EXA_ALLOWED_PATHS = [
  '/search',
  '/contents',
  '/findSimilar',
  '/answer',
  '/context',
] as const;

export type ExaAllowedPath = (typeof EXA_ALLOWED_PATHS)[number];

const exaAllowedPathSet: ReadonlySet<string> = new Set(EXA_ALLOWED_PATHS);

export function isExaAllowedPath(path: string): path is ExaAllowedPath {
  return exaAllowedPathSet.has(path);
}

export const EXA_USAGE_FEATURE_ID_MAX_LENGTH = 64;

/**
 * `type` is copied from a free-form string in the client's Exa request body.
 * Senders must omit a longer value rather than send it, so a real request can
 * never produce a record this schema rejects.
 */
export const EXA_USAGE_TYPE_MAX_LENGTH = 128;

/**
 * One call returns at most 100 requested pages (`ids`, or `numResults` for a search), each with up
 * to 100 crawled subpages, and bills every returned page once per content type the request asked
 * for. At the published rates that is about $30 for the largest real call. The constant is $100,
 * a deliberate 3x headroom over that worst case so a pricing change or an unexpected page count
 * cannot reject a real record; it stays a plausible per-call maximum rather than a price list: a
 * larger value is not one Exa call's cost and must not reach the ledger or a balance. A real Exa
 * request never produces a record this schema rejects.
 */
export const EXA_MAX_COST_MICRODOLLARS_PER_CALL = 100_000_000;

/**
 * Wire contract for `POST /api/internal/exa-usage/record`.
 *
 * `id` and `occurredAt` are fixed once per upstream Exa response and are the
 * writer's idempotency key, so every retry or redelivery must resend them
 * unchanged. `occurredAt` is strict ISO 8601: a PostgreSQL timestamptz read
 * back from the database is not, see `packages/db/AGENTS.md`.
 *
 * `organizationId` is the payer when non-null and uses the same strict UUID
 * check as request authentication; personal usage sends `null`, never omits it.
 * Unknown keys are rejected so an LLM usage record cannot be mistaken for one.
 */
export const ExaUsageRecordSchema = z.strictObject({
  id: z.uuid(),
  occurredAt: z.iso.datetime({ offset: true }),
  userId: z.string().min(1),
  organizationId: z.uuid().nullable(),
  path: z.enum(EXA_ALLOWED_PATHS),
  costMicrodollars: z.number().int().positive().safe().max(EXA_MAX_COST_MICRODOLLARS_PER_CALL),
  chargedToBalance: z.boolean(),
  freeAllowanceMicrodollars: z.number().int().nonnegative().safe(),
  featureId: z.string().min(1).max(EXA_USAGE_FEATURE_ID_MAX_LENGTH).optional(),
  type: z.string().max(EXA_USAGE_TYPE_MAX_LENGTH).optional(),
});

export type ExaUsageRecord = z.infer<typeof ExaUsageRecordSchema>;

/**
 * `duplicate` means a record with this `id` and `occurredAt` was already
 * committed, so the caller must treat it as success without a second charge.
 * `rejected` means the writer could not resolve the payer the record names, so
 * nothing was recorded and the sender must not send it again.
 */
export const ExaUsageWriteResponseSchema = z.strictObject({
  status: z.enum(['recorded', 'duplicate', 'rejected']),
  usageId: z.uuid(),
});

export type ExaUsageWriteResponse = z.infer<typeof ExaUsageWriteResponseSchema>;

/**
 * Body of an Exa usage message on the shared usage queue. The kind tag is what separates it from
 * an LLM usage message, which is always sent untagged.
 */
export const ExaUsageQueueMessageSchema = z.strictObject({
  kind: z.literal('exa_usage'),
  v: z.literal(1),
  record: ExaUsageRecordSchema,
});

export type ExaUsageQueueMessage = z.infer<typeof ExaUsageQueueMessageSchema>;
