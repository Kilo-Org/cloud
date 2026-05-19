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

const LOW_SEVERITY_RANK = 3;

function getSeverityRank(severity: string | null): AutoAnalysisSeverityRank | null {
  if (severity === 'critical') return 0;
  if (severity === 'high') return 1;
  if (severity === 'medium') return 2;
  if (severity === 'low') return LOW_SEVERITY_RANK;
  return null;
}

function getMaxSeverityRank(minSeverity: AutoAnalysisMinSeverity): AutoAnalysisSeverityRank {
  if (minSeverity === 'critical') return 0;
  if (minSeverity === 'high') return 1;
  if (minSeverity === 'medium') return 2;
  return LOW_SEVERITY_RANK;
}

export function decideAutoAnalysisEligibility(
  params: AutoAnalysisEligibilityParams
): AutoAnalysisEligibilityDecision {
  const normalizedSeverityRank = getSeverityRank(params.findingSeverity);
  const severityRank = normalizedSeverityRank ?? LOW_SEVERITY_RANK;
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
