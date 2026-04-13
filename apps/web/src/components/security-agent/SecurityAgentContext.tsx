'use client';

import { createContext, useContext, useState, useCallback, useMemo, useRef } from 'react';
import { useTRPC } from '@/lib/trpc/utils';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { SecurityFinding } from '@kilocode/db/schema';
import { isGitHubIntegrationError } from '@/lib/security-agent/core/error-display';
import type { DismissReason } from './DismissFindingDialog';
import type { SlaConfig } from './SecurityConfigForm';

type SecurityAgentContextValue = {
  organizationId: string | undefined;
  isOrg: boolean;

  // Permission & config state
  hasIntegration: boolean;
  hasPermission: boolean;
  isLoadingPermission: boolean;
  isLoadingConfig: boolean;
  reauthorizeUrl: string | undefined;
  isEnabled: boolean | undefined;
  configData:
    | {
        isEnabled: boolean;
        slaCriticalDays: number;
        slaHighDays: number;
        slaMediumDays: number;
        slaLowDays: number;
        repositorySelectionMode: 'all' | 'selected';
        selectedRepositoryIds: number[];
        modelSlug?: string;
        triageModelSlug?: string;
        analysisModelSlug?: string;
        analysisMode: 'auto' | 'shallow' | 'deep';
        autoDismissEnabled: boolean;
        autoDismissConfidenceThreshold: 'high' | 'medium' | 'low';
        autoAnalysisEnabled: boolean;
        autoAnalysisMinSeverity: 'critical' | 'high' | 'medium' | 'all';
        autoAnalysisIncludeExisting: boolean;
      }
    | undefined;
  refetchConfig: () => Promise<unknown>;

  // Repositories
  allRepositories: Array<{ id: number; fullName: string; name: string; private: boolean }>;
  filteredRepositories: Array<{ id: number; fullName: string; name: string; private: boolean }>;

  // Mutation handlers
  handleSync: (repoFullName?: string) => void;
  handleDismiss: (finding: SecurityFinding, reason: DismissReason, comment?: string) => void;
  handleSaveConfig: (
    config: SlaConfig & {
      repositorySelectionMode: 'all' | 'selected';
      selectedRepositoryIds: number[];
      triageModelSlug: string;
      analysisModelSlug: string;
      modelSlug?: string;
      analysisMode: 'auto' | 'shallow' | 'deep';
      autoDismissEnabled: boolean;
      autoDismissConfidenceThreshold: 'high' | 'medium' | 'low';
      autoAnalysisEnabled: boolean;
      autoAnalysisMinSeverity: 'critical' | 'high' | 'medium' | 'all';
      autoAnalysisIncludeExisting: boolean;
    }
  ) => void;
  handleToggleEnabled: (
    enabled: boolean,
    repositorySelection: {
      repositorySelectionMode: 'all' | 'selected';
      selectedRepositoryIds: number[];
    }
  ) => void;
  handleStartAnalysis: (findingId: string, options?: { retrySandboxOnly?: boolean }) => void;
  handleDeleteFindings: (repoFullName: string) => void;

  // Mutation states
  isSyncing: boolean;
  isDismissing: boolean;
  isSavingConfig: boolean;
  isTogglingEnabled: boolean;
  isDeletingFindings: boolean;

  // Analysis tracking
  startingAnalysisIds: Set<string>;

  // GitHub error
  gitHubError: string | null;

  // Orphaned repos
  orphanedRepositories: Array<{ repoFullName: string; findingCount: number }>;
};

const SecurityAgentContext = createContext<SecurityAgentContextValue | null>(null);

export function useSecurityAgent() {
  const ctx = useContext(SecurityAgentContext);
  if (!ctx) {
    throw new Error('useSecurityAgent must be used within a SecurityAgentProvider');
  }
  return ctx;
}

function getOptionalStringField(source: unknown, key: string): string | undefined {
  if (typeof source !== 'object' || source === null) {
    return undefined;
  }
  const value = Reflect.get(source, key);
  return typeof value === 'string' ? value : undefined;
}

type SecurityAgentProviderProps = {
  organizationId?: string;
  children: React.ReactNode;
};

