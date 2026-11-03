import { type CloudAgentRunStateReport } from '@kilocode/worker-utils/cloud-agent-queue-report';

import type { CloudAgentFailureCode } from '@kilocode/worker-utils/cloud-agent-failure';

export const FAILED_RUN_DIAGNOSTIC_MESSAGES: Partial<Record<CloudAgentFailureCode, string>> = {
  sandbox_connect_failed: 'Sandbox connection failed',
  workspace_setup_failed: 'Workspace setup failed',
  kilo_server_failed: 'Kilo server failed to start',
  wrapper_start_failed: 'Wrapper failed to start',
  invalid_delivery_request: 'Queued message could not be dispatched',
  session_metadata_missing: 'Session metadata is unavailable',
  model_missing: 'No model is available for this run',
  delivery_failure_unknown: 'Message delivery outcome is unknown',
  wrapper_disconnected: 'Wrapper disconnected before completion',
  wrapper_no_output: 'Wrapper made no execution progress during the watchdog window',
  wrapper_ping_timeout: 'Wrapper health check timed out',
  wrapper_error_before_activity: 'Wrapper failed before agent activity',
  assistant_error: 'Assistant request failed',
  wrapper_error_after_activity: 'Wrapper failed after agent activity',
  missing_assistant_reply: 'No assistant reply was produced',
  payment_required: 'Model request failed: insufficient credits',
  unclassified: 'Run failed without a classified cause',
};

export type RunReportAnchor = {
  kiloSessionId?: string;
  initialMessageId?: string;
  reportingCreatedAt?: string;
};

/** Assembles a validated queue report from already-decided run facts. */
export function buildRunStateReport(params: {
  cloudAgentSessionId: string;
  anchor?: RunReportAnchor;
  run: CloudAgentRunStateReport['run'];
  occurredAt: number;
}): CloudAgentRunStateReport {
  const { anchor } = params;
  return {
    version: 1,
    type: 'run.state',
    occurredAt: new Date(params.occurredAt).toISOString(),
    session: {
      cloudAgentSessionId: params.cloudAgentSessionId,
      ...(anchor?.kiloSessionId === undefined ? {} : { kiloSessionId: anchor.kiloSessionId }),
      ...(anchor?.initialMessageId === undefined
        ? {}
        : { initialMessageId: anchor.initialMessageId }),
      ...(anchor?.reportingCreatedAt === undefined
        ? {}
        : { reportingCreatedAt: anchor.reportingCreatedAt }),
    },
    run: params.run,
  };
}
