import * as z from 'zod';
import { MAX_ENKRYPT_CREDITS_PER_CALL } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detect';
import type { EnkryptGuardrailApiKind, EnkryptGuardrailDecision } from '@kilocode/db/schema-types';

export const ENKRYPT_USAGE_WRITE_PATH = '/api/internal/enkrypt-usage/record';

export const EnkryptUsageWriteSchema = z.strictObject({
  id: z.uuid(),
  occurredAt: z.iso.datetime({ offset: true }),
  organizationId: z.guid(),
  kiloUserId: z.string().min(1),
  sessionId: z.string().nullable(),
  apiKind: z.enum([
    'chat_completions',
    'messages',
    'responses',
  ] satisfies EnkryptGuardrailApiKind[]),
  decision: z.enum(['allowed', 'blocked', 'error'] satisfies EnkryptGuardrailDecision[]),
  creditsCost: z.number().nonnegative().max(MAX_ENKRYPT_CREDITS_PER_CALL).nullable(),
  addedLatencyMs: z.number().int().nonnegative().nullable(),
});

export type EnkryptUsageWrite = z.infer<typeof EnkryptUsageWriteSchema>;

/** `duplicate` means an earlier delivery of the same usage id already committed it and its debit. */
export const EnkryptUsageWriteResponseSchema = z.strictObject({
  status: z.enum(['recorded', 'duplicate']),
});

export type EnkryptUsageWriteResponse = z.infer<typeof EnkryptUsageWriteResponseSchema>;
