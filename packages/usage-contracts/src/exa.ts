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
  id: z.string().uuid(),
  occurredAt: z.string().datetime({ offset: true }),
  userId: z.string().min(1),
  organizationId: z.string().uuid().nullable(),
  path: z.enum(EXA_ALLOWED_PATHS),
  costMicrodollars: z.number().int().positive().safe(),
  chargedToBalance: z.boolean(),
  freeAllowanceMicrodollars: z.number().int().nonnegative().safe(),
  featureId: z.string().min(1).max(EXA_USAGE_FEATURE_ID_MAX_LENGTH).optional(),
  type: z.string().max(EXA_USAGE_TYPE_MAX_LENGTH).optional(),
});

export type ExaUsageRecord = z.infer<typeof ExaUsageRecordSchema>;

/**
 * `duplicate` means a record with this `id` and `occurredAt` was already
 * committed, so the caller must treat it as success without a second charge.
 */
export const ExaUsageWriteResponseSchema = z.strictObject({
  status: z.enum(['recorded', 'duplicate']),
  usageId: z.string().uuid(),
});

export type ExaUsageWriteResponse = z.infer<typeof ExaUsageWriteResponseSchema>;
