import { describe, expect, it } from '@jest/globals';
import {
  getSecurityAgentCommandFailureTitle,
  getSecurityAgentDismissalTerminalTitle,
  manualAnalysisAdmissionCopy,
  securityAgentCommandAdmissionCopy,
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
});
