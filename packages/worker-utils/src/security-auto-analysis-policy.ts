export type AutoAnalysisMinSeverity = 'critical' | 'high' | 'medium' | 'all';
export type AutoAnalysisSeverityRank = 0 | 1 | 2 | 3;

export type AutoAnalysisEligibilityParams = {
  findingCreatedAt: string;
  findingStatus: string;
  findingSeverity: string | null;
  autoAnalysisEnabledAt: string | null;
  isAgentEnabled: boolean;
  autoAnalysisEnabled: boolean;
  autoAnalysisMinSeverity: AutoAnalysisMinSeverity;
  autoAnalysisIncludeExisting?: boolean;
};

export type AutoAnalysisEligibilityDecision = {
  eligible: boolean;
  severityRank: AutoAnalysisSeverityRank;
  severityWasUnknown: boolean;
  boundarySkipped: boolean;
};

const LOWEST_SEVERITY_RANK = 3;
const ALL_SEVERITIES_MAX_RANK = LOWEST_SEVERITY_RANK;

const SEVERITY_RANKS = {
  critical: 0,
  high: 1,
  medium: 2,
  low: LOWEST_SEVERITY_RANK,
} as const satisfies Record<string, AutoAnalysisSeverityRank>;

type KnownSeverity = keyof typeof SEVERITY_RANKS;

const MIN_SEVERITY_MAX_RANKS = {
  critical: SEVERITY_RANKS.critical,
  high: SEVERITY_RANKS.high,
  medium: SEVERITY_RANKS.medium,
  all: ALL_SEVERITIES_MAX_RANK,
} as const satisfies Record<AutoAnalysisMinSeverity, AutoAnalysisSeverityRank>;

function isKnownSeverity(severity: string): severity is KnownSeverity {
  return severity in SEVERITY_RANKS;
}

function getSeverityRank(severity: string | null): AutoAnalysisSeverityRank | null {
  return severity && isKnownSeverity(severity) ? SEVERITY_RANKS[severity] : null;
}

function getMaxSeverityRank(minSeverity: AutoAnalysisMinSeverity): AutoAnalysisSeverityRank {
  return MIN_SEVERITY_MAX_RANKS[minSeverity];
}

export function decideAutoAnalysisEligibility(
  params: AutoAnalysisEligibilityParams
): AutoAnalysisEligibilityDecision {
  const normalizedSeverityRank = getSeverityRank(params.findingSeverity);
  const severityRank = normalizedSeverityRank ?? LOWEST_SEVERITY_RANK;
  const boundarySkipped =
    !params.autoAnalysisIncludeExisting &&
    params.autoAnalysisEnabledAt !== null &&
    Date.parse(params.findingCreatedAt) < Date.parse(params.autoAnalysisEnabledAt);

  return {
    eligible:
      params.isAgentEnabled &&
      params.autoAnalysisEnabled &&
      params.findingStatus === 'open' &&
      params.autoAnalysisEnabledAt !== null &&
      !boundarySkipped &&
      severityRank <= getMaxSeverityRank(params.autoAnalysisMinSeverity),
    severityRank,
    severityWasUnknown: normalizedSeverityRank === null,
    boundarySkipped,
  };
}
