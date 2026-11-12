import { z } from 'zod';
import {
  watchPrMaintenanceResultSchema,
  watchPrPublicationEvidenceSchema,
  watchPrMaintenanceInputSchema,
  watchPrOwnedRebaseEvidenceSchema,
} from '@kilocode/db/cloud-agent-pr-maintenance';

export {
  watchPrMaintenanceResultSchema,
  watchPrPublicationEvidenceSchema,
  watchPrOwnedRebaseEvidenceSchema,
};
export type {
  WatchPrMaintenanceResult,
  WatchPrPublicationEvidence,
  WatchPrOwnedRebaseEvidence,
} from '@kilocode/db/cloud-agent-pr-maintenance';

const repository = watchPrMaintenanceInputSchema.unwrap().shape.repository;
export const maintenancePublicationTargetSchema = repository
  .pick({
    repoUrl: true,
    headRef: true,
    baseRef: true,
    baseSha: true,
  })
  .extend({ observedHeadSha: repository.shape.headSha });

export const maintenanceChatSchema = z
  .object({
    kind: z.literal('maintenance'),
    watchId: z.uuid(),
    attemptId: z.uuid(),
    publication: maintenancePublicationTargetSchema,
    allowRebase: z.boolean().optional(),
    parentCommitSha: repository.shape.parentCommitSha.optional(),
    recoverableAttemptIds: z.array(z.uuid()).max(10).optional(),
  })
  .strict();

export const sessionChatSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }).strict(),
  maintenanceChatSchema,
]);

export const maintenanceOutcomeSchema = z
  .object({
    attemptId: z.uuid(),
    messageId: z.string().min(1).max(128),
    publication: watchPrPublicationEvidenceSchema,
    result: watchPrMaintenanceResultSchema.nullable(),
    resultMessageId: z.string().min(1).max(128).optional(),
    workspace: z
      .discriminatedUnion('status', [
        z
          .object({
            status: z.literal('observed'),
            source: z.literal('git'),
            headSha: repository.shape.headSha,
            dirty: z.boolean(),
            remoteHeadSha: repository.shape.headSha,
            verifiedAt: z.string().datetime(),
          })
          .strict(),
        z
          .object({ status: z.literal('unavailable'), reason: z.string().min(1).max(2000) })
          .strict(),
      ])
      .optional(),
  })
  .strict();

export type MaintenanceChat = z.infer<typeof maintenanceChatSchema>;
export type MaintenanceOutcome = z.infer<typeof maintenanceOutcomeSchema>;
export const MAINTENANCE_PUBLICATION_EVENT = 'wrapper.maintenance.publication';
