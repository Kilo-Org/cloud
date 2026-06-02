import {
  CloudAgentQueueReportSchema,
  DIAGNOSTIC_RETENTION_MS,
  type CloudAgentQueueReport,
  type CloudAgentRunStateReport,
} from '@kilocode/worker-utils/cloud-agent-queue-report';
import { logger } from '../logger.js';
import type { SessionMessageState } from '../session/session-message-state.js';

type ReportQueue = {
  send(report: CloudAgentQueueReport): Promise<unknown>;
};

type ReportLogContext = {
  cloudAgentSessionId: string;
  messageId: string;
  status: string;
};

const INSUFFICIENT_CREDIT_TERMINAL_ERRORS = new Set([
  'insufficient credits',
  'insufficient credits: payment_required',
  'insufficient credits: insufficient_funds',
  'payment required',
  'usage_limit_exceeded',
]);
const FAILED_RUN_DIAGNOSTIC_MESSAGES: Partial<
  Record<NonNullable<SessionMessageState['failureCode']>, string>
> = {
  sandbox_connect_failed: 'Sandbox connection failed',
  workspace_setup_failed: 'Workspace setup failed',
  kilo_server_failed: 'Kilo server failed to start',
  wrapper_start_failed: 'Wrapper failed to start',
  invalid_delivery_request: 'Queued message could not be dispatched',
  session_metadata_missing: 'Session metadata is unavailable',
  model_missing: 'No model is available for this run',
  delivery_failure_unknown: 'Message delivery outcome is unknown',
  wrapper_disconnected: 'Wrapper disconnected before completion',
  wrapper_no_output: 'Wrapper produced no output before timeout',
  wrapper_ping_timeout: 'Wrapper health check timed out',
  wrapper_error_before_activity: 'Wrapper failed before agent activity',
  assistant_error: 'Assistant request failed',
  wrapper_error_after_activity: 'Wrapper failed after agent activity',
  missing_assistant_reply: 'No assistant reply was produced',
  unclassified: 'Run failed without a classified cause',
};

function timestamp(value: number): string {
  return new Date(value).toISOString();
}

function isKnownInsufficientCreditFailure(state: SessionMessageState): boolean {
  if (
    state.failureCode !== 'assistant_error' &&
    state.failureCode !== 'wrapper_error_before_activity' &&
    state.failureCode !== 'wrapper_error_after_activity'
  ) {
    return false;
  }
  if (state.error === undefined) return false;
  return INSUFFICIENT_CREDIT_TERMINAL_ERRORS.has(state.error.trim().toLowerCase());
}

function diagnosticForFailedRun(
  state: SessionMessageState
): CloudAgentRunStateReport['run']['diagnostic'] | undefined {
  if (state.status !== 'failed' || state.terminalAt === undefined) return undefined;

  let errorMessageRedacted =
    state.failureCode === undefined ? undefined : FAILED_RUN_DIAGNOSTIC_MESSAGES[state.failureCode];
  if (
    state.failureCode === 'workspace_setup_failed' &&
    state.error?.toLowerCase().includes('no space left on device')
  ) {
    errorMessageRedacted = 'Workspace setup failed: sandbox storage full';
  } else if (isKnownInsufficientCreditFailure(state)) {
    errorMessageRedacted = 'Model request failed: insufficient credits';
  }
  if (errorMessageRedacted === undefined) return undefined;

  return {
    errorMessageRedacted,
    errorExpiresAt: timestamp(state.terminalAt + DIAGNOSTIC_RETENTION_MS),
  };
}

function logReportFailure(context: ReportLogContext, phase: 'validation' | 'send'): void {
  logger
    .withFields({
      sessionId: context.cloudAgentSessionId,
      messageId: context.messageId,
      reportType: 'run.state',
      reportStatus: context.status,
      reportFailurePhase: phase,
    })
    .warn('Cloud Agent report emission skipped');
}

async function trySendReport(
  queue: ReportQueue | undefined,
  report: unknown,
  context: ReportLogContext
): Promise<void> {
  if (!queue) return;
  const validated = CloudAgentQueueReportSchema.safeParse(report);
  if (!validated.success) {
    logReportFailure(context, 'validation');
    return;
  }
  try {
    await queue.send(validated.data);
  } catch {
    logReportFailure(context, 'send');
  }
}

export async function emitRunStateReport(params: {
  queue?: ReportQueue;
  cloudAgentSessionId: string;
  state: SessionMessageState;
  occurredAt?: number;
}): Promise<void> {
  const { state } = params;
  const observedDispatchAcceptedAt =
    state.dispatchAcceptanceKind === 'observed' ? state.acceptedAt : undefined;
  const diagnostic = diagnosticForFailedRun(state);
  const report: CloudAgentRunStateReport = {
    version: 1,
    type: 'run.state',
    occurredAt: new Date(params.occurredAt ?? Date.now()).toISOString(),
    session: { cloudAgentSessionId: params.cloudAgentSessionId },
    run: {
      messageId: state.messageId,
      status: state.status,
      ...(state.wrapperRunId === undefined ? {} : { wrapperRunId: state.wrapperRunId }),
      ...(state.queuedAt === undefined ? {} : { queuedAt: timestamp(state.queuedAt) }),
      ...(observedDispatchAcceptedAt === undefined
        ? {}
        : { dispatchAcceptedAt: timestamp(observedDispatchAcceptedAt) }),
      ...(state.agentActivityObservedAt === undefined
        ? {}
        : { agentActivityObservedAt: timestamp(state.agentActivityObservedAt) }),
      ...(state.terminalAt === undefined ? {} : { terminalAt: timestamp(state.terminalAt) }),
      ...(state.failureStage === undefined ? {} : { failureStage: state.failureStage }),
      ...(state.failureCode === undefined ? {} : { failureCode: state.failureCode }),
      ...(diagnostic === undefined ? {} : { diagnostic }),
    },
  };
  await trySendReport(params.queue, report, {
    cloudAgentSessionId: params.cloudAgentSessionId,
    messageId: state.messageId,
    status: state.status,
  });
}
