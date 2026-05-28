import {
  CloudAgentQueueReportSchema,
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

function timestamp(value: number): string {
  return new Date(value).toISOString();
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
    },
  };
  await trySendReport(params.queue, report, {
    cloudAgentSessionId: params.cloudAgentSessionId,
    messageId: state.messageId,
    status: state.status,
  });
}
