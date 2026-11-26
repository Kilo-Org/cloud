import {
  ABUSE_CLASSIFICATION,
  GatewayApiKindSchema,
  KiloOrganizationIdSchema,
} from './schema-types';
import { z } from 'zod';
import type { EnkryptUsageQueueMessage } from './enkrypt';
import type { ExaUsageQueueMessage } from './exa';

export const USAGE_CLASS_LIMIT_HEADER = 'x-usage-class-limit';

export {
  ABUSE_CLASSIFICATION,
  GatewayApiKindSchema,
  KiloOrganizationIdSchema,
} from './schema-types';
export type { AbuseClassification, GatewayApiKind, KiloOrganizationId } from './schema-types';
export { taggedQueueMessageSchema } from './queue-envelope';
export {
  EXA_ALLOWED_PATHS,
  EXA_MAX_COST_MICRODOLLARS_PER_CALL,
  EXA_USAGE_FEATURE_ID_MAX_LENGTH,
  EXA_USAGE_TYPE_MAX_LENGTH,
  EXA_USAGE_WRITE_PATH,
  ExaUsageQueueMessageSchema,
  ExaUsageRecordSchema,
  ExaUsageWriteResponseSchema,
  isExaAllowedPath,
} from './exa';
export type {
  ExaAllowedPath,
  ExaUsageQueueMessage,
  ExaUsageRecord,
  ExaUsageWriteResponse,
} from './exa';
export {
  ENKRYPT_USAGE_WRITE_PATH,
  EnkryptUsageQueueMessageSchema,
  EnkryptUsageWriteResponseSchema,
  EnkryptUsageWriteSchema,
  MAX_ENKRYPT_CREDITS_PER_CALL,
} from './enkrypt';
export type {
  EnkryptUsageQueueMessage,
  EnkryptUsageWrite,
  EnkryptUsageWriteInput,
  EnkryptUsageWriteResponse,
} from './enkrypt';

/** PostgreSQL `bigint` columns surfaced to JS as `number`. */
const bigintAsNumber = z.number().int().safe();

