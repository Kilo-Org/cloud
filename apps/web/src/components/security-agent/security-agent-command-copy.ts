import {
  SECURITY_OPERATION_IN_PROGRESS_MESSAGE,
  type SecurityCommandType,
} from '@kilocode/app-shared/security-agent';

export type SecurityAgentAdmissionAction =
  | SecurityCommandType
  | 'enable_initial_sync'
  | 'existing_findings_backlog';

export type SecurityAgentCommandStatus = 'accepted' | 'running' | 'succeeded' | 'failed' | 'no_op';

type SecurityAgentAdmissionCopy = {
  successTitle: string;
  successDescription?: string;
  failureTitle: string;
  failureDescription?: string;
  pendingLabel: string;
};

export const securityAgentCommandAdmissionCopy = {
  sync: {
    successTitle: 'Sync queued',
    failureTitle: 'Sync failed',
    pendingLabel: 'Syncing',
  },
  dismiss_finding: {
    successTitle: 'Dismissal queued',
    failureTitle: 'Failed to dismiss finding',
    pendingLabel: 'Queueing dismissal',
  },
  start_analysis: {
    successTitle: 'Analysis queued',
    failureTitle: 'Failed to queue analysis',
    pendingLabel: 'Queueing',
  },
  apply_auto_remediation: {
    successTitle: 'Existing remediations queued',
    failureTitle: 'Failed to queue remediations',
    pendingLabel: 'Queueing remediations',
  },
  enable_initial_sync: {
    successTitle: 'Security Agent enabled',
    successDescription: 'Initial sync queued. Findings update as processing completes.',
    failureTitle: 'Initial sync not queued',
    failureDescription: 'Initial sync not queued. Run Sync to retry.',
    pendingLabel: 'Queueing initial sync',
  },
  existing_findings_backlog: {
    successTitle: 'Existing findings queued',
    failureTitle: 'Existing findings not queued',
    pendingLabel: 'Queueing existing findings',
  },
} satisfies Record<SecurityAgentAdmissionAction, SecurityAgentAdmissionCopy>;

export const manualAnalysisAdmissionCopy = securityAgentCommandAdmissionCopy.start_analysis;

export function getSecurityAgentCommandFailureTitle(commandType: SecurityAgentAdmissionAction) {
  return securityAgentCommandAdmissionCopy[commandType].failureTitle;
}

export function getSecurityAgentDismissalTerminalTitle(status: SecurityAgentCommandStatus) {
  return status === 'no_op' ? 'Finding already dismissed' : 'Finding dismissed';
}

export type SecurityCommandInProgressCopy = { title: string; description: string };

/**
 * Toast for a submission that lost the admission race to the command already
 * in flight, so the reader waits instead of reading a raw conflict marker.
 */
export function securityCommandInProgressCopy(
  action: SecurityAgentAdmissionAction
): SecurityCommandInProgressCopy | null {
  switch (action) {
    case 'sync':
      return {
        title: 'A sync is already running',
        description: 'Wait for it to finish. Findings update when it completes.',
      };
    case 'dismiss_finding':
      return {
        title: 'Dismissal already in progress',
        description: 'Wait for it to finish before trying again.',
      };
    default:
      return null;
  }
}

/** True when the submission lost to the command already in flight. */
export function isSecurityCommandInProgressError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message === SECURITY_OPERATION_IN_PROGRESS_MESSAGE;
}

/** Toast for a submission whose identity already settled inside the window. */
export const securityCommandReplayedCopy = {
  sync: {
    title: 'Sync already ran',
    description: 'No new sync was queued. Findings update when that run completes.',
  },
  dismiss_finding: {
    title: 'Dismissal already sent',
    description: 'No new dismissal was queued.',
  },
} as const satisfies Partial<
  Record<SecurityAgentAdmissionAction, { title: string; description: string }>
>;
