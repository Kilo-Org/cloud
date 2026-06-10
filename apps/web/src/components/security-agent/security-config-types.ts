import type { Repository } from '@/components/code-reviews/RepositoryMultiSelect';

export type SlaConfig = {
  critical: number;
  high: number;
  medium: number;
  low: number;
};

export type AnalysisMode = 'auto' | 'shallow' | 'deep';
export type AutoDismissConfidenceThreshold = 'high' | 'medium' | 'low';
export type AutoAnalysisMinSeverity = 'critical' | 'high' | 'medium' | 'all';
export type RepositorySelectionMode = 'all' | 'selected';

export type SecurityRepository = {
  id: number;
  fullName: string;
  name: string;
  private: boolean;
};

export type SecurityConfigFormState = {
  slaConfig: SlaConfig;
  repositorySelectionMode: RepositorySelectionMode;
  selectedRepositoryIds: number[];
  triageModelSlug: string;
  analysisModelSlug: string;
  analysisMode: AnalysisMode;
  autoDismissEnabled: boolean;
  autoDismissConfidenceThreshold: AutoDismissConfidenceThreshold;
  autoAnalysisEnabled: boolean;
  autoAnalysisMinSeverity: AutoAnalysisMinSeverity;
  autoAnalysisIncludeExisting: boolean;
};

export type SecurityConfigSavePayload = SlaConfig &
  Omit<SecurityConfigFormState, 'slaConfig'> & {
    modelSlug?: string;
  };

export function toRepositoryOptions(repositories: SecurityRepository[]): Repository[] {
  return repositories.map(repository => ({
    id: repository.id,
    name: repository.name,
    full_name: repository.fullName,
    private: repository.private,
  }));
}
