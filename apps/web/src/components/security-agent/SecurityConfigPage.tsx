'use client';

import { Loader2 } from 'lucide-react';
import { ClearFindingsCard } from './ClearFindingsCard';
import { SecurityConfigForm } from './SecurityConfigForm';
import { useSecurityAgent } from './SecurityAgentContext';
import {
  DEFAULT_SECURITY_AGENT_ANALYSIS_MODEL,
  DEFAULT_SECURITY_AGENT_TRIAGE_MODEL,
} from '@/lib/security-agent/core/constants';
import type { SecurityConfigFormState } from './security-config-types';

export function SecurityConfigPage() {
  const {
    organizationId,
    isEnabled,
    configData,
    allRepositories,
    handleSaveConfig,
    handleToggleEnabled,
    handleDeleteFindings,
    isLoadingConfig,
    isSavingConfig,
    isTogglingEnabled,
    isDeletingFindings,
    orphanedRepositories,
  } = useSecurityAgent();

  if (isLoadingConfig) {
    return (
      <div className="text-muted-foreground flex items-center justify-center gap-2 py-16 text-sm">
        <Loader2 className="size-6 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        Loading settings...
      </div>
    );
  }

  const initialConfig = {
    slaConfig: {
      critical: configData?.slaCriticalDays ?? 15,
      high: configData?.slaHighDays ?? 30,
      medium: configData?.slaMediumDays ?? 45,
      low: configData?.slaLowDays ?? 90,
    },
    repositorySelectionMode: configData?.repositorySelectionMode ?? 'selected',
    selectedRepositoryIds: configData?.selectedRepositoryIds ?? [],
    triageModelSlug:
      configData?.triageModelSlug ?? configData?.modelSlug ?? DEFAULT_SECURITY_AGENT_TRIAGE_MODEL,
    analysisModelSlug:
      configData?.analysisModelSlug ??
      configData?.modelSlug ??
      DEFAULT_SECURITY_AGENT_ANALYSIS_MODEL,
    analysisMode: configData?.analysisMode ?? 'auto',
    autoDismissEnabled: configData?.autoDismissEnabled ?? false,
    autoDismissConfidenceThreshold: configData?.autoDismissConfidenceThreshold ?? 'high',
    autoAnalysisEnabled: configData?.autoAnalysisEnabled ?? false,
    autoAnalysisMinSeverity: configData?.autoAnalysisMinSeverity ?? 'high',
    autoAnalysisIncludeExisting: configData?.autoAnalysisIncludeExisting ?? false,
  } satisfies SecurityConfigFormState;

  return (
    <div className="space-y-6">
      <SecurityConfigForm
        organizationId={organizationId}
        initialConfig={initialConfig}
        repositories={allRepositories}
        viewState={{
          enabled: isEnabled ?? false,
          isSaving: isSavingConfig,
          isToggling: isTogglingEnabled,
        }}
        onSave={handleSaveConfig}
        onToggleEnabled={handleToggleEnabled}
      />
      <ClearFindingsCard
        orphanedRepositories={orphanedRepositories}
        onDeleteFindings={handleDeleteFindings}
        isDeleting={isDeletingFindings}
      />
    </div>
  );
}
