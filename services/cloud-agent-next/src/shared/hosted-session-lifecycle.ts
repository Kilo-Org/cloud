import { z } from 'zod';

export const hostedSessionLifecycleSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('active'), generation: z.number().int().nonnegative() }).strict(),
  z
    .object({
      state: z.literal('stopping'),
      generation: z.number().int().positive(),
      requestedAt: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      state: z.literal('stopped'),
      generation: z.number().int().positive(),
      stoppedAt: z.number().int().nonnegative(),
      latestEventId: z.number().int().positive().nullable(),
    })
    .strict(),
  z
    .object({
      state: z.literal('resuming'),
      generation: z.number().int().positive(),
      requestedAt: z.number().int().nonnegative(),
    })
    .strict(),
]);

export type HostedSessionLifecycle = z.infer<typeof hostedSessionLifecycleSchema>;

export type HostedSessionLifecycleResult =
  | { type: 'session-not-found' }
  | { type: 'found'; lifecycle: HostedSessionLifecycle };
