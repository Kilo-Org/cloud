/* eslint-disable max-lines -- one file testing the whole ported security-agent
   presentation module (list/deadline + details/analysis/remediation); the
   coverage is the point, splitting by describe block would just scatter it. */
import { describe, expect, it } from 'vitest';

import {
  formatRemediationOrigin,
  formatValidationEvidenceEntry,
  getDismissalReasonLabel,
  getFindingLifecycleStatusPresentation,
  getFindingSeverityPresentation,
  getFindingSourceLabel,
  getRemediationStatusPresentation,
  getRemediationUnavailableCopy,
  getSecurityAnalysisDetailPresentation,
  getSecurityAnalysisPresentation,
  getSecurityDeadlinePresentation,
  getSecurityFindingAnalysisState,
  getSupersedingFindingId,
  isActiveRemediationStatus,
  type SecurityFinding,
  type SecurityFindingAnalysis,
} from './presentation';

type SandboxAnalysis = NonNullable<SecurityFindingAnalysis['sandboxAnalysis']>;
type Triage = NonNullable<SecurityFindingAnalysis['triage']>;

// Minimal fixture for the structural SecurityFinding type — only the fields
// the list-scoped presentation helpers read are meaningful here.
function makeFinding(overrides: Partial<SecurityFinding> = {}): SecurityFinding {
  return {
    status: 'open',
    ignored_reason: null,
    analysis_status: null,
    analysis_error: null,
    analysis: null,
    sla_due_at: null,
    fixed_at: null,
    updated_at: '2026-07-01 00:00:00+00',
    ...overrides,
  };
}

function makeSandbox(overrides: Partial<SandboxAnalysis> = {}): SandboxAnalysis {
  return {
    isExploitable: false,
    exploitabilityReasoning: '',
    summary: '',
    ...overrides,
  };
}
function makeTriage(overrides: Partial<Triage> = {}): Triage {
  return {
    needsSandboxReasoning: '',
    suggestedAction: 'analyze_codebase',
    ...overrides,
  };
}
function makeAnalysis(overrides: Partial<SecurityFindingAnalysis> = {}): SecurityFindingAnalysis {
  return { ...overrides };
}

describe('getSecurityFindingAnalysisState', () => {
  it.each<[string, string | null, SecurityFindingAnalysis | null]>([
    ['queued', 'pending', null],
    ['analyzing', 'running', null],
    ['failed', 'failed', null],
    [
      'extraction-failed',
      'completed',
      makeAnalysis({ sandboxAnalysis: makeSandbox({ extractionStatus: 'failed' }) }),
    ],
    [
      'exploitable',
      'completed',
      makeAnalysis({ sandboxAnalysis: makeSandbox({ isExploitable: true }) }),
    ],
    [
      'not-exploitable',
      'completed',
      makeAnalysis({ sandboxAnalysis: makeSandbox({ isExploitable: false }) }),
    ],
    [
      'unknown',
      'completed',
      makeAnalysis({ sandboxAnalysis: makeSandbox({ isExploitable: 'unknown' }) }),
    ],
    [
      'safe-to-dismiss',
      'completed',
      makeAnalysis({ triage: makeTriage({ suggestedAction: 'dismiss' }) }),
    ],
    [
      'manual-review',
      'completed',
      makeAnalysis({ triage: makeTriage({ suggestedAction: 'manual_review' }) }),
    ],
    [
      'analysis-required',
      'completed',
      makeAnalysis({ triage: makeTriage({ suggestedAction: 'analyze_codebase' }) }),
    ],
    ['completed', 'completed', null],
    ['not-analyzed', null, null],
  ])('reports %s as the analysis state', (expected, analysisStatus, analysis) => {
    expect(getSecurityFindingAnalysisState(analysisStatus, analysis)).toBe(expected);
  });
});

