import { describe, expect, it } from 'vitest';
import { decideAutoAnalysisEligibility } from './security-auto-analysis-policy.js';

describe('decideAutoAnalysisEligibility', () => {
  it('treats null severity as low-ranked eligible work at the all threshold', () => {
    expect(
      decideAutoAnalysisEligibility({
        findingCreatedAt: '2026-05-18T10:00:00.000Z',
        findingStatus: 'open',
        findingSeverity: null,
        autoAnalysisEnabledAt: '2026-05-18T09:00:00.000Z',
        isAgentEnabled: true,
        autoAnalysisEnabled: true,
        autoAnalysisMinSeverity: 'all',
        autoAnalysisIncludeExisting: false,
      })
    ).toEqual({
      eligible: true,
      severityRank: 3,
      severityWasUnknown: true,
      boundarySkipped: false,
    });
  });

  it('rejects pre-enable findings while include-existing stays disabled', () => {
    expect(
      decideAutoAnalysisEligibility({
        findingCreatedAt: '2026-05-18T08:00:00.000Z',
        findingStatus: 'open',
        findingSeverity: 'high',
        autoAnalysisEnabledAt: '2026-05-18T09:00:00.000Z',
        isAgentEnabled: true,
        autoAnalysisEnabled: true,
        autoAnalysisMinSeverity: 'high',
        autoAnalysisIncludeExisting: false,
      })
    ).toEqual({
      eligible: false,
      severityRank: 1,
      severityWasUnknown: false,
      boundarySkipped: true,
    });
  });

  it('rejects eligible-severity findings when automatic analysis config is disabled', () => {
    expect(
      decideAutoAnalysisEligibility({
        findingCreatedAt: '2026-05-18T10:00:00.000Z',
        findingStatus: 'open',
        findingSeverity: 'critical',
        autoAnalysisEnabledAt: '2026-05-18T09:00:00.000Z',
        isAgentEnabled: true,
        autoAnalysisEnabled: false,
        autoAnalysisMinSeverity: 'critical',
        autoAnalysisIncludeExisting: false,
      })
    ).toEqual({
      eligible: false,
      severityRank: 0,
      severityWasUnknown: false,
      boundarySkipped: false,
    });
  });

  it('rejects eligible-severity findings when the Security Agent config is disabled', () => {
    expect(
      decideAutoAnalysisEligibility({
        findingCreatedAt: '2026-05-18T10:00:00.000Z',
        findingStatus: 'open',
        findingSeverity: 'critical',
        autoAnalysisEnabledAt: '2026-05-18T09:00:00.000Z',
        isAgentEnabled: false,
        autoAnalysisEnabled: true,
        autoAnalysisMinSeverity: 'critical',
        autoAnalysisIncludeExisting: false,
      })
    ).toEqual({
      eligible: false,
      severityRank: 0,
      severityWasUnknown: false,
      boundarySkipped: false,
    });
  });

  it('rejects closed findings even when severity and timestamps are eligible', () => {
    expect(
      decideAutoAnalysisEligibility({
        findingCreatedAt: '2026-05-18T10:00:00.000Z',
        findingStatus: 'fixed',
        findingSeverity: 'critical',
        autoAnalysisEnabledAt: '2026-05-18T09:00:00.000Z',
        isAgentEnabled: true,
        autoAnalysisEnabled: true,
        autoAnalysisMinSeverity: 'critical',
        autoAnalysisIncludeExisting: false,
      })
    ).toEqual({
      eligible: false,
      severityRank: 0,
      severityWasUnknown: false,
      boundarySkipped: false,
    });
  });

  it('requires an auto-analysis enable timestamp before work can launch', () => {
    expect(
      decideAutoAnalysisEligibility({
        findingCreatedAt: '2026-05-18T10:00:00.000Z',
        findingStatus: 'open',
        findingSeverity: 'critical',
        autoAnalysisEnabledAt: null,
        isAgentEnabled: true,
        autoAnalysisEnabled: true,
        autoAnalysisMinSeverity: 'critical',
        autoAnalysisIncludeExisting: true,
      })
    ).toEqual({
      eligible: false,
      severityRank: 0,
      severityWasUnknown: false,
      boundarySkipped: false,
    });
  });

  it('keeps low-ranked unknown severity below stricter thresholds', () => {
    expect(
      decideAutoAnalysisEligibility({
        findingCreatedAt: '2026-05-18T10:00:00.000Z',
        findingStatus: 'open',
        findingSeverity: 'unexpected',
        autoAnalysisEnabledAt: '2026-05-18T09:00:00.000Z',
        isAgentEnabled: true,
        autoAnalysisEnabled: true,
        autoAnalysisMinSeverity: 'medium',
        autoAnalysisIncludeExisting: false,
      })
    ).toEqual({
      eligible: false,
      severityRank: 3,
      severityWasUnknown: true,
      boundarySkipped: false,
    });
  });

  it('keeps pre-enable findings eligible when include-existing is enabled', () => {
    expect(
      decideAutoAnalysisEligibility({
        findingCreatedAt: '2026-05-18T08:00:00.000Z',
        findingStatus: 'open',
        findingSeverity: 'high',
        autoAnalysisEnabledAt: '2026-05-18T09:00:00.000Z',
        isAgentEnabled: true,
        autoAnalysisEnabled: true,
        autoAnalysisMinSeverity: 'high',
        autoAnalysisIncludeExisting: true,
      })
    ).toEqual({
      eligible: true,
      severityRank: 1,
      severityWasUnknown: false,
      boundarySkipped: false,
    });
  });
});
