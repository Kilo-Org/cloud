/**
 * Runtime-validated input for `SessionIngestDO.recordAttentionEvent`.
 *
 * The DO only accepts IDs and a classified raise/resolve intent — it never
 * sees prompt text, permission arguments, or any other envelope payload. The
 * notifications service renders copy and looks up presence; this DO is
 * responsible for turning the producer's per-request signal into a durable
 * outbox row.
 */
import { z } from 'zod';

import { attentionReasonSchema } from '../attention-outbox';

export const attentionIntentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('raise'), reason: attentionReasonSchema }),
  z.object({ kind: z.literal('resolve') }),
]);
export type AttentionIntentInput = z.infer<typeof attentionIntentSchema>;

export const recordAttentionEventInputSchema = z.object({
  kiloUserId: z.string().min(1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  intent: attentionIntentSchema,
});
export type RecordAttentionEventInput = z.infer<typeof recordAttentionEventInputSchema>;
