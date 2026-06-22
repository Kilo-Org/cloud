import { describe, expect, it } from 'vitest';
import {
  buildSecurityFindingAnalysisInput,
  computeSecurityRemediationAnalysisFingerprint,
  decideSecurityRemediationEligibility,
  type SecurityRemediationConfig,
  type SecurityRemediationFinding,
} from './security-remediation-policy.js';

const baseConfig: SecurityRemediationConfig = {
  repository_selection_mode: 'selected',
  auto_remediation_enabled: true,
  auto_remediation_min_severity: 'high',
  auto_remediation_include_existing: true,
  auto_remediation_enabled_at: '2026-01-01T00:00:00.000Z',
};

const baseFindingData = {
  id: 'finding-1',
  source: 'dependabot',
  source_id: '42',
  status: 'open',
  severity: 'high',
  repo_full_name: 'kilo/repo',
  package_name: 'lodash',
  package_ecosystem: 'npm',
  dependency_scope: 'runtime',
  cve_id: 'CVE-2021-23337',
  ghsa_id: 'GHSA-35jh-r3h4-6jhm',
  cwe_ids: ['CWE-1321'],
  cvss_score: '7.2',
  title: 'Command Injection in lodash',
  description: 'Versions before 4.17.21 are vulnerable.',
  vulnerable_version_range: '< 4.17.21',
  patched_version: '4.17.21',
  manifest_path: 'package.json',
  raw_data: { updated_at: '2026-01-02T00:00:00.000Z' },
};

const baseFinding: SecurityRemediationFinding = {
  ...baseFindingData,
  last_synced_at: '2026-01-02T00:00:00.000Z',
  analysis_status: 'completed',
  analysis_completed_at: '2026-01-02T00:05:00.000Z',
  analysis: {
    analyzedAt: '2026-01-02T00:05:00.000Z',
    findingDataSnapshot: buildSecurityFindingAnalysisInput(baseFindingData),
    sandboxAnalysis: {
      isExploitable: true,
      suggestedAction: 'open_pr',
      suggestedFix: 'Upgrade lodash to 4.17.21',
      usageLocations: ['src/index.ts'],
      summary: 'Reachable vulnerable lodash usage',
      rawMarkdown: 'analysis',
      analysisAt: '2026-01-02T00:05:00.000Z',
      modelUsed: 'analysis/model',
    },
  },
};

function withCurrentFindingDataSnapshot(
  finding: SecurityRemediationFinding
): SecurityRemediationFinding {
  return {
    ...finding,
    analysis: finding.analysis
      ? {
          ...finding.analysis,
          findingDataSnapshot: buildSecurityFindingAnalysisInput(finding),
        }
      : null,
  };
}

const emptyBlockState = {
  hasActiveAttempt: false,
  hasPrOpened: false,
  hasAutomaticTerminalForFingerprint: false,
  hasRetryableTerminalForFinding: false,
};

