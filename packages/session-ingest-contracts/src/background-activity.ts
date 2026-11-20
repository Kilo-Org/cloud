import { z } from 'zod';

import { storedSessionIdSchema } from './kilo-session-id';

/**
 * An id this package treats as opaque: the job id and the shell id that the
 * runtime mints for a background job. They are not session ids, so the stored
 * session-id shape does not apply; only a bound is enforced so one absurd value
 * cannot reach the inventory.
 */
const activityIdSchema = z.string().min(1).max(128);
const base = {
  id: activityIdSchema,
  sessionID: storedSessionIdSchema,
  status: z.enum(['running', 'completed', 'error', 'cancelled']),
  title: z.string().optional(),
  time: z.object({ started: z.number().finite(), completed: z.number().finite().optional() }),
};
export const backgroundJobSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('shell'), ...base, shellID: activityIdSchema, command: z.string() }),
  z.object({
    kind: z.literal('subagent'),
    ...base,
    childSessionID: storedSessionIdSchema,
    agent: z.string(),
    description: z.string(),
  }),
]);
export const backgroundActivityInventorySchema = z.object({
  sessionID: storedSessionIdSchema,
  jobs: z.array(backgroundJobSchema).max(256),
  sessions: z
    .array(
      z.object({
        id: storedSessionIdSchema,
        parentID: storedSessionIdSchema.optional(),
        title: z.string().optional(),
      })
    )
    .max(256),
  waits: z
    .array(z.object({ sessionID: storedSessionIdSchema, kind: z.enum(['question', 'permission']) }))
    .max(256),
});
export type BackgroundJob = z.infer<typeof backgroundJobSchema>;
export type BackgroundActivityInventory = z.infer<typeof backgroundActivityInventorySchema>;
