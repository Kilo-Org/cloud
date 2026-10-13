import * as z from 'zod';

/**
 * Owner of an automation run (auto-triage, auto-fix, code review): an
 * organization or a personal user. `id` is the owner key (organization UUID or
 * user id); `userId` is the Kilo user the run is attributed to (the org bot
 * user, or the personal user itself).
 */
export const OwnerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('org'),
    id: z.string().uuid(),
    userId: z.string(),
  }),
  z.object({
    type: z.literal('user'),
    id: z.string(),
    userId: z.string(),
  }),
]);

export type Owner = z.infer<typeof OwnerSchema>;