describe('getSecurityAnalysisPresentation', () => {
  it('presents a queued analysis as a spinning warning', () => {
    const presentation = getSecurityAnalysisPresentation(
      makeFinding({ analysis_status: 'pending' })
    );
    expect(presentation).toMatchObject({
      label: 'Analysis queued',
      tone: 'warning',
      icon: 'loader',
      spinning: true,
    });
  });

  it('presents an in-progress analysis as a spinning warning', () => {
    const presentation = getSecurityAnalysisPresentation(
      makeFinding({ analysis_status: 'running' })
    );
    expect(presentation).toMatchObject({
      label: 'Analyzing',
      tone: 'warning',
      icon: 'loader',
      spinning: true,
    });
  });

  it('presents a failed analysis as danger with the error as tooltip', () => {
    const presentation = getSecurityAnalysisPresentation(
      makeFinding({ analysis_status: 'failed', analysis_error: 'sandbox timed out' })
    );
    expect(presentation).toMatchObject({
      label: 'Analysis failed',
      tone: 'danger',
      icon: 'x-circle',
      tooltip: 'sandbox timed out',
    });
  });

  it('presents extraction failures as a warning needing review', () => {
    const presentation = getSecurityAnalysisPresentation(
      makeFinding({
        analysis_status: 'completed',
        analysis: makeAnalysis({ sandboxAnalysis: makeSandbox({ extractionStatus: 'failed' }) }),
      })
    );
    expect(presentation).toMatchObject({ label: 'Needs review', tone: 'warning', icon: 'eye' });
  });

  it('presents confirmed exploitability as danger', () => {
    const presentation = getSecurityAnalysisPresentation(
      makeFinding({
        analysis_status: 'completed',
        analysis: makeAnalysis({
          sandboxAnalysis: makeSandbox({
            isExploitable: true,
            summary: 'Reachable from public API',
          }),
        }),
      })
    );
    expect(presentation).toMatchObject({
      label: 'Exploitable',
      tone: 'danger',
      icon: 'shield-alert',
      tooltip: 'Reachable from public API',
    });
  });

  it('presents ruled-out exploitability as success', () => {
    const presentation = getSecurityAnalysisPresentation(
      makeFinding({
        analysis_status: 'completed',
        analysis: makeAnalysis({ sandboxAnalysis: makeSandbox({ isExploitable: false }) }),
      })
    );
    expect(presentation).toMatchObject({
      label: 'Unreachable',
      tone: 'success',
      icon: 'shield-check',
    });
  });

  it('presents unresolved exploitability as a warning needing review', () => {
    const presentation = getSecurityAnalysisPresentation(
      makeFinding({
        analysis_status: 'completed',
        analysis: makeAnalysis({ sandboxAnalysis: makeSandbox({ isExploitable: 'unknown' }) }),
      })
    );
    expect(presentation).toMatchObject({ label: 'Needs review', tone: 'warning', icon: 'eye' });
  });

  it('presents a safe-to-dismiss triage as success', () => {
    const presentation = getSecurityAnalysisPresentation(
      makeFinding({
        analysis_status: 'completed',
        analysis: makeAnalysis({ triage: makeTriage({ suggestedAction: 'dismiss' }) }),
      })
    );
    expect(presentation).toMatchObject({
      label: 'Safe to dismiss',
      tone: 'success',
      icon: 'shield-check',
    });
  });

  it('presents a manual-review triage as a warning', () => {
    const presentation = getSecurityAnalysisPresentation(
      makeFinding({
        analysis_status: 'completed',
        analysis: makeAnalysis({ triage: makeTriage({ suggestedAction: 'manual_review' }) }),
      })
    );
    expect(presentation).toMatchObject({ label: 'Needs review', tone: 'warning', icon: 'eye' });
  });

  it('presents a triage requiring codebase analysis as a warning', () => {
    const presentation = getSecurityAnalysisPresentation(
      makeFinding({
        analysis_status: 'completed',
        analysis: makeAnalysis({ triage: makeTriage({ suggestedAction: 'analyze_codebase' }) }),
      })
    );
    expect(presentation).toMatchObject({
      label: 'Analysis required',
      tone: 'warning',
      icon: 'brain',
    });
  });

  it('presents a finished analysis with no outcome as neutral', () => {
    const presentation = getSecurityAnalysisPresentation(
      makeFinding({ analysis_status: 'completed', analysis: null })
    );
    expect(presentation).toMatchObject({ label: 'Analyzed', tone: 'neutral', icon: 'shield' });
  });

  it('presents an unanalyzed finding as neutral', () => {
    const presentation = getSecurityAnalysisPresentation(makeFinding({ analysis_status: null }));
    expect(presentation).toMatchObject({ label: 'Not analyzed', tone: 'neutral', icon: 'brain' });
  });
});

