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

// The resolve intent must carry the same reason the matching raise would
// have. Without a reason, an out-of-order resolve arriving before a raise
// cannot insert a tombstone with the correct `reason`, and the
// outbox-level "preserve original reason" rule has nothing to compare
// against. `action_required` is intentionally excluded — the shared
// reason stays available in the schema, but the raw Kilo contract does
// not yet expose a stable request id and genuinely user-actionable typed
// action, so the producer ignores it.
export const attentionIntentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('raise'), reason: attentionReasonSchema }),
  z.object({ kind: z.literal('resolve'), reason: attentionReasonSchema }),
]);
export type AttentionIntentInput = z.infer<typeof attentionIntentSchema>;

export const recordAttentionEventInputSchema = z.object({
  kiloUserId: z.string().min(1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  intent: attentionIntentSchema,
});
export type RecordAttentionEventInput = z.infer<typeof recordAttentionEventInputSchema>;
