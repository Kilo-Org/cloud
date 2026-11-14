import { z } from 'zod';

const identity = z.string().min(1).max(128);
const base = {
  id: identity,
  sessionID: identity,
  status: z.enum(['running', 'completed', 'error', 'cancelled']),
  title: z.string().optional(),
  time: z.object({ started: z.number().finite(), completed: z.number().finite().optional() }),
};
export const backgroundJobSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('shell'), ...base, shellID: identity, command: z.string() }),
  z.object({
    kind: z.literal('subagent'),
    ...base,
    childSessionID: identity,
    agent: z.string(),
    description: z.string(),
  }),
]);
export const backgroundActivityInventorySchema = z.object({
  sessionID: identity,
  jobs: z.array(backgroundJobSchema).max(256),
  sessions: z
    .array(z.object({ id: identity, parentID: identity.optional(), title: z.string().optional() }))
    .max(256),
  waits: z
    .array(z.object({ sessionID: identity, kind: z.enum(['question', 'permission']) }))
    .max(256),
});
export type BackgroundJob = z.infer<typeof backgroundJobSchema>;
export type BackgroundActivityInventory = z.infer<typeof backgroundActivityInventorySchema>;
