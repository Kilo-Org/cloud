import { describe, expect, it } from '@jest/globals';
import type {
  SecurityFindingWithRemediation,
  SecurityRemediationCapability,
} from '@/lib/security-agent/db/security-remediation';
import {
  getAnalysisPresentation,
  getDeadlinePresentation,
  getFindingAnalysisState,
} from './security-finding-list-presentation';

const baseRemediationCapability: SecurityRemediationCapability = {
  canStart: false,
  startReason: 'analysis_required',
  canRetry: false,
  retryReason: 'retry_not_allowed',
  canCancel: false,
  cancelAttemptId: null,
};

const baseFinding = {
  id: 'finding-1',
  status: 'open',
  severity: 'high',
  title: 'Command Injection in lodash',
  analysis_status: null,
  analysis: null,
  analysis_error: null,
  fixed_at: null,
  ignored_reason: null,
  sla_due_at: null,
  updated_at: '2026-06-17T12:00:00.000Z',
  remediationSummary: null,
  remediationCapability: baseRemediationCapability,
} as SecurityFindingWithRemediation;

function findingWith(
  overrides: Partial<SecurityFindingWithRemediation>
): SecurityFindingWithRemediation {
  return { ...baseFinding, ...overrides };
}

describe('Security Finding list presentation', () => {
  it('preserves analysis outcome for a closed finding', () => {
    const finding = findingWith({
      status: 'fixed',
      analysis_status: 'completed',
      analysis: {
        sandboxAnalysis: {
          isExploitable: true,
          summary: 'Reachable vulnerable path found.',
        },
      } as SecurityFindingWithRemediation['analysis'],
    });

    expect(getAnalysisPresentation(finding)).toMatchObject({
      label: 'Exploitable',
      tone: 'destructive',
    });
  });

  it('uses shared review states for failed extraction and unknown exploitability', () => {
    const extractionFailed = findingWith({
      analysis_status: 'completed',
      analysis: {
        sandboxAnalysis: {
          extractionStatus: 'failed',
          isExploitable: false,
        },
      } as SecurityFindingWithRemediation['analysis'],
    });
    const unknownExploitability = findingWith({
      analysis_status: 'completed',
      analysis: {
        sandboxAnalysis: {
          extractionStatus: 'succeeded',
          isExploitable: 'unknown',
        },
      } as SecurityFindingWithRemediation['analysis'],
    });

    expect(
      getFindingAnalysisState(extractionFailed.analysis_status, extractionFailed.analysis)
    ).toBe('extraction-failed');
    expect(getAnalysisPresentation(extractionFailed)).toMatchObject({
      label: 'Needs review',
      tone: 'warning',
    });
    expect(
      getFindingAnalysisState(unknownExploitability.analysis_status, unknownExploitability.analysis)
    ).toBe('unknown');
    expect(getAnalysisPresentation(unknownExploitability)).toMatchObject({
      label: 'Needs review',
      tone: 'warning',
    });
  });

  it('formats open SLA deadlines with urgency labels', () => {
    const now = new Date('2026-06-17T12:00:00.000Z');

    expect(
      getDeadlinePresentation(findingWith({ sla_due_at: '2026-06-16T12:00:00.000Z' }), now)
    ).toMatchObject({
      label: '1 day overdue',
      detail: 'Due Jun 16, 2026',
      tone: 'destructive',
    });
    expect(
      getDeadlinePresentation(findingWith({ sla_due_at: '2026-06-17T10:00:00.000Z' }), now)
    ).toMatchObject({
      label: 'Overdue',
      detail: 'Due Jun 17, 2026',
      tone: 'destructive',
    });
    expect(
      getDeadlinePresentation(findingWith({ sla_due_at: '2026-06-18T12:00:00.000Z' }), now)
    ).toMatchObject({
      label: 'Due tomorrow',
      detail: 'Due Jun 18, 2026',
      tone: 'warning',
    });
  });

  it('shows whether a fixed finding met its recorded deadline', () => {
    const presentation = getDeadlinePresentation(
      findingWith({
        status: 'fixed',
        sla_due_at: '2026-06-18T12:00:00.000Z',
        fixed_at: '2026-06-17T12:00:00.000Z',
      })
    );

    expect(presentation).toMatchObject({
      label: 'Fixed before deadline',
      detail: 'Fixed Jun 17, 2026',
      tone: 'success',
    });
  });
});
