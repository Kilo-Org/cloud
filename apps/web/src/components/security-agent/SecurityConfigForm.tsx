'use client';

import { useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { useOrganizationModels } from '@/components/cloud-agent/hooks/useOrganizationModels';
import { Button } from '@/components/ui/button';
import {
  AgentStatusSection,
  AnalysisModeSection,
  AutoAnalysisSection,
  AutoDismissSection,
  ModelSection,
  RepositorySection,
  SlaSection,
} from './SecurityConfigSections';
import type {
  SecurityConfigFormState,
  SecurityConfigSavePayload,
  SecurityRepository,
  SlaConfig,
} from './security-config-types';

type SecurityConfigFormProps = {
  organizationId?: string;
  initialConfig: SecurityConfigFormState;
  repositories: SecurityRepository[];
  repositoriesSyncedAt?: string | null;
  viewState: {
    enabled: boolean;
    isLoadingRepositories?: boolean;
    isSaving: boolean;
    isToggling: boolean;
    isRefreshingRepositories?: boolean;
  };
  onSave: (config: SecurityConfigSavePayload) => void;
  onToggleEnabled: (
    enabled: boolean,
    repositorySelection: Pick<
      SecurityConfigFormState,
      'repositorySelectionMode' | 'selectedRepositoryIds'
    >
  ) => void;
  onRefreshRepositories?: () => void;
};

const DEFAULT_SLA_CONFIG: SlaConfig = {
  critical: 15,
  high: 30,
  medium: 45,
  low: 90,
};

function sortedIds(ids: number[]) {
  return ids.toSorted((left, right) => left - right);
}

function configsMatch(left: SecurityConfigFormState, right: SecurityConfigFormState) {
  return (
    left.slaConfig.critical === right.slaConfig.critical &&
    left.slaConfig.high === right.slaConfig.high &&
    left.slaConfig.medium === right.slaConfig.medium &&
    left.slaConfig.low === right.slaConfig.low &&
    left.repositorySelectionMode === right.repositorySelectionMode &&
    JSON.stringify(sortedIds(left.selectedRepositoryIds)) ===
      JSON.stringify(sortedIds(right.selectedRepositoryIds)) &&
    left.triageModelSlug === right.triageModelSlug &&
    left.analysisModelSlug === right.analysisModelSlug &&
    left.analysisMode === right.analysisMode &&
    left.autoDismissEnabled === right.autoDismissEnabled &&
    left.autoDismissConfidenceThreshold === right.autoDismissConfidenceThreshold &&
    left.autoAnalysisEnabled === right.autoAnalysisEnabled &&
    left.autoAnalysisMinSeverity === right.autoAnalysisMinSeverity &&
    left.autoAnalysisIncludeExisting === right.autoAnalysisIncludeExisting
  );
}

export function SecurityConfigForm({
  organizationId,
  initialConfig,
  repositories,
  repositoriesSyncedAt,
  viewState,
  onSave,
  onToggleEnabled,
  onRefreshRepositories,
}: SecurityConfigFormProps) {
  const { enabled, isLoadingRepositories, isSaving, isToggling, isRefreshingRepositories } =
    viewState;
  const [state, setState] = useState(initialConfig);
  const { modelOptions, isLoadingModels } = useOrganizationModels(organizationId);
  const hasChanges = !configsMatch(state, initialConfig);
  const repositoryCount =
    state.repositorySelectionMode === 'all'
      ? repositories.length
      : state.selectedRepositoryIds.length;
  const stateProps = { state, setState };

  const handleSave = () => {
    onSave({
      ...state.slaConfig,
      repositorySelectionMode: state.repositorySelectionMode,
      selectedRepositoryIds: state.selectedRepositoryIds,
      triageModelSlug: state.triageModelSlug,
      analysisModelSlug: state.analysisModelSlug,
      modelSlug: state.analysisModelSlug,
      analysisMode: state.analysisMode,
      autoDismissEnabled: state.autoDismissEnabled,
      autoDismissConfidenceThreshold: state.autoDismissConfidenceThreshold,
      autoAnalysisEnabled: state.autoAnalysisEnabled,
      autoAnalysisMinSeverity: state.autoAnalysisMinSeverity,
      autoAnalysisIncludeExisting: state.autoAnalysisIncludeExisting,
    });
  };

  return (
    <div className="space-y-6">
      <RepositorySection
        {...stateProps}
        repositories={repositories}
        repositoriesSyncedAt={repositoriesSyncedAt}
        isLoading={isLoadingRepositories}
        isRefreshing={isRefreshingRepositories}
        onRefresh={onRefreshRepositories}
      />
      <AgentStatusSection
        enabled={enabled}
        isToggling={isToggling}
        repositoryCount={repositoryCount}
        onToggle={nextEnabled =>
          onToggleEnabled(nextEnabled, {
            repositorySelectionMode: state.repositorySelectionMode,
            selectedRepositoryIds: state.selectedRepositoryIds,
          })
        }
      />
      {enabled && (
        <>
          <ModelSection {...stateProps} models={modelOptions} isLoading={isLoadingModels} />
          <AnalysisModeSection {...stateProps} />
          <AutoAnalysisSection {...stateProps} />
          <AutoDismissSection {...stateProps} />
          <SlaSection {...stateProps} />
          <div className="border-border flex flex-col-reverse gap-3 border-t pt-4 sm:flex-row sm:justify-between">
            <Button
              type="button"
              variant="outline"
              onClick={() => setState(current => ({ ...current, slaConfig: DEFAULT_SLA_CONFIG }))}
              disabled={isSaving}
            >
              Reset to defaults
            </Button>
            <Button
              type="button"
              className="bg-brand-primary text-primary-foreground hover:bg-brand-primary/90"
              onClick={handleSave}
              disabled={!hasChanges || isSaving}
            >
              {isSaving ? (
                <Loader2
                  className="size-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <Save className="size-4" aria-hidden="true" />
              )}
              {isSaving ? 'Saving...' : 'Save changes'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

export type { SlaConfig } from './security-config-types';
