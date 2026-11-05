import { type CloudAgentRunStateReport } from '@kilocode/worker-utils/cloud-agent-queue-report';

import {
  userVisibleFailureMessage,
  type CloudAgentFailureCode,
} from '@kilocode/worker-utils/cloud-agent-failure';

export function failedRunDiagnosticMessage(code: CloudAgentFailureCode): string {
  return userVisibleFailureMessage(code);
}

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
