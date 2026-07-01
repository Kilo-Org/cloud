import type { SecurityFindingAnalysis } from '@kilocode/db/schema-types';
import { getDismissFindingFormDefaults } from './dismiss-finding-form';

const triageDismissAnalysis = {
  analyzedAt: '2026-06-16T12:00:00.000Z',
  triage: {
    needsSandboxAnalysis: false,
    needsSandboxReasoning: 'Package is only used by an inactive development tool.',
    suggestedAction: 'dismiss',
    confidence: 'high',
    triageAt: '2026-06-16T12:00:00.000Z',
  },
} satisfies SecurityFindingAnalysis;

const sandboxNotExploitableAnalysis = {
  ...triageDismissAnalysis,
  analyzedAt: '2026-06-16T12:05:00.000Z',
  sandboxAnalysis: {
    isExploitable: false,
    exploitabilityReasoning: 'No vulnerable code path is reachable in this repository.',
    usageLocations: [],
    suggestedFix: 'No change needed.',
    suggestedAction: 'open_pr',
    summary: 'Dependency is not used by application code.',
    rawMarkdown: 'Analysis details',
    analysisAt: '2026-06-16T12:05:00.000Z',
  },
} satisfies SecurityFindingAnalysis;

describe('getDismissFindingFormDefaults', () => {
  it('uses empty defaults when analysis is unavailable', () => {
    expect(getDismissFindingFormDefaults(null)).toEqual({
      reason: 'not_used',
      comment: '',
    });
  });

  it('uses non-exploitable sandbox reasoning when analysis recommends opening a PR', () => {
    expect(getDismissFindingFormDefaults(sandboxNotExploitableAnalysis)).toEqual({
      reason: 'not_used',
      comment: 'No vulnerable code path is reachable in this repository.',
    });
  });

  it('uses triage dismissal reasoning when sandbox analysis is unavailable', () => {
    expect(getDismissFindingFormDefaults(triageDismissAnalysis)).toEqual({
      reason: 'not_used',
      comment: 'Package is only used by an inactive development tool.',
    });
  });

  it('does not use stale triage reasoning when sandbox analysis finds exploitability', () => {
    const conflictingAnalysis = {
      ...sandboxNotExploitableAnalysis,
      sandboxAnalysis: {
        ...sandboxNotExploitableAnalysis.sandboxAnalysis,
        isExploitable: true,
        suggestedAction: 'open_pr',
      },
    } satisfies SecurityFindingAnalysis;

    expect(getDismissFindingFormDefaults(conflictingAnalysis)).toEqual({
      reason: 'not_used',
      comment: '',
    });
  });

  it('limits generated comments to GitHub dismissal constraints', () => {
    const longReasoningAnalysis = {
      ...sandboxNotExploitableAnalysis,
      sandboxAnalysis: {
        ...sandboxNotExploitableAnalysis.sandboxAnalysis,
        exploitabilityReasoning: 'x'.repeat(300),
      },
    } satisfies SecurityFindingAnalysis;

    const defaults = getDismissFindingFormDefaults(longReasoningAnalysis);

    expect(defaults.comment).toHaveLength(280);
    expect(defaults.comment).toBe(`${'x'.repeat(279)}…`);
  });
});
