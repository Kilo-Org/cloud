import { describe, expect, it } from '@jest/globals';
import { SECURITY_OPERATION_IN_PROGRESS_MESSAGE } from '@kilocode/app-shared/security-agent';
import {
  getSecurityAgentCommandFailureTitle,
  getSecurityAgentDismissalTerminalTitle,
  isSecurityCommandInProgressError,
  manualAnalysisAdmissionCopy,
  securityAgentCommandAdmissionCopy,
  securityCommandInProgressCopy,
} from './security-agent-command-copy';

describe('securityAgentCommandAdmissionCopy', () => {
  it('uses queued admission copy for queue-backed actions', () => {
    expect(securityAgentCommandAdmissionCopy.sync.successTitle).toBe('Sync queued');
    expect(securityAgentCommandAdmissionCopy.dismiss_finding.successTitle).toBe('Dismissal queued');
    expect(securityAgentCommandAdmissionCopy.start_analysis.successTitle).toBe('Analysis queued');
    expect(securityAgentCommandAdmissionCopy.enable_initial_sync.failureDescription).toBe(
      'Initial sync not queued. Run Sync to retry.'
    );
    expect(securityAgentCommandAdmissionCopy.existing_findings_backlog.failureTitle).toBe(
      'Existing findings not queued'
    );
  });

  it('keeps legacy manual-analysis import backed by shared copy', () => {
    expect(manualAnalysisAdmissionCopy).toBe(securityAgentCommandAdmissionCopy.start_analysis);
    expect(getSecurityAgentCommandFailureTitle('start_analysis')).toBe('Failed to queue analysis');
  });

  it('describes dismissal terminal states separately from queued admission', () => {
    expect(getSecurityAgentDismissalTerminalTitle('succeeded')).toBe('Finding dismissed');
    expect(getSecurityAgentDismissalTerminalTitle('no_op')).toBe('Finding already dismissed');
  });

  it('matches the in-progress marker by exact message', () => {
    expect(
      isSecurityCommandInProgressError(new Error(SECURITY_OPERATION_IN_PROGRESS_MESSAGE))
    ).toBe(true);
    expect(isSecurityCommandInProgressError(new Error('Queue unavailable'))).toBe(false);
  });

  it('offers wait copy for queue-backed actions only', () => {
    expect(securityCommandInProgressCopy('sync')).toEqual({
      title: 'A sync is already running',
      description: 'Wait for it to finish. Findings update when it completes.',
    });
    expect(securityCommandInProgressCopy('dismiss_finding')).toEqual({
      title: 'Dismissal already in progress',
      description: 'Wait for it to finish before trying again.',
    });
    expect(securityCommandInProgressCopy('start_analysis')).toBeNull();
  });
});
