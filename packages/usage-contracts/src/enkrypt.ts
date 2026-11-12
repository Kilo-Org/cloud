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
  /**
   * UTF-16 code units this call sent to Enkrypt: the part no cached verdict covers, plus an overlap
   * of already-scanned text. Optional so writes from a gateway deployed before it stay valid.
   */
  scannedCharacters: z.int32().nonnegative().optional(),
  /**
   * UTF-16 code units of the full text the scan covers: one tool definition, the system prompt, or
   * the conversation of the request, or the response, including what the verdict cache covered.
   * Optional like `scannedCharacters`.
   */
  totalCharacters: z.int32().nonnegative().optional(),
});

export type EnkryptUsageWrite = z.infer<typeof EnkryptUsageWriteSchema>;

export type EnkryptUsageWriteInput = z.input<typeof EnkryptUsageWriteSchema>;

/**
 * `duplicate` means an earlier delivery of the same usage id already committed it and its debit.
 * `usageId` echoes the written id. It is optional so a sender accepts replies from a writer
 * deployed before the echo; a sender that receives it must check that it matches.
 */
export const EnkryptUsageWriteResponseSchema = z.strictObject({
  status: z.enum(['recorded', 'duplicate']),
  usageId: z.uuid().optional(),
});

export type EnkryptUsageWriteResponse = z.infer<typeof EnkryptUsageWriteResponseSchema>;

/**
 * Body of an Enkrypt usage message on the shared usage queue. The kind tag is what separates it
 * from an LLM usage message, which is always sent untagged.
 */
export const EnkryptUsageQueueMessageSchema = z.strictObject({
  kind: z.literal('enkrypt_usage'),
  v: z.literal(1),
  record: EnkryptUsageWriteSchema,
});

export type EnkryptUsageQueueMessage = z.infer<typeof EnkryptUsageQueueMessageSchema>;