describe('getSecurityDeadlinePresentation', () => {
  const now = new Date('2026-07-08 12:00:00+00');

  it('marks a finding fixed before its deadline as success', () => {
    const finding = makeFinding({
      status: 'fixed',
      fixed_at: '2026-07-01 12:00:00+00',
      sla_due_at: '2026-07-05 12:00:00+00',
    });
    expect(getSecurityDeadlinePresentation(finding, now)).toMatchObject({
      label: 'Fixed before deadline',
      tone: 'success',
      icon: 'check-circle',
    });
  });

  it('marks a finding fixed after its deadline as neutral', () => {
    const finding = makeFinding({
      status: 'fixed',
      fixed_at: '2026-07-06 12:00:00+00',
      sla_due_at: '2026-07-05 12:00:00+00',
    });
    expect(getSecurityDeadlinePresentation(finding, now)).toMatchObject({
      label: 'Fixed',
      tone: 'neutral',
      icon: 'clock',
    });
  });

  it('labels a superseded ignored finding distinctly from a dismissed one', () => {
    const superseded = makeFinding({
      status: 'ignored',
      ignored_reason: 'superseded:new-finding-id',
    });
    const dismissed = makeFinding({ status: 'ignored', ignored_reason: 'not_exploitable' });
    expect(getSecurityDeadlinePresentation(superseded, now)).toMatchObject({ label: 'Superseded' });
    expect(getSecurityDeadlinePresentation(dismissed, now)).toMatchObject({ label: 'Dismissed' });
  });

  it('reports no deadline set when sla_due_at is null', () => {
    const finding = makeFinding({ status: 'open', sla_due_at: null });
    expect(getSecurityDeadlinePresentation(finding, now)).toMatchObject({
      label: 'Deadline not set',
      tone: 'neutral',
    });
  });

  it.each<[string, string, string]>([
    ['1 day overdue', '2026-07-07 12:00:00+00', '1 day overdue'],
    ['plural days overdue', '2026-07-04 12:00:00+00', '4 days overdue'],
    ['due today', '2026-07-08 20:00:00+00', 'Due today'],
    ['due tomorrow', '2026-07-09 12:00:00+00', 'Due tomorrow'],
    ['due in 3 days (within warning window)', '2026-07-11 12:00:00+00', 'Due in 3 days'],
    ['due in 12 days (beyond warning window)', '2026-07-20 12:00:00+00', 'Due in 12 days'],
  ])('reports %s', (_description, slaDueAt, expectedLabel) => {
    const finding = makeFinding({ status: 'open', sla_due_at: slaDueAt });
    expect(getSecurityDeadlinePresentation(finding, now).label).toBe(expectedLabel);
  });

  it('tones overdue findings as danger and near-term deadlines as warning', () => {
    const overdue = makeFinding({ status: 'open', sla_due_at: '2026-07-07 12:00:00+00' });
    const dueToday = makeFinding({ status: 'open', sla_due_at: '2026-07-08 20:00:00+00' });
    const farOut = makeFinding({ status: 'open', sla_due_at: '2026-07-20 12:00:00+00' });
    expect(getSecurityDeadlinePresentation(overdue, now)).toMatchObject({
      tone: 'danger',
      icon: 'alert-triangle',
    });
    expect(getSecurityDeadlinePresentation(dueToday, now)).toMatchObject({ tone: 'warning' });
    expect(getSecurityDeadlinePresentation(farOut, now)).toMatchObject({ tone: 'neutral' });
  });
});

