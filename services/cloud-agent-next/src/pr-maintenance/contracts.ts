import { z } from 'zod';
import { cloudAgentWorktreeIdSchema, sessionIdSchema } from '@kilocode/session-ingest-contracts';
import { MessageIdSchema } from '../router/schemas.js';
import { maintenancePublicationTargetSchema } from '../shared/pr-maintenance.js';

export const maintenanceOwnerSchema = z
  .object({
    userId: z.string().min(1).max(256),
    organizationId: z.uuid().optional(),
    worktreeId: cloudAgentWorktreeIdSchema,
  })
  .strict();

export const maintenanceStartSchema = maintenanceOwnerSchema
  .extend({
    watchId: z.uuid(),
    attemptId: z.uuid(),
    creationOperationKey: z.uuid(),
    kiloSessionId: sessionIdSchema,
    cloudAgentSessionId: z.templateLiteral(['workspace_', z.uuid()]),
    messageId: MessageIdSchema,
    prompt: z.string().min(1).max(300_000),
    model: z.string().min(1).max(200),
    variant: z.string().max(100).optional(),
    profileId: z.uuid().nullable(),
    environmentId: z.uuid().nullable(),
    runtimeToken: z.string().min(1).max(65_536),
    runtimeAuthorizationSeal: z.string().min(1).max(65_536),
    publication: maintenancePublicationTargetSchema,
    allowRebase: z.boolean().optional(),
    recoverableAttemptIds: z.array(z.uuid()).max(10).optional(),
    parentCommitSha: z
      .string()
      .regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/)
      .nullable()
      .optional(),
  })
  .strict();

export const maintenanceStatusSchema = z
  .object({
    userId: z.string().min(1).max(256),
    cloudAgentSessionId: z.templateLiteral(['workspace_', z.uuid()]),
    messageId: MessageIdSchema,
  })
  .strict();

export const maintenanceStopSchema = maintenanceStatusSchema
  .extend({
    watchId: z.uuid().optional(),
    attemptId: z.uuid().optional(),
  })
  .refine(
    value => (value.watchId === undefined) === (value.attemptId === undefined),
    'Stop needs both maintenance identities'
  );

export const maintenanceScheduleSchema = z
  .object({
    watchId: z.uuid(),
    dueAt: z.string().datetime(),
  })
  .strict();

export const maintenanceDispatchResponseSchema = z
  .object({
    scheduled: z.array(maintenanceScheduleSchema).max(20),
    nextDueAt: z.string().datetime().optional(),
  })
  .strict();

export type MaintenanceStart = z.infer<typeof maintenanceStartSchema>;
