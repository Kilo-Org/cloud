import { describe, expect, it } from 'vitest';
import {
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

const baseFinding: SecurityRemediationFinding = {
  id: 'finding-1',
  status: 'open',
  severity: 'high',
  repo_full_name: 'kilo/repo',
  package_name: 'lodash',
  package_ecosystem: 'npm',
  patched_version: '4.17.21',
  manifest_path: 'package.json',
  last_synced_at: '2026-01-02T00:00:00.000Z',
  analysis_status: 'completed',
  analysis_completed_at: '2026-01-02T00:05:00.000Z',
  analysis: {
    analyzedAt: '2026-01-02T00:05:00.000Z',
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

  it('rejects stale analysis after later sync', () => {
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

    expect(decision).toMatchObject({ eligible: false, reason: 'stale_analysis' });
  });

  it('allows manual remediation after review when exploitability is unknown but patch path is concrete', () => {
    const manualReviewFinding: SecurityRemediationFinding = {
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
    };

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
      finding: {
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
      },
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
      finding: { ...baseFinding, severity: 'medium' },
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
