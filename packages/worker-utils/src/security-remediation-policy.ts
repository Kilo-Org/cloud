export type SecurityRemediationOrigin = 'auto_policy' | 'bulk_existing' | 'manual';
export type SecurityRemediationMinSeverity = 'critical' | 'high' | 'medium' | 'all';
export type SecurityRemediationSeverityRank = 0 | 1 | 2 | 3;

export type SecurityRemediationConfig = {
  repository_selection_mode?: 'all' | 'selected';
  auto_remediation_enabled: boolean;
  auto_remediation_min_severity: SecurityRemediationMinSeverity;
  auto_remediation_include_existing: boolean;
  auto_remediation_enabled_at: string | null;
};

export type SecurityRemediationSandboxAnalysis = {
  isExploitable: boolean | 'unknown';
  suggestedAction: 'dismiss' | 'open_pr' | 'manual_review' | 'monitor';
  suggestedFix?: string | null;
  usageLocations?: string[] | null;
  rawMarkdown?: string | null;
  analysisAt?: string | null;
  summary?: string | null;
  modelUsed?: string | null;
};

export type SecurityRemediationAnalysis = {
  sandboxAnalysis?: SecurityRemediationSandboxAnalysis;
  analyzedAt?: string | null;
  modelUsed?: string | null;
  analysisModel?: string | null;
  triageModel?: string | null;
  correlationId?: string | null;
};

export type SecurityRemediationFinding = {
  id: string;
  status: string;
  severity: string | null;
  repo_full_name: string;
  package_name: string;
  package_ecosystem: string;
  patched_version?: string | null;
  manifest_path?: string | null;
  last_synced_at?: string | null;
  analysis_status?: string | null;
  analysis_completed_at?: string | null;
  analysis?: SecurityRemediationAnalysis | null;
};

export type SecurityRemediationBlockState = {
  hasActiveAttempt: boolean;
  hasPrOpened: boolean;
  hasAutomaticTerminalForFingerprint: boolean;
  hasRetryableTerminalForFinding?: boolean;
};

export type SecurityRemediationCapabilityReason =
  | 'eligible'
  | 'finding_not_open'
  | 'repo_not_in_scope'
  | 'analysis_required'
  | 'sandbox_analysis_required'
  | 'stale_analysis'
  | 'not_exploitable'
  | 'exploitability_unknown'
  | 'manual_review_required'
  | 'monitor_required'
  | 'triage_only'
  | 'action_not_concrete'
  | 'remediation_active'
  | 'pr_already_opened'
  | 'duplicate_analysis_result'
  | 'retry_not_allowed'
  | 'security_agent_disabled'
  | 'auto_remediation_disabled'
  | 'include_existing_disabled'
  | 'below_threshold'
  | 'before_enablement';

export type SecurityRemediationEligibilityParams = {
  finding: SecurityRemediationFinding;
  config: SecurityRemediationConfig;
  isAgentEnabled: boolean;
  repoFullNamesInScope: string[];
  origin: SecurityRemediationOrigin;
  blockState: SecurityRemediationBlockState;
  allowManualRetry?: boolean;
};

export type SecurityRemediationEligibilityDecision = {
  eligible: boolean;
  reason: SecurityRemediationCapabilityReason;
  analysisFingerprint: string | null;
  analysisCompletedAt: string | null;
  severityRank: SecurityRemediationSeverityRank;
};

const LOWEST_SEVERITY_RANK = 3;
const ALL_SEVERITIES_MAX_RANK = LOWEST_SEVERITY_RANK;

const SEVERITY_RANKS = {
  critical: 0,
  high: 1,
  medium: 2,
  low: LOWEST_SEVERITY_RANK,
} as const satisfies Record<string, SecurityRemediationSeverityRank>;

const MIN_SEVERITY_MAX_RANKS = {
  critical: SEVERITY_RANKS.critical,
  high: SEVERITY_RANKS.high,
  medium: SEVERITY_RANKS.medium,
  all: ALL_SEVERITIES_MAX_RANK,
} as const satisfies Record<SecurityRemediationMinSeverity, SecurityRemediationSeverityRank>;

function isKnownSeverity(severity: string): severity is keyof typeof SEVERITY_RANKS {
  return severity in SEVERITY_RANKS;
}

export function getSecurityRemediationSeverityRank(
  severity: string | null
): SecurityRemediationSeverityRank {
  return severity && isKnownSeverity(severity) ? SEVERITY_RANKS[severity] : LOWEST_SEVERITY_RANK;
}

export function severityMeetsSecurityRemediationThreshold(
  severity: string | null,
  minSeverity: SecurityRemediationMinSeverity
): boolean {
  return getSecurityRemediationSeverityRank(severity) <= MIN_SEVERITY_MAX_RANKS[minSeverity];
}

function normalizeTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

