import {
  CloudAgentQueueReportSchema,
  DIAGNOSTIC_RETENTION_MS,
  type CloudAgentQueueReport,
  type CloudAgentRunStateReport,
} from '@kilocode/worker-utils/cloud-agent-queue-report';
import type {
  CloudAgentAssistantFailureReason,
  CloudAgentProviderOwnership,
  WorkspaceFailureSubtype,
} from '@kilocode/worker-utils/cloud-agent-failure';
import { logger } from '../../logger.js';
import {
  assistantFailureMessage,
  workspaceFailureMessage,
} from '../../session/safe-failure-projection.js';
import {
  FAILED_RUN_DIAGNOSTIC_MESSAGES,
  buildRunStateReport,
  type RunReportAnchor,
} from '../../telemetry/queue-reports.js';
import { classifyControlPlaneRunFailure } from '../../telemetry/control-plane-failure.js';
import type { ReportAnchor } from '../../sandbox-session/report-outbox.js';
import type { SessionMessage } from './messages.js';

/**
 * Bounded assistant facts that only the outcome carries. The message row stores
 * no assistant facts (spec §5), so a report built after settlement must be told
 * them by the settling caller.
 */
export type ControlPlaneReportFacts = {
  assistantReason?: CloudAgentAssistantFailureReason;
  providerOwnership?: CloudAgentProviderOwnership;
  workspaceSubtype?: WorkspaceFailureSubtype;
};

/** The message state vocabulary maps onto the report `run.status` (spec §10). */
const REPORT_STATUS: Record<SessionMessage['state'], CloudAgentRunStateReport['run']['status']> = {
  queued: 'queued',
  accepted: 'accepted',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'interrupted',
};

/** The stored report outbox anchor as the queue report contract wants it. */
export function reportAnchorForQueue(anchor: ReportAnchor): RunReportAnchor {
  return {
    kiloSessionId: anchor.kiloSessionId,
    initialMessageId: anchor.initialMessageId,
    reportingCreatedAt: new Date(anchor.createdAt).toISOString(),
  };
}

function timestamp(value: number): string {
  return new Date(value).toISOString();
}

function diagnosticForFailure(
  message: SessionMessage,
  code: string,
  facts: ControlPlaneReportFacts
): CloudAgentRunStateReport['run']['diagnostic'] {
  let errorMessageRedacted =
    FAILED_RUN_DIAGNOSTIC_MESSAGES[code as keyof typeof FAILED_RUN_DIAGNOSTIC_MESSAGES];
  if (code === 'workspace_setup_failed') {
    errorMessageRedacted = facts.workspaceSubtype
      ? workspaceFailureMessage(facts.workspaceSubtype)
      : 'Workspace setup failed';
  } else if (code === 'assistant_error') {
    errorMessageRedacted = assistantFailureMessage(facts.assistantReason ?? 'unknown');
  }
  return {
    errorMessageRedacted: errorMessageRedacted ?? 'Run failed without a classified cause',
    errorExpiresAt: timestamp((message.settledAt ?? message.createdAt) + DIAGNOSTIC_RETENTION_MS),
  };
}

/**
 * Builds the one report a terminal message produces (spec §5, §10). Only a
 * terminal message has a report; a report that cannot be assembled from the
 * message facts returns `undefined` so a report failure never fails the turn.
 */
export function buildControlPlaneMessageReport(params: {
  cloudAgentSessionId: string;
  message: SessionMessage;
  anchor?: RunReportAnchor;
  facts?: ControlPlaneReportFacts;
  occurrenceAt?: number;
}): CloudAgentQueueReport | undefined {
  const { message } = params;
  if (message.settledAt === null) return undefined;
  const facts = params.facts ?? {};
  try {
    const run: CloudAgentRunStateReport['run'] = {
      messageId: message.messageId,
      status: REPORT_STATUS[message.state],
      queuedAt: timestamp(message.createdAt),
      ...(message.acceptedAt === null ? {} : { dispatchAcceptedAt: timestamp(message.acceptedAt) }),
      terminalAt: timestamp(message.settledAt),
    };
    if (message.state === 'failed' || message.state === 'cancelled') {
      const classification = classifyControlPlaneRunFailure({
        reason: message.reason ?? undefined,
        dispatchState: message.acceptedAt === null ? 'pre_dispatch' : 'accepted',
        status: message.state === 'cancelled' ? 'interrupted' : 'failed',
        ...(facts.assistantReason === undefined ? {} : { assistantReason: facts.assistantReason }),
        ...(facts.providerOwnership === undefined
          ? {}
          : { providerOwnership: facts.providerOwnership }),
        ...(facts.workspaceSubtype === undefined
          ? {}
          : { workspaceSubtype: facts.workspaceSubtype }),
        ...(message.intent.agent.model === undefined
          ? {}
          : { admittedModel: message.intent.agent.model }),
      });
      // The report status is owned by the mapping, never re-derived here.
      run.status = classification.reportStatus;
      run.failureStage = classification.stage;
      run.failureCode = classification.code;
      if (run.status === 'failed') {
        if (classification.responsibility !== undefined) {
          run.failureResponsibility = classification.responsibility;
        }
        if (classification.failureReason !== undefined) {
          run.failureReason = classification.failureReason;
        }
        if (classification.code === 'workspace_setup_failed' && facts.workspaceSubtype) {
          run.workspaceFailureSubtype = facts.workspaceSubtype;
        }
        run.diagnostic = diagnosticForFailure(message, classification.code, facts);
      }
    }
    const report = buildRunStateReport({
      cloudAgentSessionId: params.cloudAgentSessionId,
      ...(params.anchor === undefined ? {} : { anchor: params.anchor }),
      run,
      occurredAt: params.occurrenceAt ?? Date.now(),
    });
    const parsed = CloudAgentQueueReportSchema.safeParse(report);
    if (!parsed.success) {
      logger
        .withFields({
          sessionId: params.cloudAgentSessionId,
          messageId: message.messageId,
          issuePaths: parsed.error.issues
            .map(issue => issue.path.join('.'))
            .join(',')
            .slice(0, 512),
        })
        .warn('Cloud Agent report failed schema validation and was dropped');
      return undefined;
    }
    return parsed.data;
  } catch {
    logger
      .withFields({ sessionId: params.cloudAgentSessionId, messageId: message.messageId })
      .warn('Cloud Agent report could not be built; the turn is unaffected');
    return undefined;
  }
}