// Ported from FindingDetailDialog.tsx:552 (getFindingDetailsPresentation) and
// its small formatting helpers — condensed to text/tone data for the mobile
// details panel rather than the web hero/action/facts narrative structure.
describe('getFindingSeverityPresentation', () => {
  it.each<[string, string, string]>([
    ['critical', 'Critical', 'danger'],
    ['high', 'High', 'warning'],
    ['medium', 'Medium', 'warning'],
    ['low', 'Low', 'neutral'],
    ['unknown-severity', 'unknown-severity', 'neutral'],
  ])('presents %s severity', (severity, label, tone) => {
    expect(getFindingSeverityPresentation(severity)).toMatchObject({ label, tone });
  });
});

describe('getFindingLifecycleStatusPresentation', () => {
  it('labels an open finding', () => {
    expect(getFindingLifecycleStatusPresentation(makeFinding({ status: 'open' }))).toMatchObject({
      label: 'Open',
      tone: 'neutral',
    });
  });

  it('labels a fixed finding as success', () => {
    expect(getFindingLifecycleStatusPresentation(makeFinding({ status: 'fixed' }))).toMatchObject({
      label: 'Fixed',
      tone: 'success',
    });
  });

  it('labels a dismissed finding', () => {
    expect(
      getFindingLifecycleStatusPresentation(
        makeFinding({ status: 'ignored', ignored_reason: 'not_exploitable' })
      )
    ).toMatchObject({ label: 'Dismissed', tone: 'neutral' });
  });

  it('labels a superseded finding distinctly from a plain dismissal', () => {
    expect(
      getFindingLifecycleStatusPresentation(
        makeFinding({ status: 'ignored', ignored_reason: 'superseded:finding-2' })
      )
    ).toMatchObject({ label: 'Superseded', tone: 'neutral' });
  });
});

describe('getSupersedingFindingId', () => {
  it('extracts the finding id from a superseded ignored_reason', () => {
    expect(
      getSupersedingFindingId(
        makeFinding({ status: 'ignored', ignored_reason: 'superseded:finding-2' })
      )
    ).toBe('finding-2');
  });

  it('returns null for a non-superseded finding', () => {
    expect(
      getSupersedingFindingId(makeFinding({ status: 'ignored', ignored_reason: 'not_exploitable' }))
    ).toBeNull();
    expect(getSupersedingFindingId(makeFinding({ status: 'open' }))).toBeNull();
  });
});

describe('getDismissalReasonLabel', () => {
  it.each<[string | null, string]>([
    ['fix_started', 'a fix has already started'],
    ['not_used', 'vulnerable code is not used'],
    ['some_custom_reason', 'some custom reason'],
    [null, 'after review'],
  ])('labels %s', (reason, label) => {
    expect(getDismissalReasonLabel(reason)).toBe(label);
  });
});

describe('getFindingSourceLabel', () => {
  it('renames dependabot to its display name', () => {
    expect(getFindingSourceLabel('dependabot')).toBe('GitHub Dependabot');
  });

  it('humanizes other source identifiers', () => {
    expect(getFindingSourceLabel('pnpm_audit')).toBe('pnpm audit');
  });
});

