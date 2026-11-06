import * as z from 'zod';
import type {
  EnkryptGuardrailApiKind,
  EnkryptGuardrailDecision,
  EnkryptGuardrailDirection,
} from '@kilocode/db/schema-types';

/**
 * The enabled detectors cost at most 53 credits per call (`injection_attack` caps at 50), so a
 * larger header value is an Enkrypt bug. Clamping keeps the ledger insert and the balance debit
 * within column range instead of failing in the deferred write.
 */
export const MAX_ENKRYPT_CREDITS_PER_CALL = 1_000;

export const ENKRYPT_USAGE_WRITE_PATH = '/api/internal/enkrypt-usage/record';

export const EnkryptUsageWriteSchema = z.strictObject({
  id: z.uuid(),
  occurredAt: z.iso.datetime({ offset: true }),
  organizationId: z.guid(),
  kiloUserId: z.string().min(1),
  sessionId: z.string().nullable(),
  microdollarUsageId: z.uuid().optional(),
  apiKind: z.enum([
    'chat_completions',
    'messages',
    'responses',
  ] satisfies EnkryptGuardrailApiKind[]),
  decision: z.enum(['allowed', 'blocked', 'error'] satisfies EnkryptGuardrailDecision[]),
  creditsCost: z.number().nonnegative().max(MAX_ENKRYPT_CREDITS_PER_CALL).nullable(),
  addedLatencyMs: z.number().int().nonnegative().nullable(),
  /** Optional so input calls stay compatible with a gateway or web app deployed before it. */
  guardrail: z.enum(['input', 'output'] satisfies EnkryptGuardrailDirection[]).default('input'),
});

export type EnkryptUsageWrite = z.infer<typeof EnkryptUsageWriteSchema>;

export type EnkryptUsageWriteInput = z.input<typeof EnkryptUsageWriteSchema>;

/** `duplicate` means an earlier delivery of the same usage id already committed it and its debit. */
export const EnkryptUsageWriteResponseSchema = z.strictObject({
  status: z.enum(['recorded', 'duplicate']),
});

export type EnkryptUsageWriteResponse = z.infer<typeof EnkryptUsageWriteResponseSchema>;
