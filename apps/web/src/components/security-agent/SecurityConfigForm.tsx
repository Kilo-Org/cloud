'use client';

import { type SetStateAction, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, Save } from 'lucide-react';
import { useOrganizationModels } from '@/components/cloud-agent/hooks/useOrganizationModels';
import type { ModelOption } from '@/components/shared/ModelCombobox';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  DEFAULT_SECURITY_AGENT_ANALYSIS_MODEL,
  DEFAULT_SECURITY_AGENT_REMEDIATION_MODEL,
  DEFAULT_SECURITY_AGENT_TRIAGE_MODEL,
  SECURITY_AGENT_MODELS,
} from '@/lib/security-agent/core/constants';
import {
  AgentStatusSection,
  AnalysisModeSection,
  AutoAnalysisSection,
  AutoDismissSection,
  AutoRemediationSection,
  ModelSection,
  NotificationSection,
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
  onSave: (
    config: SecurityConfigSavePayload,
    options?: { onSuccess?: () => void; onError?: () => void }
  ) => void;
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

const DEFAULT_NOTIFICATION_CONFIG = {
  slaNotificationsEnabled: false,
  slaNotificationMinSeverity: 'high',
  slaNotificationWarningDays: 3,
  newFindingNotificationsEnabled: false,
  newFindingNotificationMinSeverity: 'high',
} as const;

const DEFAULT_FORM_CONFIG: SecurityConfigFormState = {
  slaConfig: DEFAULT_SLA_CONFIG,
  slaEnabled: true,
  repositorySelectionMode: 'selected',
  selectedRepositoryIds: [],
  triageModelSlug: DEFAULT_SECURITY_AGENT_TRIAGE_MODEL,
  analysisModelSlug: DEFAULT_SECURITY_AGENT_ANALYSIS_MODEL,
  analysisMode: 'auto',
  autoDismissEnabled: false,
  autoDismissConfidenceThreshold: 'high',
  autoAnalysisEnabled: false,
  autoAnalysisMinSeverity: 'high',
  autoAnalysisIncludeExisting: false,
  autoRemediationEnabled: false,
  autoRemediationMinSeverity: 'high',
  autoRemediationIncludeExisting: false,
  remediationModelSlug: DEFAULT_SECURITY_AGENT_REMEDIATION_MODEL,
  ...DEFAULT_NOTIFICATION_CONFIG,
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
    config.slaEnabled,
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
    config.autoRemediationEnabled,
    config.autoRemediationMinSeverity,
    config.autoRemediationIncludeExisting,
    config.remediationModelSlug,
    config.slaNotificationsEnabled,
    config.slaNotificationMinSeverity,
    config.slaNotificationWarningDays,
    config.newFindingNotificationsEnabled,
    config.newFindingNotificationMinSeverity,
  ]);
}

function configsMatch(left: SecurityConfigFormState, right: SecurityConfigFormState) {
  return configFingerprint(left) === configFingerprint(right);
}

const SETTINGS_TAB_TRIGGER_CLASS =
  'data-[state=active]:bg-background data-[state=active]:border-border data-[state=active]:text-foreground data-[state=active]:shadow-sm';
const SETTINGS_TABS = ['config', 'automation', 'notifications', 'sla'] as const;

type SettingsTab = (typeof SETTINGS_TABS)[number];

function settingsTabFromParam(tab: string | null): SettingsTab {
  return SETTINGS_TABS.find(value => value === tab) ?? 'config';
}

const SECURITY_AGENT_DEFAULT_MODEL_OPTIONS: ModelOption[] = SECURITY_AGENT_MODELS.map(model => ({
  id: model.id,
  name: model.name,
  isFree: model.free,
}));