// Ported from FindingDetailDialog.tsx:985 (getAnalysisPresentation) — a
// single title/description/tone/icon object per analysis state instead of
// the web hero/summary/action/steps narrative (Task 7 owns action buttons).
describe('getSecurityAnalysisDetailPresentation', () => {
  it('presents queued analysis', () => {
    expect(getSecurityAnalysisDetailPresentation('pending', null, null)).toMatchObject({
      title: 'Analysis queued',
      tone: 'warning',
      icon: 'loader',
    });
  });

  it('presents running analysis', () => {
    expect(getSecurityAnalysisDetailPresentation('running', null, null)).toMatchObject({
      title: 'Analyzing',
      tone: 'warning',
      icon: 'loader',
    });
  });

  it('presents a failed analysis with the recorded error', () => {
    expect(
      getSecurityAnalysisDetailPresentation('failed', null, 'sandbox timed out')
    ).toMatchObject({
      title: 'Analysis failed',
      tone: 'danger',
      icon: 'x-circle',
      description: 'sandbox timed out',
    });
  });

  it('falls back to a default description when a failure has no recorded error', () => {
    expect(getSecurityAnalysisDetailPresentation('failed', null, null).description).not.toBe('');
  });

  it('presents an extraction failure', () => {
    const analysis = makeAnalysis({ sandboxAnalysis: makeSandbox({ extractionStatus: 'failed' }) });
    expect(getSecurityAnalysisDetailPresentation('completed', analysis, null)).toMatchObject({
      title: 'Needs review',
      tone: 'warning',
      icon: 'eye',
    });
  });

  it('presents confirmed exploitability', () => {
    const analysis = makeAnalysis({
      sandboxAnalysis: makeSandbox({ isExploitable: true, summary: 'Reachable from public API' }),
    });
    expect(getSecurityAnalysisDetailPresentation('completed', analysis, null)).toMatchObject({
      title: 'Exploitable',
      tone: 'danger',
      icon: 'shield-alert',
      description: 'Reachable from public API',
    });
  });

  it('presents ruled-out exploitability', () => {
    const analysis = makeAnalysis({ sandboxAnalysis: makeSandbox({ isExploitable: false }) });
    expect(getSecurityAnalysisDetailPresentation('completed', analysis, null)).toMatchObject({
      title: 'Unreachable',
      tone: 'success',
      icon: 'shield-check',
    });
  });

  it('presents unresolved exploitability', () => {
    const analysis = makeAnalysis({ sandboxAnalysis: makeSandbox({ isExploitable: 'unknown' }) });
    expect(getSecurityAnalysisDetailPresentation('completed', analysis, null)).toMatchObject({
      title: 'Needs review',
      tone: 'warning',
      icon: 'eye',
    });
  });

  it('presents a safe-to-dismiss triage', () => {
    const analysis = makeAnalysis({ triage: makeTriage({ suggestedAction: 'dismiss' }) });
    expect(getSecurityAnalysisDetailPresentation('completed', analysis, null)).toMatchObject({
      title: 'Safe to dismiss',
      tone: 'success',
      icon: 'shield-check',
    });
  });

  it('presents a manual-review triage', () => {
    const analysis = makeAnalysis({ triage: makeTriage({ suggestedAction: 'manual_review' }) });
    expect(getSecurityAnalysisDetailPresentation('completed', analysis, null)).toMatchObject({
      title: 'Needs manual review',
      tone: 'warning',
      icon: 'eye',
    });
  });

  it('presents a triage requiring codebase analysis', () => {
    const analysis = makeAnalysis({ triage: makeTriage({ suggestedAction: 'analyze_codebase' }) });
    expect(getSecurityAnalysisDetailPresentation('completed', analysis, null)).toMatchObject({
      title: 'Codebase analysis required',
      tone: 'warning',
      icon: 'brain',
    });
  });

  it('presents a finished analysis with no outcome', () => {
    expect(getSecurityAnalysisDetailPresentation('completed', null, null)).toMatchObject({
      title: 'Analyzed',
      tone: 'neutral',
      icon: 'shield',
    });
  });

  it('presents an unanalyzed finding', () => {
    expect(getSecurityAnalysisDetailPresentation(null, null, null)).toMatchObject({
      title: 'Not analyzed',
      tone: 'neutral',
      icon: 'brain',
    });
  });
});

// Ported from FindingDetailDialog.tsx:1849 (getRemediationPresentation) and
// remediation-unavailable-copy.ts:6 — the single source of remediation
// status/blocker copy shared with use-security-findings.ts.
describe('isActiveRemediationStatus', () => {
  it.each(['queued', 'launching', 'running'])('treats %s as active', status => {
    expect(isActiveRemediationStatus(status)).toBe(true);
  });

  it.each([null, undefined, 'pr_opened', 'blocked', 'failed', 'no_changes_needed', 'cancelled'])(
    'treats %s as inactive',
    status => {
      expect(isActiveRemediationStatus(status)).toBe(false);
    }
  );
});

