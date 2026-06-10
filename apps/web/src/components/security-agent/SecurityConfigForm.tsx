'use client';

import { type SetStateAction, useState } from 'react';
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
  viewState: {
    enabled: boolean;
    isLoadingRepositories?: boolean;
    isSaving: boolean;
    isToggling: boolean;
  };
  onSave: (config: SecurityConfigSavePayload) => void;
  onToggleEnabled: (
    enabled: boolean,
    repositorySelection: Pick<
      SecurityConfigFormState,
      'repositorySelectionMode' | 'selectedRepositoryIds'
    >
  ) => void;
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

function configFingerprint(config: SecurityConfigFormState) {
  return JSON.stringify([
    config.slaConfig.critical,
    config.slaConfig.high,
    config.slaConfig.medium,
    config.slaConfig.low,
    config.repositorySelectionMode,
    sortedIds(config.selectedRepositoryIds),
    config.triageModelSlug,
    config.analysisModelSlug,
    config.analysisMode,
    config.autoDismissEnabled,
    config.autoDismissConfidenceThreshold,
    config.autoAnalysisEnabled,
    config.autoAnalysisMinSeverity,
    config.autoAnalysisIncludeExisting,
  ]);
}

function configsMatch(left: SecurityConfigFormState, right: SecurityConfigFormState) {
  return configFingerprint(left) === configFingerprint(right);
}

type LocalConfigState = {
  draft: SecurityConfigFormState;
  serverBaseline: SecurityConfigFormState;
  serverBaselineFingerprint: string;
};

export function SecurityConfigForm({
  organizationId,
  initialConfig,
  repositories,
  viewState,
  onSave,
  onToggleEnabled,
}: SecurityConfigFormProps) {
  const { enabled, isLoadingRepositories, isSaving, isToggling } = viewState;
  const initialConfigFingerprint = configFingerprint(initialConfig);
  const [localConfig, setLocalConfig] = useState<LocalConfigState>(() => ({
    draft: initialConfig,
    serverBaseline: initialConfig,
    serverBaselineFingerprint: initialConfigFingerprint,
  }));
  const serverBaselineChanged = localConfig.serverBaselineFingerprint !== initialConfigFingerprint;
  const state =
    serverBaselineChanged && configsMatch(localConfig.draft, localConfig.serverBaseline)
      ? initialConfig
      : localConfig.draft;

  if (serverBaselineChanged) {
    setLocalConfig({
      draft: state,
      serverBaseline: initialConfig,
      serverBaselineFingerprint: initialConfigFingerprint,
    });
  }

  const setState = (update: SetStateAction<SecurityConfigFormState>) => {
    setLocalConfig(current => ({
      ...current,
      draft: typeof update === 'function' ? update(current.draft) : update,
    }));
  };
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
        isLoading={isLoadingRepositories}
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
