export type SecurityAgentAdmissionAction =
  | 'sync'
  | 'dismiss_finding'
  | 'start_analysis'
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
