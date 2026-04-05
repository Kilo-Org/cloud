'use client';

import { SecurityConfigForm, type SlaConfig } from './SecurityConfigForm';
import { ClearFindingsCard } from './ClearFindingsCard';
import { useSecurityAgent } from './SecurityAgentContext';

export function SecurityConfigPage() {
  const {
    organizationId,
    isEnabled,
    configData,
    allRepositories,
    handleSaveConfig,
    handleToggleEnabled,
    handleDeleteFindings,
    isSavingConfig,
    isTogglingEnabled,
    isDeletingFindings,
    orphanedRepositories,
  } = useSecurityAgent();

  const slaConfig = {
    critical: configData?.slaCriticalDays ?? 15,
    high: configData?.slaHighDays ?? 30,
    medium: configData?.slaMediumDays ?? 45,
    low: configData?.slaLowDays ?? 90,
  } satisfies SlaConfig;

  return (
    <div className="space-y-6">
      <SecurityConfigForm
        organizationId={organizationId}
        enabled={isEnabled ?? false}
        slaConfig={slaConfig}
        repositorySelectionMode={configData?.repositorySelectionMode ?? 'selected'}
        selectedRepositoryIds={configData?.selectedRepositoryIds ?? []}
        modelSlug={configData?.modelSlug}
        triageModelSlug={configData?.triageModelSlug}
        analysisModelSlug={configData?.analysisModelSlug}
        analysisMode={configData?.analysisMode ?? 'auto'}
        autoDismissEnabled={configData?.autoDismissEnabled ?? false}
        autoDismissConfidenceThreshold={configData?.autoDismissConfidenceThreshold ?? 'high'}
        autoAnalysisEnabled={configData?.autoAnalysisEnabled ?? false}
        autoAnalysisMinSeverity={configData?.autoAnalysisMinSeverity ?? 'high'}
        autoAnalysisIncludeExisting={configData?.autoAnalysisIncludeExisting ?? false}
        repositories={allRepositories}
        onSave={handleSaveConfig}
        onToggleEnabled={handleToggleEnabled}
        isSaving={isSavingConfig}
        isToggling={isTogglingEnabled}
      />
      <ClearFindingsCard
        orphanedRepositories={orphanedRepositories}
        onDeleteFindings={handleDeleteFindings}
        isDeleting={isDeletingFindings}
      />
    </div>
  );
}
