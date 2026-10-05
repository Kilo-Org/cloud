import { ABUSE_CLASSIFICATION, GatewayApiKindSchema } from '@kilocode/db/schema-types';
import type { MicrodollarUsage } from '@kilocode/db/schema';
import { z } from 'zod';
import type { UsageMetaData } from './processUsage.types';

/**
 * Wire contract for `POST /api/internal/usage/record`.
 *
 * The AI gateway runs on `kilocode-global-app`, whose functions execute in both
 * Frankfurt and SFO, while the PostgreSQL primary is Frankfurt-only. The usage
 * write holds row locks on `kilocode_users` / `organizations` /
 * `organization_user_usage` across several sequential statements, so from SFO
 * the lock hold is dominated by transatlantic round trips rather than database
 * work. This contract lets an SFO instance hand the whole write to a
 * Frankfurt-local endpoint so those round trips become local.
 *
 * Invariants this schema deliberately encodes:
 *
 * - Nullable fields use `.nullable()`, never `.optional()`. `JSON.stringify`
 *   drops `undefined`-valued keys, and `null` is load-bearing here: for
 *   organization usage `toInsertableDbUsageRecord` explicitly sets
 *   `user_prompt_prefix` and `system_prompt_prefix` to `null` so prompt text is
 *   never persisted. A dropped key must be a 400, not a silent write of the
 *   wrong value.
 * - `created_at` is validated as strict ISO 8601. Both `core.created_at` and
 *   `metadata.created_at` come from `new Date().toISOString()` on the sender, so
 *   this holds by construction. It would NOT hold for a value read back out of
 *   PostgreSQL, which has shape `2026-04-29 01:16:12.945+00` — see
 *   `packages/db/AGENTS.md` "Timestamp boundaries". Keep the strict validator so
 *   a DB-shaped timestamp can never enter this path.
 * - `cost` and the token counts are PostgreSQL `bigint` mapped to JS `number`,
 *   so they are validated as safe integers.
 *
 * NUL-byte sanitization (`stripNulBytesInPlace`) happens on the sender inside
 * `toInsertableDbUsageRecord`, before serialization. `JSON.stringify` preserves
 * `\u0000` happily, so that sanitization is part of the sending contract: do not
 * move it to the receiver.
 */

/** PostgreSQL `bigint` columns surfaced to JS as `number`. */
const bigintAsNumber = z.number().int().safe();

const CoreUsageSchema = z.object({
  id: z.string().uuid(),
  kilo_user_id: z.string(),
  cost: bigintAsNumber,
  input_tokens: bigintAsNumber,
  output_tokens: bigintAsNumber,
  cache_write_tokens: bigintAsNumber,
  cache_hit_tokens: bigintAsNumber,
  created_at: z.string().datetime(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  requested_model: z.string().nullable(),
  cache_discount: bigintAsNumber.nullable(),
  has_error: z.boolean(),
  abuse_classification: z.nativeEnum(ABUSE_CLASSIFICATION),
  organization_id: z.string().uuid().nullable(),
  inference_provider: z.string().nullable(),
  project_id: z.string().nullable(),
});

const UsageMetadataSchema = z.object({
  id: z.string(),
  message_id: z.string(),
  created_at: z.string().datetime(),
  http_x_forwarded_for: z.string().nullable(),
  http_x_vercel_ip_city: z.string().nullable(),
  http_x_vercel_ip_country: z.string().nullable(),
  http_x_vercel_ip_latitude: z.number().nullable(),
  http_x_vercel_ip_longitude: z.number().nullable(),
  http_x_vercel_ja4_digest: z.string().nullable(),
  user_prompt_prefix: z.string().nullable(),
  system_prompt_prefix: z.string().nullable(),
  system_prompt_length: z.number().int().nullable(),
  http_user_agent: z.string().nullable(),
  max_tokens: z.number().int().nullable(),
  has_middle_out_transform: z.boolean().nullable(),
  status_code: z.number().int().nullable(),
  upstream_id: z.string().nullable(),
  finish_reason: z.string().nullable(),
  latency: z.number().nullable(),
  moderation_latency: z.number().nullable(),
  generation_time: z.number().nullable(),
  is_byok: z.boolean().nullable(),
  is_user_byok: z.boolean(),
  streamed: z.boolean().nullable(),
  cancelled: z.boolean().nullable(),
  editor_name: z.string().nullable(),
  api_kind: GatewayApiKindSchema.nullable(),
  has_tools: z.boolean().nullable(),
  machine_id: z.string().nullable(),
  feature: z.string().nullable(),
  session_id: z.string().nullable(),
  mode: z.string().nullable(),
  auto_model: z.string().nullable(),
  market_cost: z.number().nullable(),
  is_free: z.boolean().nullable(),
  abuse_delay: z.number().nullable(),
  abuse_downgraded_from: z.string().nullable(),
});

export const UsageRecordRequestSchema = z.object({
  core: CoreUsageSchema,
  metadata: UsageMetadataSchema,
  prior_microdollar_usage: z.number(),
  posthog_distinct_id: z.string().nullable(),
});

export type UsageRecordRequest = z.infer<typeof UsageRecordRequestSchema>;

/**
 * `duplicate` means the usage row already existed, so this delivery was a retry
 * of a call that had already committed. Callers must treat it as success: the
 * row is persisted and its post-commit side effects ran on the first delivery.
 *
 * `not_recorded` mirrors today's local behaviour where `insertUsageRecord`
 * swallows database errors and returns `null`.
 */
export const UsageRecordResponseSchema = z.object({
  status: z.enum(['recorded', 'duplicate', 'not_recorded']),
  result: z
    .object({
      usageId: z.string(),
      createdAt: z.string(),
      newMicrodollarsUsed: z.number().nullable(),
    })
    .nullable(),
});

export type UsageRecordResponse = z.infer<typeof UsageRecordResponseSchema>;

/**
 * Compile-time proof that the wire schemas stay aligned with the database types.
 * If a column is added to `microdollar_usage` or a field to `UsageMetaData`
 * without updating the schemas above, these assignments stop type-checking.
 */
type AssertExact<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : never
  : never;

export type CoreUsageContractMatchesDb = AssertExact<
  z.infer<typeof CoreUsageSchema>,
  MicrodollarUsage
>;
export type UsageMetadataContractMatchesType = AssertExact<
  z.infer<typeof UsageMetadataSchema>,
  UsageMetaData
>;

const _coreContractIsExact: CoreUsageContractMatchesDb = true;
const _metadataContractIsExact: UsageMetadataContractMatchesType = true;
void _coreContractIsExact;
void _metadataContractIsExact;
