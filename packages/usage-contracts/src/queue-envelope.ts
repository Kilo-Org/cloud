import { z } from 'zod';

/**
 * The one tagged envelope for a non-LLM usage message on the shared usage queue: `kind` marks the
 * message and `v` is the envelope version. `kind` is what separates a tagged non-LLM message from
 * an LLM usage message, which is always sent untagged for wire compatibility.
 */
export function taggedQueueMessageSchema<Kind extends string, RecordSchema extends z.ZodType>(
  kind: Kind,
  record: RecordSchema
) {
  return z.strictObject({ kind: z.literal(kind), v: z.literal(1), record });
}
