import {
  LOWEST_SECURITY_SEVERITY_RANK,
  getSecuritySeverityRank,
  getSecuritySeverityThresholdRank,
  type SecuritySeverityRank,
} from './security-severity.js';

export type AutoAnalysisMinSeverity = 'critical' | 'high' | 'medium' | 'all';
export type AutoAnalysisSeverityRank = SecuritySeverityRank;

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

function getMaxSeverityRank(minSeverity: AutoAnalysisMinSeverity): AutoAnalysisSeverityRank {
  return getSecuritySeverityThresholdRank(minSeverity);
}

export function decideAutoAnalysisEligibility(
  params: AutoAnalysisEligibilityParams
): AutoAnalysisEligibilityDecision {
  const normalizedSeverityRank = getSecuritySeverityRank(params.findingSeverity);
  const severityRank = normalizedSeverityRank ?? LOWEST_SECURITY_SEVERITY_RANK;
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