describe('decideSecurityRemediationEligibility', () => {
  it('admits exploitable findings with concrete fix path', () => {
    const decision = decideSecurityRemediationEligibility({
      finding: baseFinding,
      config: baseConfig,
      isAgentEnabled: true,
      repoFullNamesInScope: ['kilo/repo'],
      origin: 'manual',
      blockState: emptyBlockState,
    });

    expect(decision).toMatchObject({
      eligible: true,
      reason: 'eligible',
      analysisCompletedAt: '2026-01-02T00:05:00.000Z',
    });
    expect(decision.analysisFingerprint).toBe(
      computeSecurityRemediationAnalysisFingerprint(baseFinding)
    );
  });

  it('keeps analysis fresh when a later sync observes unchanged finding data', () => {
    const decision = decideSecurityRemediationEligibility({
      finding: {
        ...baseFinding,
        last_synced_at: '2026-01-03T00:00:00.000Z',
      },
      config: baseConfig,
      isAgentEnabled: true,
      repoFullNamesInScope: ['kilo/repo'],
      origin: 'manual',
      blockState: emptyBlockState,
    });

    expect(decision).toMatchObject({ eligible: true, reason: 'eligible' });
  });

  it('uses the database completion timestamp when legacy analysis JSON omits timestamps', () => {
    const decision = decideSecurityRemediationEligibility({
      finding: {
        ...baseFinding,
        last_synced_at: '2026-01-03T00:00:00.000Z',
        analysis: {
          ...baseFinding.analysis,
          analyzedAt: null,
          sandboxAnalysis: {
            ...baseFinding.analysis?.sandboxAnalysis,
            isExploitable: true,
            suggestedAction: 'open_pr',
            analysisAt: null,
          },
        },
      },
      config: baseConfig,
      isAgentEnabled: true,
      repoFullNamesInScope: ['kilo/repo'],
      origin: 'manual',
      blockState: emptyBlockState,
    });

    expect(decision).toMatchObject({
      eligible: true,
      reason: 'eligible',
      analysisCompletedAt: '2026-01-02T00:05:00.000Z',
    });
  });

  it('rejects analysis when material finding data changed', () => {
    const decision = decideSecurityRemediationEligibility({
      finding: {
        ...baseFinding,
        patched_version: '4.17.22',
        last_synced_at: '2026-01-03T00:01:00.000Z',
      },
      config: baseConfig,
      isAgentEnabled: true,
      repoFullNamesInScope: ['kilo/repo'],
      origin: 'manual',
      blockState: emptyBlockState,
    });

    expect(decision).toMatchObject({ eligible: false, reason: 'stale_analysis' });
  });

  it('rejects analysis when the source revision changed during analysis', () => {
    const decision = decideSecurityRemediationEligibility({
      finding: {
        ...baseFinding,
        raw_data: { updated_at: '2026-01-02T00:03:00.000Z' },
      },
      config: baseConfig,
      isAgentEnabled: true,
      repoFullNamesInScope: ['kilo/repo'],
      origin: 'manual',
      blockState: emptyBlockState,
    });

    expect(decision).toMatchObject({ eligible: false, reason: 'stale_analysis' });
  });

  it('uses source revision time for legacy analysis without a finding snapshot', () => {
    const legacyAnalysis = {
      ...baseFinding.analysis,
      findingDataSnapshot: undefined,
    };
    const unchangedDecision = decideSecurityRemediationEligibility({
      finding: {
        ...baseFinding,
        analysis: legacyAnalysis,
        last_synced_at: '2026-01-03T00:00:00.000Z',
      },
      config: baseConfig,
      isAgentEnabled: true,
      repoFullNamesInScope: ['kilo/repo'],
      origin: 'manual',
      blockState: emptyBlockState,
    });
    const changedDecision = decideSecurityRemediationEligibility({
      finding: {
        ...baseFinding,
        analysis: legacyAnalysis,
        raw_data: { updated_at: '2026-01-03T00:00:00.000Z' },
      },
      config: baseConfig,
      isAgentEnabled: true,
      repoFullNamesInScope: ['kilo/repo'],
      origin: 'manual',
      blockState: emptyBlockState,
    });

    expect(unchangedDecision).toMatchObject({ eligible: true, reason: 'eligible' });
    expect(changedDecision).toMatchObject({ eligible: false, reason: 'stale_analysis' });
  });

  it('fails closed when legacy analysis has no source revision', () => {
    const decision = decideSecurityRemediationEligibility({
      finding: {
        ...baseFinding,
        raw_data: null,
        analysis: {
          ...baseFinding.analysis,
          findingDataSnapshot: undefined,
        },
      },
      config: baseConfig,
      isAgentEnabled: true,
      repoFullNamesInScope: ['kilo/repo'],
      origin: 'manual',
      blockState: emptyBlockState,
    });

    expect(decision).toMatchObject({ eligible: false, reason: 'stale_analysis' });
  });

  it('allows manual remediation after review when exploitability is unknown but patch path is concrete', () => {
    const manualReviewFinding = withCurrentFindingDataSnapshot({
      ...baseFinding,
      package_name: 'handlebars',
      patched_version: '4.7.7',
      manifest_path: 'package-lock.json',
      analysis: {
        ...baseFinding.analysis,
        sandboxAnalysis: {
          ...baseFinding.analysis!.sandboxAnalysis!,
          isExploitable: 'unknown',
          suggestedAction: 'manual_review',
          suggestedFix: 'Review the raw analysis for fix recommendations.',
          usageLocations: [],
        },
      },
    });

    const decision = decideSecurityRemediationEligibility({
      finding: manualReviewFinding,
      config: baseConfig,
      isAgentEnabled: true,
      repoFullNamesInScope: ['kilo/repo'],
      origin: 'manual',
      blockState: emptyBlockState,
    });

    expect(decision).toMatchObject({ eligible: true, reason: 'eligible' });
  });

  it('keeps automatic remediation blocked for manual-review analysis', () => {
    const decision = decideSecurityRemediationEligibility({
      finding: {
        ...baseFinding,
        analysis: {
          ...baseFinding.analysis,
          sandboxAnalysis: {
            ...baseFinding.analysis!.sandboxAnalysis!,
            isExploitable: 'unknown',
            suggestedAction: 'manual_review',
          },
        },
      },
      config: baseConfig,
      isAgentEnabled: true,
      repoFullNamesInScope: ['kilo/repo'],
      origin: 'auto_policy',
      blockState: emptyBlockState,
    });

    expect(decision).toMatchObject({ eligible: false, reason: 'exploitability_unknown' });
  });

  it('rejects manual review override without a concrete fix path', () => {
    const decision = decideSecurityRemediationEligibility({
      finding: withCurrentFindingDataSnapshot({
        ...baseFinding,
        patched_version: null,
        manifest_path: null,
        analysis: {
          ...baseFinding.analysis,
          sandboxAnalysis: {
            ...baseFinding.analysis!.sandboxAnalysis!,
            isExploitable: 'unknown',
            suggestedAction: 'manual_review',
            suggestedFix: null,
            usageLocations: [],
          },
        },
      }),
      config: baseConfig,
      isAgentEnabled: true,
      repoFullNamesInScope: ['kilo/repo'],
      origin: 'manual',
      blockState: emptyBlockState,
    });

    expect(decision).toMatchObject({ eligible: false, reason: 'action_not_concrete' });
  });

  it('dedupes automatic attempts for same analysis fingerprint', () => {
    const decision = decideSecurityRemediationEligibility({
      finding: baseFinding,
      config: baseConfig,
      isAgentEnabled: true,
      repoFullNamesInScope: ['kilo/repo'],
      origin: 'auto_policy',
      blockState: {
        ...emptyBlockState,
        hasAutomaticTerminalForFingerprint: true,
      },
    });

    expect(decision).toMatchObject({ eligible: false, reason: 'duplicate_analysis_result' });
  });

  it('allows manual retry of retryable terminal outcomes for same analysis fingerprint', () => {
    const decision = decideSecurityRemediationEligibility({
      finding: baseFinding,
      config: baseConfig,
      isAgentEnabled: true,
      repoFullNamesInScope: ['kilo/repo'],
      origin: 'manual',
      blockState: {
        ...emptyBlockState,
        hasAutomaticTerminalForFingerprint: true,
        hasRetryableTerminalForFinding: true,
      },
      allowManualRetry: true,
    });

    expect(decision).toMatchObject({ eligible: true, reason: 'eligible' });
  });

  it('gates automatic policy by threshold and enablement time', () => {
    const belowThreshold = decideSecurityRemediationEligibility({
      finding: withCurrentFindingDataSnapshot({ ...baseFinding, severity: 'medium' }),
      config: baseConfig,
      isAgentEnabled: true,
      repoFullNamesInScope: ['kilo/repo'],
      origin: 'auto_policy',
      blockState: emptyBlockState,
    });
    expect(belowThreshold).toMatchObject({ eligible: false, reason: 'below_threshold' });

    const beforeEnablement = decideSecurityRemediationEligibility({
      finding: {
        ...baseFinding,
        last_synced_at: '2025-12-31T22:00:00.000Z',
        analysis_completed_at: '2025-12-31T23:00:00.000Z',
        analysis: {
          ...baseFinding.analysis,
          sandboxAnalysis: {
            ...baseFinding.analysis?.sandboxAnalysis,
            isExploitable: true,
            suggestedAction: 'open_pr',
          },
        },
      },
      config: { ...baseConfig, auto_remediation_include_existing: false },
      isAgentEnabled: true,
      repoFullNamesInScope: ['kilo/repo'],
      origin: 'auto_policy',
      blockState: emptyBlockState,
    });
    expect(beforeEnablement).toMatchObject({ eligible: false, reason: 'before_enablement' });
  });
});