const CoreUsageSchema = z.object({
  id: z.uuid(),
  kilo_user_id: z.string(),
  cost: bigintAsNumber,
  input_tokens: bigintAsNumber,
  output_tokens: bigintAsNumber,
  cache_write_tokens: bigintAsNumber,
  cache_hit_tokens: bigintAsNumber,
  created_at: z.iso.datetime(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  requested_model: z.string().nullable(),
  cache_discount: bigintAsNumber.nullable(),
  has_error: z.boolean(),
  abuse_classification: z.enum(ABUSE_CLASSIFICATION),
  organization_id: KiloOrganizationIdSchema.nullable(),
  inference_provider: z.string().nullable(),
  project_id: z.string().nullable(),
});

const UsageMetadataSchema = z.object({
  id: z.string(),
  message_id: z.string(),
  created_at: z.iso.datetime(),
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
  // Like bouncer_usage_event, older gateway senders omit this additive field.
  // Default it to null so parsed metadata still satisfies UsageMetaData.
  reasoning_setting: z.string().nullable().default(null),
  // Additive like reasoning_setting: older senders omit it.
  inference_region: z.string().nullable().default(null),
  market_cost: bigintAsNumber.nullable(),
  // Additive like reasoning_setting: older senders omit it.
  non_inference_cost: bigintAsNumber.nullable().default(null),
  is_free: z.boolean().nullable(),
  abuse_delay: z.number().nullable(),
  abuse_downgraded_from: z.string().nullable(),
});

/**
 * The Bouncer usage event to enqueue in the usage-write transaction, for a request whose decide
 * verdict said `spendWatch`. `payload` is the shaped usage-event wire body; the outbox row's owner
 * is `core.kilo_user_id`.
 */
export const BouncerUsageEventEnqueueSchema = z.object({
  request_id: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
});

export type BouncerUsageEventEnqueue = z.infer<typeof BouncerUsageEventEnqueueSchema>;

/**
 * Wire contract for the web app's usage record endpoint (POST).
 *
 * The AI gateway deployment runs in both Frankfurt and SFO, while the
 * PostgreSQL primary is Frankfurt-only. The usage
 * write holds row locks on `kilocode_users` / `organizations` /
 * `organization_user_usage` across several sequential statements, so from SFO
 * the lock hold is dominated by transatlantic round trips rather than database
 * work.
 *
 * Selected usage is normally published to the configured queue transport, and
 * the production consumer calls the Frankfurt-local endpoint, which persists
 * idempotently by usage ID, so a redelivery does not create a second debit. HTTP
 * 202 means the queue accepted the event, not that a row or debit was
 * committed. Transport selection per deployment, the SFO handoff and its
 * fallback, the Frankfurt-local unselected write, and where a selected record
 * may fall back to a direct write are policy, documented once in
 * `packages/web-shared/AGENTS.md` ("AI gateway database and Redis access").
 *
 * Invariants this schema deliberately encodes:
 *
 * - Nullable fields use `.nullable()`. Except for additive rollout fields that
 *   default to null, missing keys are rejected: `JSON.stringify` drops
 *   `undefined`-valued keys, and `null` is load-bearing here.
 *   The gateway no longer extracts prompt text, so senders always send
 *   `user_prompt_prefix` and `system_prompt_prefix` as `null`, and the writer
 *   ignores both, so prompt text is never persisted.
 * - `created_at` is validated as strict ISO 8601. Both `core.created_at` and
 *   `metadata.created_at` come from `new Date().toISOString()` on the sender, so
 *   this holds by construction. It would NOT hold for a value read back out of
 *   PostgreSQL, which has shape `2026-04-29 01:16:12.945+00` — see
 *   `packages/db/AGENTS.md` "Timestamp boundaries". Keep the strict validator so
 *   a DB-shaped timestamp can never enter this path.
 * - `core.cost`, the four core token counters, `core.cache_discount`,
 *   `metadata.non_inference_cost`, `metadata.market_cost`, and
 *   `prior_microdollar_usage` (which is `kilocode_users.microdollars_used`) are
 *   PostgreSQL `bigint` mapped to JS `number`, so they are validated as safe
 *   integers.
 *
 * NUL-byte sanitization (`stripNulBytesInPlace`) happens on the sender inside
 * `toInsertableDbUsageRecord`, before serialization. `JSON.stringify` preserves
 * `\u0000` happily, so that sanitization is part of the sending contract: do not
 * move it to the receiver.
 */
export const UsageRecordRequestSchema = z.object({
  core: CoreUsageSchema,
  metadata: UsageMetadataSchema,
  prior_microdollar_usage: bigintAsNumber,
  posthog_distinct_id: z.string().nullable(),
  // Optional, unlike the fields above: a sender from before this field existed omits it, and that
  // must still record the billing row. Null or absent means no outbox row.
  bouncer_usage_event: BouncerUsageEventEnqueueSchema.nullable().optional(),
});

export type UsageRecordRequest = z.infer<typeof UsageRecordRequestSchema>;

export type LlmUsageQueueMessage = UsageRecordRequest;

/**
 * One message on the shared usage queue. The LLM variant stays an untagged
 * `UsageRecordRequest` for wire compatibility; every non-LLM usage message is
 * the tagged envelope built by `taggedQueueMessageSchema`, whose `kind` marks it
 * apart from the LLM body and whose `v` is the envelope version.
 */
export type UsageQueueMessage =
  | LlmUsageQueueMessage
  | EnkryptUsageQueueMessage
  | ExaUsageQueueMessage;

/**
 * `duplicate` means the usage row already existed, so this delivery was a retry
 * of a call that had already committed. Callers must treat it as success: the
 * row is persisted and its post-commit side effects ran on the first delivery.
 *
 * `not_recorded` mirrors today's local behaviour where `insertUsageRecord`
 * swallows database errors and returns `null`, so no row was committed.
 *
 * The status decides the shape: a `recorded` or `duplicate` reply always carries
 * the `result`, and a `not_recorded` reply carries a null `result`, so a caller
 * that checks the status never needs a null check.
 */
export const UsageRecordResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.enum(['recorded', 'duplicate']),
    result: z.object({
      // The writer echoes the inserted `microdollar_usage.id`, which is the
      // request's `core.id` (validated as a UUID above) or a generated UUID.
      usageId: z.uuid(),
      // Stays a plain string: this is read back out of PostgreSQL, so the
      // strict-ISO rule for `created_at` above does not apply. See
      // packages/db/AGENTS.md "Timestamp boundaries".
      createdAt: z.string(),
      newMicrodollarsUsed: z.number().nullable(),
    }),
  }),
  z.object({
    status: z.literal('not_recorded'),
    result: z.null(),
  }),
]);

export type UsageRecordResponse = z.infer<typeof UsageRecordResponseSchema>;