describe('formatRemediationOrigin', () => {
  it.each<[string, string]>([
    ['auto_policy', 'Automatic policy'],
    ['bulk_existing', 'Include existing policy'],
    ['manual', 'Manual'],
    ['some_other_origin', 'some other origin'],
  ])('formats %s', (origin, label) => {
    expect(formatRemediationOrigin(origin)).toBe(label);
  });
});

describe('getRemediationStatusPresentation', () => {
  it('reports no attempt as not started', () => {
    expect(getRemediationStatusPresentation(null)).toMatchObject({
      label: 'Not started',
      tone: 'neutral',
    });
  });

  it.each<[string, string, string]>([
    ['queued', 'Queued', 'warning'],
    ['launching', 'Starting', 'warning'],
    ['running', 'In progress', 'warning'],
    ['blocked', 'Blocked', 'warning'],
    ['failed', 'Failed', 'danger'],
    ['no_changes_needed', 'No changes needed', 'neutral'],
    ['cancelled', 'Cancelled', 'neutral'],
  ])('presents %s', (status, label, tone) => {
    expect(getRemediationStatusPresentation(status)).toMatchObject({ label, tone });
  });

  it('presents an opened pull request as success', () => {
    expect(getRemediationStatusPresentation('pr_opened')).toMatchObject({
      label: 'PR opened',
      tone: 'success',
    });
  });

  it('presents a draft pull request as needing attention', () => {
    expect(getRemediationStatusPresentation('pr_opened', { prDraft: true })).toMatchObject({
      label: 'Draft PR opened',
      tone: 'warning',
    });
  });

  it('presents a requested cancellation on an active attempt over its raw status', () => {
    expect(
      getRemediationStatusPresentation('running', {
        cancellationRequestedAt: '2026-07-01T00:00:00Z',
      })
    ).toMatchObject({ label: 'Cancellation requested', tone: 'warning' });
  });

  it('ignores a stale cancellation request once the attempt is terminal', () => {
    expect(
      getRemediationStatusPresentation('failed', {
        cancellationRequestedAt: '2026-07-01T00:00:00Z',
      })
    ).toMatchObject({ label: 'Failed', tone: 'danger' });
  });
});

describe('getRemediationUnavailableCopy', () => {
  it('returns no copy when eligible or absent', () => {
    expect(getRemediationUnavailableCopy('eligible')).toBeNull();
    expect(getRemediationUnavailableCopy(null)).toBeNull();
    expect(getRemediationUnavailableCopy(undefined)).toBeNull();
  });

  it.each<[string, string]>([
    ['analysis_required', 'Run codebase analysis before starting remediation.'],
    [
      'not_exploitable',
      'Analysis found no reachable vulnerable path. Auto Remediation is unavailable.',
    ],
    ['remediation_active', 'A remediation attempt is already active.'],
    ['pr_already_opened', 'A remediation PR is already open.'],
  ])('maps %s to its copy', (reason, copy) => {
    expect(getRemediationUnavailableCopy(reason)).toBe(copy);
  });

  it('falls back to a generic message for an unrecognized reason', () => {
    expect(getRemediationUnavailableCopy('some_future_reason')).toBe(
      'Remediation is unavailable for this finding.'
    );
  });

  it('falls back for inherited object keys instead of leaking prototype members', () => {
    expect(getRemediationUnavailableCopy('constructor')).toBe(
      'Remediation is unavailable for this finding.'
    );
    expect(getRemediationUnavailableCopy('toString')).toBe(
      'Remediation is unavailable for this finding.'
    );
  });
});

describe('formatValidationEvidenceEntry', () => {
  it('formats a named check with a result', () => {
    expect(formatValidationEvidenceEntry({ name: 'lint', result: 'passed' }, 0)).toBe(
      'lint: passed'
    );
  });

  it('falls back to an index-based label with no identifying field', () => {
    expect(formatValidationEvidenceEntry({}, 2)).toBe('Validation check 3');
  });

  it('prefers command/check/title fields over the index fallback', () => {
    expect(formatValidationEvidenceEntry({ command: 'pnpm test', status: 'ok' }, 0)).toBe(
      'pnpm test: ok'
    );
  });
});
