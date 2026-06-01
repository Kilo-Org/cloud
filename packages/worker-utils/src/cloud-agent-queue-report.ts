import { z } from 'zod';

export const CloudAgentRunStatuses = [
  'queued',
  'accepted',
  'completed',
  'failed',
  'interrupted',
] as const;

export const CloudAgentRunFailureClassifications = [
  { failureStage: 'pre_dispatch', failureCode: 'sandbox_connect_failed' },
  { failureStage: 'pre_dispatch', failureCode: 'workspace_setup_failed' },
  { failureStage: 'pre_dispatch', failureCode: 'kilo_server_failed' },
  { failureStage: 'pre_dispatch', failureCode: 'wrapper_start_failed' },
  { failureStage: 'pre_dispatch', failureCode: 'invalid_delivery_request' },
  { failureStage: 'pre_dispatch', failureCode: 'session_metadata_missing' },
  { failureStage: 'pre_dispatch', failureCode: 'model_missing' },
  { failureStage: 'pre_dispatch', failureCode: 'delivery_failure_unknown' },
  { failureStage: 'post_dispatch_no_activity', failureCode: 'wrapper_disconnected' },
  { failureStage: 'post_dispatch_no_activity', failureCode: 'wrapper_no_output' },
  { failureStage: 'post_dispatch_no_activity', failureCode: 'wrapper_ping_timeout' },
  { failureStage: 'post_dispatch_no_activity', failureCode: 'wrapper_error_before_activity' },
  { failureStage: 'post_dispatch_no_activity', failureCode: 'missing_assistant_reply' },
  { failureStage: 'agent_activity', failureCode: 'assistant_error' },
  { failureStage: 'agent_activity', failureCode: 'wrapper_error_after_activity' },
  { failureStage: 'interruption', failureCode: 'user_interrupt' },
  { failureStage: 'interruption', failureCode: 'container_shutdown' },
  { failureStage: 'interruption', failureCode: 'system_interrupt' },
  { failureStage: 'unknown', failureCode: 'unclassified' },
] as const;

const MAX_OPERATIONAL_IDENTIFIER_LENGTH = 128;
const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 4096;
const DIAGNOSTIC_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const IsoTimestampSchema = z.string().datetime({ offset: true });
const OperationalIdentifierSchema = z.string().min(1).max(MAX_OPERATIONAL_IDENTIFIER_LENGTH);
const WrapperRunIdentifierSchema = OperationalIdentifierSchema.regex(/^wr_[A-Za-z0-9_-]+$/);
const CloudAgentFailureStageSchema = z.enum([
  'pre_dispatch',
  'post_dispatch_no_activity',
  'agent_activity',
  'interruption',
  'unknown',
]);
const CloudAgentFailureCodeSchema = z.enum([
  'sandbox_connect_failed',
  'workspace_setup_failed',
  'kilo_server_failed',
  'wrapper_start_failed',
  'invalid_delivery_request',
  'session_metadata_missing',
  'model_missing',
  'delivery_failure_unknown',
  'wrapper_disconnected',
  'wrapper_no_output',
  'wrapper_ping_timeout',
  'wrapper_error_before_activity',
  'assistant_error',
  'wrapper_error_after_activity',
  'missing_assistant_reply',
  'user_interrupt',
  'container_shutdown',
  'system_interrupt',
  'unclassified',
]);

const validFailureClassifications = new Set(
  CloudAgentRunFailureClassifications.map(
    classification => `${classification.failureStage}:${classification.failureCode}`
  )
);

const CloudAgentQueueSessionIdentitySchema = z
  .object({ cloudAgentSessionId: OperationalIdentifierSchema })
  .strict();

const CloudAgentFailedRunDiagnosticSchema = z
  .object({
    errorMessageRedacted: z.string().min(1).max(MAX_DIAGNOSTIC_MESSAGE_LENGTH),
    errorExpiresAt: IsoTimestampSchema,
  })
  .strict();