export function SecurityAgentProvider({ organizationId, children }: SecurityAgentProviderProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const isOrg = !!organizationId;

  const [startingAnalysisIds, setStartingAnalysisIds] = useState<Set<string>>(new Set());
  const [gitHubError, setGitHubError] = useState<string | null>(null);
  const toggleEnabledInFlightRef = useRef(false);

  // Permission status query
  const { data: permissionData, isLoading: isLoadingPermission } = useQuery(
    isOrg
      ? trpc.organizations.securityAgent.getPermissionStatus.queryOptions({ organizationId })
      : trpc.securityAgent.getPermissionStatus.queryOptions()
  );

  // Config query
  const {
    data: configData,
    refetch: refetchConfig,
    isLoading: isLoadingConfig,
  } = useQuery(
    isOrg
      ? trpc.organizations.securityAgent.getConfig.queryOptions({ organizationId })
      : trpc.securityAgent.getConfig.queryOptions()
  );

  // Repositories query
  const { data: reposData } = useQuery(
    isOrg
      ? trpc.organizations.securityAgent.getRepositories.queryOptions({ organizationId })
      : trpc.securityAgent.getRepositories.queryOptions()
  );

  // Orphaned repositories query
  const { data: orphanedReposData } = useQuery(
    isOrg
      ? trpc.organizations.securityAgent.getOrphanedRepositories.queryOptions({ organizationId })
      : trpc.securityAgent.getOrphanedRepositories.queryOptions()
  );

  // ---- Mutations (org) ----
  const { mutate: orgSyncMutate, isPending: isOrgSyncPending } = useMutation(
    trpc.organizations.securityAgent.triggerSync.mutationOptions({
      onSuccess: () => {
        setGitHubError(null);
        toast.success('Sync completed successfully');
        void queryClient.invalidateQueries();
      },
      onError: error => {
        const message = error instanceof Error ? error.message : String(error);
        if (isGitHubIntegrationError(error)) {
          setGitHubError(message);
          toast.error('GitHub Integration Error', {
            description:
              'The GitHub App may have been uninstalled. Please check your integrations.',
          });
        } else {
          toast.error('Sync failed', { description: message });
        }
      },
    })
  );

  const { mutate: orgDismissMutate, isPending: isOrgDismissPending } = useMutation(
    trpc.organizations.securityAgent.dismissFinding.mutationOptions({
      onSuccess: () => {
        toast.success('Finding dismissed');
        void queryClient.invalidateQueries();
      },
      onError: error => {
        toast.error('Failed to dismiss finding', { description: error.message });
      },
    })
  );

  const { mutate: orgSaveConfigMutate, isPending: isOrgSaveConfigPending } = useMutation(
    trpc.organizations.securityAgent.saveConfig.mutationOptions({
      onSuccess: async () => {
        toast.success('Configuration saved');
        await refetchConfig();
      },
      onError: error => {
        toast.error('Failed to save configuration', { description: error.message });
      },
    })
  );

  const { mutate: orgSetEnabledMutate, isPending: isOrgSetEnabledPending } = useMutation(
    trpc.organizations.securityAgent.setEnabled.mutationOptions({
      onSuccess: async data => {
        if ('syncResult' in data && data.syncResult) {
          toast.success('Security Agent enabled', {
            description: `Initial sync completed: ${data.syncResult.synced} alerts synced${data.syncResult.errors > 0 ? `, ${data.syncResult.errors} errors` : ''}`,
          });
        } else {
          toast.success('Security Agent setting updated');
        }
        await refetchConfig();
        void queryClient.invalidateQueries();
      },
      onError: error => {
        toast.error('Failed to toggle Security Agent', { description: error.message });
      },
      onSettled: () => {
        toggleEnabledInFlightRef.current = false;
      },
    })
  );

  const { mutate: orgStartAnalysisMutate } = useMutation(
    trpc.organizations.securityAgent.startAnalysis.mutationOptions({
      onSuccess: async (_data, variables) => {
        setGitHubError(null);
        toast.success('Analysis started');
        void queryClient.invalidateQueries();
        setStartingAnalysisIds(prev => {
          const next = new Set(prev);
          next.delete(variables.findingId);
          return next;
        });
      },
      onError: (error, variables) => {
        const message = error instanceof Error ? error.message : String(error);
        if (isGitHubIntegrationError(error)) {
          setGitHubError(message);
          toast.error('GitHub Integration Error', {
            description:
              'The GitHub App may have been uninstalled. Please check your integrations.',
          });
        } else {
          toast.error('Failed to start analysis', { description: message, duration: 8000 });
        }
        void queryClient.invalidateQueries();
        setStartingAnalysisIds(prev => {
          const next = new Set(prev);
          next.delete(variables.findingId);
          return next;
        });
      },
    })
  );

  const { mutate: orgDeleteFindingsMutate, isPending: isOrgDeleteFindingsPending } = useMutation(
    trpc.organizations.securityAgent.deleteFindingsByRepository.mutationOptions({
      onSuccess: data => {
        toast.success('Findings deleted', {
          description: `${data.deletedCount} findings were permanently deleted`,
        });
        void queryClient.invalidateQueries();
      },
      onError: error => {
        toast.error('Failed to delete findings', { description: error.message });
      },
    })
  );

  // ---- Mutations (personal) ----
  const { mutate: personalSyncMutate, isPending: isPersonalSyncPending } = useMutation(
    trpc.securityAgent.triggerSync.mutationOptions({
      onSuccess: () => {
        setGitHubError(null);
        toast.success('Sync completed successfully');
        void queryClient.invalidateQueries();
      },
      onError: error => {
        const message = error instanceof Error ? error.message : String(error);
        if (isGitHubIntegrationError(error)) {
          setGitHubError(message);
          toast.error('GitHub Integration Error', {
            description:
              'The GitHub App may have been uninstalled. Please check your integrations.',
          });
        } else {
          toast.error('Sync failed', { description: message });
        }
      },
    })
  );

  const { mutate: personalDismissMutate, isPending: isPersonalDismissPending } = useMutation(
    trpc.securityAgent.dismissFinding.mutationOptions({
      onSuccess: () => {
        toast.success('Finding dismissed');
        void queryClient.invalidateQueries();
      },
      onError: error => {
        toast.error('Failed to dismiss finding', { description: error.message });
      },
    })
  );

  const { mutate: personalSaveConfigMutate, isPending: isPersonalSaveConfigPending } = useMutation(
    trpc.securityAgent.saveConfig.mutationOptions({
      onSuccess: async () => {
        toast.success('Configuration saved');
        await refetchConfig();
      },
      onError: error => {
        toast.error('Failed to save configuration', { description: error.message });
      },
    })
  );

  const { mutate: personalSetEnabledMutate, isPending: isPersonalSetEnabledPending } = useMutation(
    trpc.securityAgent.setEnabled.mutationOptions({
      onSuccess: async data => {
        if ('syncResult' in data && data.syncResult) {
          toast.success('Security Agent enabled', {
            description: `Initial sync completed: ${data.syncResult.synced} alerts synced${data.syncResult.errors > 0 ? `, ${data.syncResult.errors} errors` : ''}`,
          });
        } else {
          toast.success('Security Agent setting updated');
        }
        await refetchConfig();
        void queryClient.invalidateQueries();
      },
      onError: error => {
        toast.error('Failed to toggle Security Agent', { description: error.message });
      },
      onSettled: () => {
        toggleEnabledInFlightRef.current = false;
      },
    })
  );

  const { mutate: personalStartAnalysisMutate } = useMutation(
    trpc.securityAgent.startAnalysis.mutationOptions({
      onSuccess: async (_data, variables) => {
        setGitHubError(null);
        toast.success('Analysis started');
        void queryClient.invalidateQueries();
        setStartingAnalysisIds(prev => {
          const next = new Set(prev);
          next.delete(variables.findingId);
          return next;
        });
      },
      onError: (error, variables) => {
        const message = error instanceof Error ? error.message : String(error);
        if (isGitHubIntegrationError(error)) {
          setGitHubError(message);
          toast.error('GitHub Integration Error', {
            description:
              'The GitHub App may have been uninstalled. Please check your integrations.',
          });
        } else {
          toast.error('Failed to start analysis', { description: message, duration: 8000 });
        }
        void queryClient.invalidateQueries();
        setStartingAnalysisIds(prev => {
          const next = new Set(prev);
          next.delete(variables.findingId);
          return next;
        });
      },
    })
  );

  const { mutate: personalDeleteFindingsMutate, isPending: isPersonalDeleteFindingsPending } =
    useMutation(
      trpc.securityAgent.deleteFindingsByRepository.mutationOptions({
        onSuccess: data => {
          toast.success('Findings deleted', {
            description: `${data.deletedCount} findings were permanently deleted`,
          });
          void queryClient.invalidateQueries();
        },
        onError: error => {
          toast.error('Failed to delete findings', { description: error.message });
        },
      })
    );

  // ---- Handlers ----
  const handleSync = useCallback(
    (repoFullName?: string) => {
      if (isOrg && organizationId) {
        orgSyncMutate({ organizationId, repoFullName });
      } else {
        personalSyncMutate({ repoFullName });
      }
    },
    [isOrg, organizationId, orgSyncMutate, personalSyncMutate]
  );

  const handleDismiss = useCallback(
    (finding: SecurityFinding, reason: DismissReason, comment?: string) => {
      if (isOrg && organizationId) {
        orgDismissMutate({ organizationId, findingId: finding.id, reason, comment });
      } else {
        personalDismissMutate({ findingId: finding.id, reason, comment });
      }
    },
    [isOrg, organizationId, orgDismissMutate, personalDismissMutate]
  );

  const handleSaveConfig = useCallback(
    (
      config: SlaConfig & {
        repositorySelectionMode: 'all' | 'selected';
        selectedRepositoryIds: number[];
        triageModelSlug: string;
        analysisModelSlug: string;
        modelSlug?: string;
        analysisMode: 'auto' | 'shallow' | 'deep';
        autoDismissEnabled: boolean;
        autoDismissConfidenceThreshold: 'high' | 'medium' | 'low';
        autoAnalysisEnabled: boolean;
        autoAnalysisMinSeverity: 'critical' | 'high' | 'medium' | 'all';
        autoAnalysisIncludeExisting: boolean;
      }
    ) => {
      const modelConfigPayload = {
        triageModelSlug: config.triageModelSlug,
        analysisModelSlug: config.analysisModelSlug,
        modelSlug: config.modelSlug,
      };

      if (isOrg && organizationId) {
        orgSaveConfigMutate({
          organizationId,
          slaCriticalDays: config.critical,
          slaHighDays: config.high,
          slaMediumDays: config.medium,
          slaLowDays: config.low,
          repositorySelectionMode: config.repositorySelectionMode,
          selectedRepositoryIds: config.selectedRepositoryIds,
          analysisMode: config.analysisMode,
          autoDismissEnabled: config.autoDismissEnabled,
          autoDismissConfidenceThreshold: config.autoDismissConfidenceThreshold,
          autoAnalysisEnabled: config.autoAnalysisEnabled,
          autoAnalysisMinSeverity: config.autoAnalysisMinSeverity,
          autoAnalysisIncludeExisting: config.autoAnalysisIncludeExisting,
          ...modelConfigPayload,
        });
      } else {
        personalSaveConfigMutate({
          slaCriticalDays: config.critical,
          slaHighDays: config.high,
          slaMediumDays: config.medium,
          slaLowDays: config.low,
          repositorySelectionMode: config.repositorySelectionMode,
          selectedRepositoryIds: config.selectedRepositoryIds,
          analysisMode: config.analysisMode,
          autoDismissEnabled: config.autoDismissEnabled,
          autoDismissConfidenceThreshold: config.autoDismissConfidenceThreshold,
          autoAnalysisEnabled: config.autoAnalysisEnabled,
          autoAnalysisMinSeverity: config.autoAnalysisMinSeverity,
          autoAnalysisIncludeExisting: config.autoAnalysisIncludeExisting,
          ...modelConfigPayload,
        });
      }
    },
    [isOrg, organizationId, orgSaveConfigMutate, personalSaveConfigMutate]
  );

  const handleToggleEnabled = useCallback(
    (
      enabled: boolean,
      repositorySelection: {
        repositorySelectionMode: 'all' | 'selected';
        selectedRepositoryIds: number[];
      }
    ) => {
      if (toggleEnabledInFlightRef.current) return;
      toggleEnabledInFlightRef.current = true;

      if (isOrg && organizationId) {
        orgSetEnabledMutate({ organizationId, isEnabled: enabled, ...repositorySelection });
      } else if (!isOrg) {
        personalSetEnabledMutate({ isEnabled: enabled, ...repositorySelection });
      } else {
        toggleEnabledInFlightRef.current = false;
      }
    },
    [isOrg, organizationId, orgSetEnabledMutate, personalSetEnabledMutate]
  );

  const handleStartAnalysis = useCallback(
    (findingId: string, { retrySandboxOnly }: { retrySandboxOnly?: boolean } = {}) => {
      setStartingAnalysisIds(prev => new Set(prev).add(findingId));
      if (isOrg && organizationId) {
        orgStartAnalysisMutate({ organizationId, findingId, retrySandboxOnly });
      } else {
        personalStartAnalysisMutate({ findingId, retrySandboxOnly });
      }
    },
    [isOrg, organizationId, orgStartAnalysisMutate, personalStartAnalysisMutate]
  );

  const handleDeleteFindings = useCallback(
    (repoFullName: string) => {
      if (isOrg && organizationId) {
        orgDeleteFindingsMutate({ organizationId, repoFullName });
      } else {
        personalDeleteFindingsMutate({ repoFullName });
      }
    },
    [isOrg, organizationId, orgDeleteFindingsMutate, personalDeleteFindingsMutate]
  );

  const hasIntegration = permissionData?.hasIntegration ?? false;
  const hasPermission = permissionData?.hasPermissions ?? false;
  const reauthorizeUrl = permissionData?.reauthorizeUrl ?? undefined;
  const isEnabled = configData ? configData.isEnabled : undefined;
  const allRepositories = reposData ?? [];
  const repositorySelectionMode = configData?.repositorySelectionMode ?? 'selected';
  const selectedRepositoryIds = configData?.selectedRepositoryIds ?? [];

  const filteredRepositories = useMemo(
    () =>
      repositorySelectionMode === 'all'
        ? allRepositories
        : allRepositories.filter(repo => selectedRepositoryIds.includes(repo.id)),
    [repositorySelectionMode, allRepositories, selectedRepositoryIds]
  );

  const triageModelSlug = getOptionalStringField(configData, 'triageModelSlug');
  const analysisModelSlug = getOptionalStringField(configData, 'analysisModelSlug');

  const value = useMemo<SecurityAgentContextValue>(
    () => ({
      organizationId,
      isOrg,
      hasIntegration,
      hasPermission,
      isLoadingPermission,
      isLoadingConfig,
      reauthorizeUrl,
      isEnabled,
      configData: configData
        ? {
            ...configData,
            repositorySelectionMode: configData.repositorySelectionMode ?? 'selected',
            selectedRepositoryIds: configData.selectedRepositoryIds ?? [],
            triageModelSlug,
            analysisModelSlug,
            analysisMode: configData.analysisMode ?? 'auto',
            autoDismissEnabled: configData.autoDismissEnabled ?? false,
            autoDismissConfidenceThreshold: configData.autoDismissConfidenceThreshold ?? 'high',
            autoAnalysisEnabled: configData.autoAnalysisEnabled ?? false,
            autoAnalysisMinSeverity: configData.autoAnalysisMinSeverity ?? 'high',
            autoAnalysisIncludeExisting: configData.autoAnalysisIncludeExisting ?? false,
          }
        : undefined,
      refetchConfig,
      allRepositories,
      filteredRepositories,
      handleSync,
      handleDismiss,
      handleSaveConfig,
      handleToggleEnabled,
      handleStartAnalysis,
      handleDeleteFindings,
      isSyncing: isOrg ? isOrgSyncPending : isPersonalSyncPending,
      isDismissing: isOrg ? isOrgDismissPending : isPersonalDismissPending,
      isSavingConfig: isOrg ? isOrgSaveConfigPending : isPersonalSaveConfigPending,
      isTogglingEnabled: isOrg ? isOrgSetEnabledPending : isPersonalSetEnabledPending,
      isDeletingFindings: isOrg ? isOrgDeleteFindingsPending : isPersonalDeleteFindingsPending,
      startingAnalysisIds,
      gitHubError,
      orphanedRepositories: orphanedReposData ?? [],
    }),
    [
      organizationId,
      isOrg,
      hasIntegration,
      hasPermission,
      isLoadingPermission,
      isLoadingConfig,
      reauthorizeUrl,
      isEnabled,
      configData,
      refetchConfig,
      allRepositories,
      filteredRepositories,
      handleSync,
      handleDismiss,
      handleSaveConfig,
      handleToggleEnabled,
      handleStartAnalysis,
      handleDeleteFindings,
      isOrgSyncPending,
      isPersonalSyncPending,
      isOrgDismissPending,
      isPersonalDismissPending,
      isOrgSaveConfigPending,
      isPersonalSaveConfigPending,
      isOrgSetEnabledPending,
      isPersonalSetEnabledPending,
      isOrgDeleteFindingsPending,
      isPersonalDeleteFindingsPending,
      startingAnalysisIds,
      gitHubError,
      orphanedReposData,
      triageModelSlug,
      analysisModelSlug,
    ]
  );

  return <SecurityAgentContext.Provider value={value}>{children}</SecurityAgentContext.Provider>;
}
