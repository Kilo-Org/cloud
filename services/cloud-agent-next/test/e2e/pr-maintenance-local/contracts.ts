import { z } from 'zod';
import { cloudAgentWorktreeIdSchema } from '@kilocode/session-ingest-contracts';
import {
  watchPrMaintenanceResultSchema,
  watchPrPublicationEvidenceSchema,
} from '@kilocode/db/cloud-agent-pr-maintenance';
import { maintenanceOutcomeSchema } from '../../../src/shared/pr-maintenance.js';

export const identitySchema = z.object({
  kiloSessionId: z.string().startsWith('ses_'),
  cloudAgentSessionId: z.templateLiteral(['workspace_', z.string().uuid()]),
  messageId: z.string().startsWith('msg_'),
});
export const attemptSchema = identitySchema.extend({
  id: z.string().uuid(),
  creationOperationKey: z.string().uuid(),
  kind: z.enum(['runtime', 'question', 'stop-before-start', 'result-continuation']),
  gate: z.string(),
  questionId: z.string().optional(),
  continuationMessageId: z.string().startsWith('msg_').optional(),
});
export const stateSchema = z.object({
  version: z.literal(1),
  runId: z.string().uuid(),
  tag: z.string().regex(/^[a-z0-9-]+$/),
  userId: z.string(),
  profileId: z.string().uuid(),
  workspaceId: cloudAgentWorktreeIdSchema,
  root: identitySchema,
  integrationId: z.string().uuid(),
  watchId: z.string().uuid(),
  attempts: z.array(attemptSchema),
  bootstrapOperationKey: z.string().uuid(),
  cleaned: z.boolean().default(false),
});
export type State = z.infer<typeof stateSchema>;
export type Attempt = z.infer<typeof attemptSchema>;

export const messageSchema = z.object({
  cloudAgentSessionId: z.string(),
  messageId: z.string(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'interrupted']),
  acceptedAt: z.number().optional(),
  failureCode: z.string().optional(),
  failure: z
    .object({
      stage: z.string().max(128).optional(),
      code: z.string().max(128).optional(),
      subtype: z.string().max(128).optional(),
      message: z.string().max(4096).optional(),
    })
    .optional(),
  assistant: z
    .object({ messageId: z.string(), text: z.string().max(131_072).optional() })
    .optional(),
  maintenance: maintenanceOutcomeSchema.optional(),
});
export const maintenanceStatusSchema = z.object({
  message: messageSchema.nullable(),
  latestMessage: messageSchema.nullable(),
  waitingForInput: z.boolean(),
  stoppedAt: z.number().nullable(),
  result: watchPrMaintenanceResultSchema.nullable(),
  publication: watchPrPublicationEvidenceSchema.nullable(),
  resultMessageId: z.string().nullable().optional(),
  publicationMessageId: z.string().nullable().optional(),
  lastPublished: z
    .object({ messageId: z.string(), publication: watchPrPublicationEvidenceSchema })
    .nullable()
    .optional(),
  workspace: maintenanceOutcomeSchema.shape.workspace.unwrap().nullable().optional(),
});

export function describeMessageFailure(message: z.infer<typeof messageSchema>): string {
  const reason = [
    message.failureCode,
    message.failure?.code,
    message.failure?.stage,
    message.failure?.subtype,
    message.failure?.message,
  ].filter(Boolean);
  return `${message.status}: ${reason.length ? [...new Set(reason)].join('; ') : 'runtime supplied no safe failure reason'}`;
}

export class LocalApiError extends Error {
  constructor(
    readonly endpoint: string,
    readonly status: number,
    readonly responseError?: string
  ) {
    super(`${endpoint} returned HTTP ${status}; inspect private request evidence`);
  }
}