const CloudAgentRunStateSchema = z
  .object({
    messageId: OperationalIdentifierSchema,
    status: z.enum(CloudAgentRunStatuses),
    wrapperRunId: WrapperRunIdentifierSchema.optional(),
    queuedAt: IsoTimestampSchema.optional(),
    dispatchAcceptedAt: IsoTimestampSchema.optional(),
    agentActivityObservedAt: IsoTimestampSchema.optional(),
    terminalAt: IsoTimestampSchema.optional(),
    failureStage: CloudAgentFailureStageSchema.optional(),
    failureCode: CloudAgentFailureCodeSchema.optional(),
    diagnostic: CloudAgentFailedRunDiagnosticSchema.optional(),
  })
  .strict()
  .superRefine((run, ctx) => {
    const isTerminal =
      run.status === 'completed' || run.status === 'failed' || run.status === 'interrupted';
    if (isTerminal !== (run.terminalAt !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'terminalAt is required only for a terminal run state',
        path: ['terminalAt'],
      });
    }

    if ((run.failureStage === undefined) !== (run.failureCode === undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'failureStage and failureCode must be reported together',
        path: ['failureCode'],
      });
    }

    if (run.failureStage !== undefined && run.failureCode !== undefined) {
      const classificationKey = `${run.failureStage}:${run.failureCode}`;
      if (!validFailureClassifications.has(classificationKey)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Failure stage and code are not a supported classification',
          path: ['failureCode'],
        });
      }
    }

    if (run.status === 'queued' && run.dispatchAcceptedAt !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'A queued run cannot contain an observed dispatch acceptance fact',
        path: ['dispatchAcceptedAt'],
      });
    }

    if (run.status === 'accepted' && run.dispatchAcceptedAt === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'An accepted run must contain an observed dispatch acceptance fact',
        path: ['dispatchAcceptedAt'],
      });
    }

    if (!isTerminal && run.failureStage !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'Active runs cannot contain terminal failure facts',
        path: ['failureStage'],
      });
    }

    if (run.status === 'completed' && run.failureStage !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'A completed run cannot contain failure facts',
        path: ['failureStage'],
      });
    }

    if (run.status === 'failed' && run.failureStage === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'A failed run must contain typed failure facts',
        path: ['failureStage'],
      });
    }

    if (run.status === 'failed' && run.failureStage === 'interruption') {
      ctx.addIssue({
        code: 'custom',
        message: 'Interruption classifications apply only to interrupted runs',
        path: ['failureStage'],
      });
    }

    if (run.status === 'interrupted' && run.failureStage !== undefined) {
      if (run.failureStage !== 'interruption') {
        ctx.addIssue({
          code: 'custom',
          message: 'Interrupted runs may contain only interruption classifications',
          path: ['failureStage'],
        });
      }
    }

    if (run.diagnostic !== undefined) {
      if (run.status !== 'failed' || run.terminalAt === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'Diagnostics are permitted only on failed terminal runs',
          path: ['diagnostic'],
        });
        return;
      }
      const terminalTimestamp = Date.parse(run.terminalAt);
      const expiryTimestamp = Date.parse(run.diagnostic.errorExpiresAt);
      if (
        expiryTimestamp <= terminalTimestamp ||
        expiryTimestamp - terminalTimestamp > DIAGNOSTIC_RETENTION_MS
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'Diagnostic expiry must be after terminalAt and within 30 days',
          path: ['diagnostic', 'errorExpiresAt'],
        });
      }
    }
  });

export const CloudAgentQueueReportSchema = z
  .object({
    version: z.literal(1),
    type: z.literal('run.state'),
    occurredAt: IsoTimestampSchema,
    session: CloudAgentQueueSessionIdentitySchema,
    run: CloudAgentRunStateSchema,
  })
  .strict();

export type CloudAgentQueueReport = z.infer<typeof CloudAgentQueueReportSchema>;
export type CloudAgentRunStateReport = CloudAgentQueueReport;