function withSecurityAgentDefaultModels(models: ModelOption[]) {
  const seenModelIds = new Set<string>();
  return [...SECURITY_AGENT_DEFAULT_MODEL_OPTIONS, ...models].filter(model => {
    if (seenModelIds.has(model.id)) return false;
    seenModelIds.add(model.id);
    return true;
  });
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
  const router = useRouter();
  const searchParams = useSearchParams();
  const defaultSettingsTab = settingsTabFromParam(searchParams.get('tab'));
  const initialConfigFingerprint = configFingerprint(initialConfig);
  const [pendingNavigationHref, setPendingNavigationHref] = useState<string | null>(null);
  const [savingBeforeNavigation, setSavingBeforeNavigation] = useState(false);
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
  const securityAgentModelOptions = withSecurityAgentDefaultModels(modelOptions);
  const hasChanges = !configsMatch(state, initialConfig);
  const saveDisabled = !hasChanges || isSaving;
  const repositoryCount =
    state.repositorySelectionMode === 'all'
      ? repositories.length
      : state.selectedRepositoryIds.length;
  const stateProps = { state, setState };

  const handleSave = (options?: { onSuccess?: () => void; onError?: () => void }) => {
    if (saveDisabled) return;

    onSave(
      {
        ...state.slaConfig,
        slaEnabled: state.slaEnabled,
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
        autoRemediationEnabled: state.autoRemediationEnabled,
        autoRemediationMinSeverity: state.autoRemediationMinSeverity,
        autoRemediationIncludeExisting: state.autoRemediationIncludeExisting,
        remediationModelSlug: state.remediationModelSlug,
        slaNotificationsEnabled: state.slaNotificationsEnabled,
        slaNotificationMinSeverity: state.slaNotificationMinSeverity,
        slaNotificationWarningDays: state.slaNotificationWarningDays,
        newFindingNotificationsEnabled: state.newFindingNotificationsEnabled,
        newFindingNotificationMinSeverity: state.newFindingNotificationMinSeverity,
      },
      options
    );
  };

  const clearPendingNavigation = () => {
    setPendingNavigationHref(null);
    setSavingBeforeNavigation(false);
  };

  const discardChangesAndNavigate = () => {
    if (!pendingNavigationHref) return;
    const href = pendingNavigationHref;
    setLocalConfig({
      draft: initialConfig,
      serverBaseline: initialConfig,
      serverBaselineFingerprint: initialConfigFingerprint,
    });
    clearPendingNavigation();
    router.push(href);
  };

  const saveChangesAndNavigate = () => {
    if (!pendingNavigationHref || saveDisabled) return;
    const href = pendingNavigationHref;
    setSavingBeforeNavigation(true);
    handleSave({
      onSuccess: () => {
        clearPendingNavigation();
        router.push(href);
      },
      onError: () => setSavingBeforeNavigation(false),
    });
  };

  useEffect(() => {
    if (!hasChanges) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasChanges]);

  useEffect(() => {
    if (!hasChanges) return;

    const handleClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey) return;
      const target = event.target;
      if (!(target instanceof Element)) return;

      const anchor = target.closest('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target && anchor.target !== '_self') return;
      if (anchor.hasAttribute('download')) return;

      const url = new URL(anchor.href);
      if (url.origin !== window.location.origin) return;
      const href = `${url.pathname}${url.search}${url.hash}`;
      const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (href === currentHref) return;

      event.preventDefault();
      setPendingNavigationHref(href);
    };

    document.addEventListener('click', handleClick, true);
    return () => document.removeEventListener('click', handleClick, true);
  }, [hasChanges]);

  return (
    <div className="space-y-6">
      <AgentStatusSection
        enabled={enabled}
        isToggling={isToggling}
        availableRepositoryCount={repositories.length}
        repositoryCount={repositoryCount}
        slaEnabled={state.slaEnabled}
        onToggle={nextEnabled =>
          onToggleEnabled(nextEnabled, {
            repositorySelectionMode: state.repositorySelectionMode,
            selectedRepositoryIds: state.selectedRepositoryIds,
          })
        }
      />
      {enabled && (
        <>
          <Tabs defaultValue={defaultSettingsTab} className="space-y-6">
            <TabsList className="h-auto w-full justify-start gap-1 overflow-x-auto rounded-xl p-1 sm:w-fit">
              <TabsTrigger value="config" className={SETTINGS_TAB_TRIGGER_CLASS}>
                Config
              </TabsTrigger>
              <TabsTrigger value="automation" className={SETTINGS_TAB_TRIGGER_CLASS}>
                Automation
              </TabsTrigger>
              <TabsTrigger value="notifications" className={SETTINGS_TAB_TRIGGER_CLASS}>
                Notifications
              </TabsTrigger>
              <TabsTrigger value="sla" className={SETTINGS_TAB_TRIGGER_CLASS}>
                SLA
              </TabsTrigger>
            </TabsList>

            <TabsContent value="config" className="mt-0 space-y-6">
              <RepositorySection
                {...stateProps}
                repositories={repositories}
                isLoading={isLoadingRepositories}
              />
              <ModelSection
                {...stateProps}
                models={securityAgentModelOptions}
                isLoading={isLoadingModels}
              />
              <AnalysisModeSection {...stateProps} />
            </TabsContent>

            <TabsContent value="automation" className="mt-0 space-y-6">
              <AutoAnalysisSection {...stateProps} />
              <AutoRemediationSection {...stateProps} />
              <AutoDismissSection {...stateProps} />
            </TabsContent>

            <TabsContent value="notifications" className="mt-0 space-y-6">
              <NotificationSection
                {...stateProps}
                isOrganization={Boolean(organizationId)}
                disabled={isSaving}
              />
            </TabsContent>

            <TabsContent value="sla" className="mt-0 space-y-6">
              <SlaSection
                {...stateProps}
                isOrganization={Boolean(organizationId)}
                disabled={isSaving}
              />
            </TabsContent>
          </Tabs>
          <div className="border-border flex flex-col-reverse gap-3 border-t pt-4 sm:flex-row sm:justify-between">
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                setState({
                  ...DEFAULT_FORM_CONFIG,
                  slaConfig: { ...DEFAULT_FORM_CONFIG.slaConfig },
                  selectedRepositoryIds: [],
                })
              }
              disabled={isSaving}
            >
              Reset to defaults
            </Button>
            <Button
              type="button"
              className="bg-brand-primary text-primary-foreground hover:bg-brand-primary/90 disabled:bg-muted disabled:text-muted-foreground disabled:opacity-60"
              onClick={() => handleSave()}
              disabled={saveDisabled}
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
      <AlertDialog
        open={Boolean(pendingNavigationHref)}
        onOpenChange={open => !open && clearPendingNavigation()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Save settings changes?</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved Security Agent settings. Save changes before leaving, or discard
              them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSaving}>Keep editing</AlertDialogCancel>
            <Button variant="outline" onClick={discardChangesAndNavigate} disabled={isSaving}>
              Discard changes
            </Button>
            <AlertDialogAction
              onClick={saveChangesAndNavigate}
              disabled={saveDisabled || savingBeforeNavigation}
              className="bg-brand-primary text-primary-foreground hover:bg-brand-primary/90"
            >
              {isSaving || savingBeforeNavigation ? 'Saving...' : 'Save and leave'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export type { SlaConfig } from './security-config-types';