export function getSecurityRemediationAnalysisCompletedAt(
  finding: SecurityRemediationFinding
): string | null {
  return (
    normalizeTimestamp(finding.analysis_completed_at) ??
    normalizeTimestamp(finding.analysis?.sandboxAnalysis?.analysisAt) ??
    normalizeTimestamp(finding.analysis?.analyzedAt)
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function shortDeterministicHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function computeSecurityRemediationAnalysisFingerprint(
  finding: SecurityRemediationFinding
): string | null {
  const sandbox = finding.analysis?.sandboxAnalysis;
  const completedAt = getSecurityRemediationAnalysisCompletedAt(finding);
  if (!sandbox || !completedAt) return null;

  return shortDeterministicHash(
    stableJson({
      findingId: finding.id,
      repoFullName: finding.repo_full_name,
      packageName: finding.package_name,
      packageEcosystem: finding.package_ecosystem,
      manifestPath: finding.manifest_path ?? null,
      patchedVersion: finding.patched_version ?? null,
      analysisCompletedAt: completedAt,
      isExploitable: sandbox.isExploitable,
      suggestedAction: sandbox.suggestedAction,
      suggestedFix: sandbox.suggestedFix ?? null,
      usageLocations: sandbox.usageLocations ?? [],
      summary: sandbox.summary ?? null,
      modelUsed:
        sandbox.modelUsed ?? finding.analysis?.analysisModel ?? finding.analysis?.modelUsed,
      correlationId: finding.analysis?.correlationId ?? null,
    })
  );
}

function hasConcreteRemediationPath(finding: SecurityRemediationFinding): boolean {
  const sandbox = finding.analysis?.sandboxAnalysis;
  if (!sandbox) return false;
  const hasPatchedPackagePath =
    Boolean(finding.patched_version?.trim()) &&
    Boolean(finding.package_name?.trim()) &&
    Boolean(finding.manifest_path?.trim());
  const hasSuggestedFix = Boolean(sandbox.suggestedFix?.trim());
  const hasUsageAndFix =
    Array.isArray(sandbox.usageLocations) &&
    sandbox.usageLocations.length > 0 &&
    Boolean(sandbox.suggestedFix?.trim());
  return hasPatchedPackagePath || hasSuggestedFix || hasUsageAndFix;
}

function isAnalysisFresh(finding: SecurityRemediationFinding, completedAt: string): boolean {
  const lastSyncedAt = normalizeTimestamp(finding.last_synced_at);
  if (!lastSyncedAt) return true;
  return Date.parse(completedAt) >= Date.parse(lastSyncedAt);
}

function isRepoInScope(params: {
  finding: SecurityRemediationFinding;
  repoFullNamesInScope: string[];
}): boolean {
  return params.repoFullNamesInScope.includes(params.finding.repo_full_name);
}

export function decideSecurityRemediationEligibility(
  params: SecurityRemediationEligibilityParams
): SecurityRemediationEligibilityDecision {
  const severityRank = getSecurityRemediationSeverityRank(params.finding.severity);
  const analysisCompletedAt = getSecurityRemediationAnalysisCompletedAt(params.finding);
  const analysisFingerprint = computeSecurityRemediationAnalysisFingerprint(params.finding);
  const sandbox = params.finding.analysis?.sandboxAnalysis;

  const reject = (
    reason: SecurityRemediationCapabilityReason
  ): SecurityRemediationEligibilityDecision => ({
    eligible: false,
    reason,
    analysisFingerprint,
    analysisCompletedAt,
    severityRank,
  });

  if (params.finding.status !== 'open') return reject('finding_not_open');
  if (!params.isAgentEnabled) return reject('security_agent_disabled');
  if (!isRepoInScope(params)) return reject('repo_not_in_scope');
  if (params.finding.analysis_status !== 'completed') return reject('analysis_required');
  if (!sandbox) return reject('sandbox_analysis_required');
  if (!analysisCompletedAt || !analysisFingerprint) return reject('analysis_required');
  if (!isAnalysisFresh(params.finding, analysisCompletedAt)) return reject('stale_analysis');
  if (sandbox.isExploitable === false) return reject('not_exploitable');
  const hasConcretePath = hasConcreteRemediationPath(params.finding);
  if (params.blockState.hasActiveAttempt) return reject('remediation_active');
  if (params.blockState.hasPrOpened) return reject('pr_already_opened');

  if (params.origin === 'manual') {
    if (sandbox.suggestedAction === 'monitor') return reject('monitor_required');
    if (sandbox.suggestedAction !== 'open_pr' && sandbox.suggestedAction !== 'manual_review') {
      return reject(sandbox.isExploitable === 'unknown' ? 'exploitability_unknown' : 'triage_only');
    }
    if (!hasConcretePath) return reject('action_not_concrete');
    if (
      params.blockState.hasAutomaticTerminalForFingerprint &&
      !params.allowManualRetry &&
      !params.blockState.hasRetryableTerminalForFinding
    ) {
      return reject('duplicate_analysis_result');
    }
    return {
      eligible: true,
      reason: 'eligible',
      analysisFingerprint,
      analysisCompletedAt,
      severityRank,
    };
  }

  if (sandbox.isExploitable === 'unknown') return reject('exploitability_unknown');
  if (sandbox.suggestedAction === 'manual_review') return reject('manual_review_required');
  if (sandbox.suggestedAction === 'monitor') return reject('monitor_required');
  if (sandbox.suggestedAction !== 'open_pr') return reject('triage_only');
  if (!hasConcretePath) return reject('action_not_concrete');

  if (!params.config.auto_remediation_enabled) return reject('auto_remediation_disabled');
  if (params.origin === 'bulk_existing' && !params.config.auto_remediation_include_existing) {
    return reject('include_existing_disabled');
  }
  if (
    !severityMeetsSecurityRemediationThreshold(
      params.finding.severity,
      params.config.auto_remediation_min_severity
    )
  ) {
    return reject('below_threshold');
  }
  if (params.origin === 'auto_policy') {
    const enabledAt = normalizeTimestamp(params.config.auto_remediation_enabled_at);
    if (!enabledAt || Date.parse(analysisCompletedAt) < Date.parse(enabledAt)) {
      return reject('before_enablement');
    }
  }
  if (params.blockState.hasAutomaticTerminalForFingerprint) {
    return reject('duplicate_analysis_result');
  }

  return {
    eligible: true,
    reason: 'eligible',
    analysisFingerprint,
    analysisCompletedAt,
    severityRank,
  };
}
