import type {
  CloudAgentFailureReason,
  CloudAgentFailureResponsibility,
} from '@kilocode/worker-utils/cloud-agent-failure';

export type CloudAgentHealthInterval = {
  /** Inclusive ISO datetime lower bound for observed-outcome reporting. */
  startDate: string;
  /** Exclusive ISO datetime upper bound for observed-outcome reporting. */
  endDate: string;
};

export type CloudAgentHealthError = {
  source: 'setup' | 'run';
  stage: string;
  code: string;
  responsibility: CloudAgentFailureResponsibility;
  reason: CloudAgentFailureReason;
};

export function healthErrorSessionsInput(
  interval: CloudAgentHealthInterval,
  error: CloudAgentHealthError | null
) {
  return {
    startDate: interval.startDate,
    endDate: interval.endDate,
    source: error?.source ?? ('run' as const),
    stage: error?.stage ?? 'not-selected',
    code: error?.code ?? 'not-selected',
    responsibility: error?.responsibility ?? ('unknown' as const),
    reason: error?.reason ?? ('unclassified' as const),
  };
}
