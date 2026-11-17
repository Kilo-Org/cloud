import { z } from 'zod';

import { positionSchema, sessionIDSchema, sessionStatusSchema, tenantSchema } from '../protocol';

export const sessionNotificationSchema = z.strictObject({
  version: z.literal(1),
  type: z.enum(['session.created', 'session.updated', 'session.status.updated', 'session.deleted']),
  session: z.strictObject({
    sessionID: sessionIDSchema,
    tenant: tenantSchema,
    revision: positionSchema,
    position: positionSchema,
    title: z.string().max(1024).nullable().optional(),
    status: sessionStatusSchema.nullable(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    deletedAt: z.number().int().nullable(),
  }),
  changedAt: z.number().int(),
});
export type SessionNotification = z.infer<typeof sessionNotificationSchema>;
