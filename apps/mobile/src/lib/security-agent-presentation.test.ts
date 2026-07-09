import { describe, expect, it } from 'vitest';

import { type SecurityFinding } from '@/lib/security-agent';
import {
  getSecurityAnalysisPresentation,
  getSecurityDeadlinePresentation,
  getSecurityFindingAnalysisState,
} from '@/lib/security-agent-presentation';

type FindingAnalysis = NonNullable<SecurityFinding['analysis']>;
type SandboxAnalysis = NonNullable<FindingAnalysis['sandboxAnalysis']>;
type Triage = NonNullable<FindingAnalysis['triage']>;

// Minimal fixture for the huge Drizzle-inferred SecurityFinding type — only
// the fields the list-scoped presentation helpers read are meaningful here.
function makeFinding(overrides: Partial<SecurityFinding> = {}): SecurityFinding {
  return {
    id: 'finding-1',
    title: 'Prototype pollution in lodash',
    repo_full_name: 'kilocode/cloud',
    severity: 'high',
    status: 'open',
    ignored_reason: null,
    analysis_status: null,
    analysis_error: null,
    analysis: null,
    sla_due_at: null,
    fixed_at: null,
    updated_at: '2026-07-01 00:00:00+00',
    ...overrides,
  } as unknown as SecurityFinding;
}

function makeSandbox(overrides: Partial<SandboxAnalysis> = {}): SandboxAnalysis {
  return {
    isExploitable: false,
    exploitabilityReasoning: '',
    usageLocations: [],
    suggestedFix: '',
    suggestedAction: 'monitor',
    summary: '',
    rawMarkdown: '',
    analysisAt: '2026-07-01T00:00:00Z',
    ...overrides,
  };
}
function makeTriage(overrides: Partial<Triage> = {}): Triage {
  return {
    needsSandboxAnalysis: false,
    needsSandboxReasoning: '',
    suggestedAction: 'analyze_codebase',
    confidence: 'medium',
    triageAt: '2026-07-01T00:00:00Z',
    ...overrides,
  };
}
function makeAnalysis(overrides: Partial<FindingAnalysis> = {}): FindingAnalysis {
  return { analyzedAt: '2026-07-01T00:00:00Z', ...overrides };
}

describe('getSecurityFindingAnalysisState', () => {
  it.each<[string, string | null, FindingAnalysis | null]>([
    ['queued', 'pending', null],
    ['analyzing', 'running', null],
    ['failed', 'failed', null],
    [
      'extraction-failed',
      'completed',
      makeAnalysis({ sandboxAnalysis: makeSandbox({ extractionStatus: 'failed' }) }),
    ],
    ['exploitable', 'completed', makeAnalysis({ sandboxAnalysis: makeSandbox({ isExploitable: true }) })],
    [
      'not-exploitable',
      'completed',
      makeAnalysis({ sandboxAnalysis: makeSandbox({ isExploitable: false }) }),
    ],
    ['unknown', 'completed', makeAnalysis({ sandboxAnalysis: makeSandbox({ isExploitable: 'unknown' }) })],
    ['safe-to-dismiss', 'completed', makeAnalysis({ triage: makeTriage({ suggestedAction: 'dismiss' }) })],
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
    const presentation = getSecurityAnalysisPresentation(makeFinding({ analysis_status: 'pending' }));
    expect(presentation).toMatchObject({
      label: 'Analysis queued',
      tone: 'warning',
      icon: 'loader',
      spinning: true,
    });
  });

  it('presents an in-progress analysis as a spinning warning', () => {
    const presentation = getSecurityAnalysisPresentation(makeFinding({ analysis_status: 'running' }));
    expect(presentation).toMatchObject({ label: 'Analyzing', tone: 'warning', icon: 'loader', spinning: true });
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
          sandboxAnalysis: makeSandbox({ isExploitable: true, summary: 'Reachable from public API' }),
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
    expect(presentation).toMatchObject({ label: 'Unreachable', tone: 'success', icon: 'shield-check' });
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
    expect(presentation).toMatchObject({ label: 'Safe to dismiss', tone: 'success', icon: 'shield-check' });
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
    expect(presentation).toMatchObject({ label: 'Analysis required', tone: 'warning', icon: 'brain' });
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
    const superseded = makeFinding({ status: 'ignored', ignored_reason: 'superseded:new-finding-id' });
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
