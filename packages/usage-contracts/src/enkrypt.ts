import * as z from 'zod';

/**
 * The enabled detectors cost at most 53 credits per call (`injection_attack` caps at 50), so a
 * larger header value is an Enkrypt bug. Clamping keeps the ledger insert and the balance debit
 * within column range instead of failing in the deferred write.
 */
export const MAX_ENKRYPT_CREDITS_PER_CALL = 1_000;

export const ENKRYPT_USAGE_WRITE_PATH = '/api/internal/enkrypt-usage/record';

/**
 * `ENKRYPT_DETECTOR_IDS` from `@kilocode/db/schema-types`, which this package cannot import;
 * `usage-record-contract-alignment.ts` checks that they match.
 */
const ENKRYPT_DETECTOR_IDS = [
  'injection_attack',
  'pii',
  'keyword_detector',
  'topic_detector',
  'policy_violation',
  'toxicity',
  'nsfw',
  'bias',
  'sponge_attack',
] as const;

/**
 * Wire contract for `POST /api/internal/enkrypt-usage/record`.
 *
 * `id` and `occurredAt` are fixed once per Enkrypt call and are the writer's idempotency key, so
 * every resend must reuse them. `organizationId` accepts any GUID rather than only RFC UUIDs, so
 * existing organizations are never rejected; do not tighten it without checking stored ids.
 */
export const EnkryptUsageWriteSchema = z.strictObject({
  id: z.uuid(),
  occurredAt: z.iso.datetime({ offset: true }),
  organizationId: z.guid(),
  kiloUserId: z.string().min(1),
  sessionId: z.string().nullable(),
  microdollarUsageId: z.uuid().optional(),
  apiKind: z.enum(['chat_completions', 'messages', 'responses']),
  decision: z.enum(['allowed', 'blocked', 'error']),
  creditsCost: z.number().nonnegative().max(MAX_ENKRYPT_CREDITS_PER_CALL).nullable(),
  addedLatencyMs: z.number().int().nonnegative().nullable(),
  /** Optional so input calls stay compatible with a gateway or web app deployed before it. */
  guardrail: z.enum(['input', 'output']).default('input'),
  /**
   * The detectors that fired on this call, blocking or log-only. Omitted when none fired, so a
   * call without a detection stays compatible with a web app deployed before the field.
   */
  detectorsFired: z.array(z.enum(ENKRYPT_DETECTOR_IDS)).nonempty().optional(),
});

export type EnkryptUsageWrite = z.infer<typeof EnkryptUsageWriteSchema>;

export type EnkryptUsageWriteInput = z.input<typeof EnkryptUsageWriteSchema>;

/** `duplicate` means an earlier delivery of the same usage id already committed it and its debit. */
export const EnkryptUsageWriteResponseSchema = z.strictObject({
  status: z.enum(['recorded', 'duplicate']),
});

export type EnkryptUsageWriteResponse = z.infer<typeof EnkryptUsageWriteResponseSchema>;
