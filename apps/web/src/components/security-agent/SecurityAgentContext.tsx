'use client';

import { createContext, use, useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { useTRPC } from '@/lib/trpc/utils';
import { useQuery, useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { SecurityFinding } from '@kilocode/db/schema';
import { isGitHubIntegrationError } from '@/lib/security-agent/core/error-display';
import type { DismissReason } from './DismissFindingDialog';
import type { SlaConfig } from './SecurityConfigForm';
import { manualAnalysisAdmissionCopy } from './manual-analysis-admission-copy';

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
  handleDismiss: (
    finding: SecurityFinding,
    reason: DismissReason,
    comment?: string,
    onSuccess?: () => void
  ) => void;
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
  handleDeleteFindings: (repoFullName: string, onSuccess?: () => void) => void;

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
  const ctx = use(SecurityAgentContext);
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

const COMMAND_POLL_INTERVAL_MS = 3000;
const EMPTY_REPOSITORIES: SecurityAgentContextValue['allRepositories'] = [];
const EMPTY_REPOSITORY_IDS: number[] = [];
const EMPTY_ORPHANED_REPOSITORIES: SecurityAgentContextValue['orphanedRepositories'] = [];

type SecurityAgentCommand = {
  id: string;
  commandType: 'sync' | 'dismiss_finding' | 'start_analysis';
  findingId: string | null;
  status: 'accepted' | 'running' | 'succeeded' | 'failed' | 'no_op';
  resultCode: string | null;
  lastErrorRedacted: string | null;
};

type SecurityAgentProviderState = {
  optimisticStartingAnalysisIds: Set<string>;
  trackedCommandIds: Set<string>;
  processedTerminalCommandIds: Set<string>;
  gitHubError: string | null;
};

type SecurityAgentProviderAction =
  | { type: 'track-command'; commandId: string }
  | { type: 'add-optimistic-analysis'; findingId: string }
  | { type: 'remove-optimistic-analysis'; findingId: string }
  | { type: 'settle-commands'; commands: SecurityAgentCommand[]; gitHubError?: string }
  | { type: 'prune-processed-commands'; polledCommandIds: Set<string> }
  | { type: 'set-github-error'; error: string | null };

function createSecurityAgentProviderState(): SecurityAgentProviderState {
  return {
    optimisticStartingAnalysisIds: new Set(),
    trackedCommandIds: new Set(),
    processedTerminalCommandIds: new Set(),
    gitHubError: null,
  };
}

function securityAgentProviderReducer(
  state: SecurityAgentProviderState,
  action: SecurityAgentProviderAction
): SecurityAgentProviderState {
  switch (action.type) {
    case 'track-command':
      return {
        ...state,
        trackedCommandIds: new Set(state.trackedCommandIds).add(action.commandId),
      };
    case 'add-optimistic-analysis':
      return {
        ...state,
        optimisticStartingAnalysisIds: new Set(state.optimisticStartingAnalysisIds).add(
          action.findingId
        ),
      };
    case 'remove-optimistic-analysis': {
      const optimisticStartingAnalysisIds = new Set(state.optimisticStartingAnalysisIds);
      optimisticStartingAnalysisIds.delete(action.findingId);
      return { ...state, optimisticStartingAnalysisIds };
    }
    case 'settle-commands': {
      const optimisticStartingAnalysisIds = new Set(state.optimisticStartingAnalysisIds);
      const trackedCommandIds = new Set(state.trackedCommandIds);
      const processedTerminalCommandIds = new Set(state.processedTerminalCommandIds);
      for (const command of action.commands) {
        if (command.findingId) optimisticStartingAnalysisIds.delete(command.findingId);
        trackedCommandIds.delete(command.id);
        processedTerminalCommandIds.add(command.id);
      }
      return {
        optimisticStartingAnalysisIds,
        trackedCommandIds,
        processedTerminalCommandIds,
        gitHubError: action.gitHubError ?? state.gitHubError,
      };
    }
    case 'prune-processed-commands': {
      const processedTerminalCommandIds = new Set(
        [...state.processedTerminalCommandIds].filter(commandId =>
          action.polledCommandIds.has(commandId)
        )
      );
      return processedTerminalCommandIds.size === state.processedTerminalCommandIds.size
        ? state
        : { ...state, processedTerminalCommandIds };
    }
    case 'set-github-error':
      return { ...state, gitHubError: action.error };
  }
}

function commandFailureDescription(command: SecurityAgentCommand): string {
  switch (command.resultCode) {
    case 'OWNER_CAP_REACHED':
      return 'Analysis capacity is full. Wait for an active analysis to finish, then retry.';
    case 'GITHUB_TOKEN_UNAVAILABLE':
    case 'GITHUB_AUTH_INVALID':
      return 'GitHub authorization needs attention. Re-authorize GitHub App, then retry.';
    case 'FINDING_UNAVAILABLE':
      return 'Finding is no longer available. Refresh findings and retry if it remains open.';
    case 'REPOSITORY_UNAVAILABLE':
      return 'Repository is no longer available to GitHub App. Refresh repository access, then retry.';
    case 'INVALID_DISMISS_TARGET':
      return 'Finding cannot be dismissed because its Dependabot target is invalid.';
    case 'COMMAND_STALLED':
      return 'Queued action did not finish in time. Retry action.';
    default:
      return command.lastErrorRedacted ?? 'Queued action failed. Retry action.';
  }
}

type SecurityAgentProviderProps = {
  organizationId?: string;
  children: React.ReactNode;
};

function useSecurityAgentProviderValue(
  organizationId: string | undefined
): SecurityAgentContextValue {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const isOrg = !!organizationId;

  const [providerState, dispatchProviderState] = useReducer(
    securityAgentProviderReducer,
    undefined,
    createSecurityAgentProviderState
  );
  const toggleEnabledInFlightRef = useRef(false);
  const commandSuccessCallbacksRef = useRef<Map<string, () => void>>(null);

  const trackCommand = useCallback((commandId: string, onSuccess?: () => void) => {
    if (onSuccess) {
      if (commandSuccessCallbacksRef.current === null) {
        commandSuccessCallbacksRef.current = new Map();
      }
      commandSuccessCallbacksRef.current.set(commandId, onSuccess);
    }
    dispatchProviderState({ type: 'track-command', commandId });
  }, []);

  const invalidateAcceptedQueueQueries = useCallback(() => {
    if (isOrg && organizationId) {
      const ownerInput = { organizationId };
      void Promise.all([
        queryClient.invalidateQueries({
          queryKey: trpc.organizations.securityAgent.listFindings.queryKey(ownerInput),
        }),
        queryClient.invalidateQueries({
          queryKey: trpc.organizations.securityAgent.getFinding.queryKey(ownerInput),
        }),
        queryClient.invalidateQueries({
          queryKey: trpc.organizations.securityAgent.getAnalysis.queryKey(ownerInput),
        }),
        queryClient.invalidateQueries({
          queryKey: trpc.organizations.securityAgent.getStats.queryKey(ownerInput),
        }),
        queryClient.invalidateQueries({
          queryKey: trpc.organizations.securityAgent.getDashboardStats.queryKey(ownerInput),
        }),
        queryClient.invalidateQueries({
          queryKey: trpc.organizations.securityAgent.getLastSyncTime.queryKey(ownerInput),
        }),
        queryClient.invalidateQueries({
          queryKey: trpc.organizations.securityAgent.getRepositories.queryKey(ownerInput),
        }),
        queryClient.invalidateQueries({
          queryKey: trpc.organizations.securityAgent.getOrphanedRepositories.queryKey(ownerInput),
        }),
        queryClient.invalidateQueries({
          queryKey: trpc.organizations.securityAgent.getAutoDismissEligible.queryKey(ownerInput),
        }),
        queryClient.invalidateQueries({
          queryKey: trpc.organizations.securityAgent.getPermissionStatus.queryKey(ownerInput),
        }),
      ]);
      return;
    }

    void Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.securityAgent.listFindings.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.securityAgent.getFinding.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.securityAgent.getAnalysis.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.securityAgent.getStats.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.securityAgent.getDashboardStats.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.securityAgent.getLastSyncTime.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.securityAgent.getRepositories.queryKey() }),
      queryClient.invalidateQueries({
        queryKey: trpc.securityAgent.getOrphanedRepositories.queryKey(),
      }),
      queryClient.invalidateQueries({
        queryKey: trpc.securityAgent.getAutoDismissEligible.queryKey(),
      }),
      queryClient.invalidateQueries({
        queryKey: trpc.securityAgent.getPermissionStatus.queryKey(),
      }),
    ]);
  }, [isOrg, organizationId, queryClient, trpc]);

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

  const { data: activeCommandsData } = useQuery({
    ...(isOrg
      ? trpc.organizations.securityAgent.listActiveCommands.queryOptions({ organizationId })
      : trpc.securityAgent.listActiveCommands.queryOptions()),
    refetchInterval: query =>
      query.state.data && query.state.data.length > 0 ? COMMAND_POLL_INTERVAL_MS : false,
  });

  const commandIdsToPoll = useMemo(() => {
    const commandIds = new Set(providerState.trackedCommandIds);
    for (const command of activeCommandsData ?? []) commandIds.add(command.id);
    return commandIds;
  }, [activeCommandsData, providerState.trackedCommandIds]);

  useEffect(() => {
    if (
      [...providerState.processedTerminalCommandIds].some(
        commandId => !commandIdsToPoll.has(commandId)
      )
    ) {
      dispatchProviderState({
        type: 'prune-processed-commands',
        polledCommandIds: commandIdsToPoll,
      });
    }
  }, [commandIdsToPoll, providerState.processedTerminalCommandIds]);

  const commandStatusQueries = useQueries({
    queries: [...commandIdsToPoll].map(commandId => ({
      ...(isOrg
        ? trpc.organizations.securityAgent.getCommandStatus.queryOptions({
            organizationId,
            commandId,
          })
        : trpc.securityAgent.getCommandStatus.queryOptions({ commandId })),
      refetchInterval: (query: { state: { data?: SecurityAgentCommand } }) =>
        query.state.data?.status === 'accepted' || query.state.data?.status === 'running'
          ? COMMAND_POLL_INTERVAL_MS
          : false,
    })),
  });
  const activeCommands = useMemo(
    () => [
      ...(activeCommandsData ?? []),
      ...commandStatusQueries.flatMap(query =>
        query.data?.status === 'accepted' || query.data?.status === 'running' ? [query.data] : []
      ),
    ],
    [activeCommandsData, commandStatusQueries]
  );
  const hasActiveSyncCommand = activeCommands.some(command => command.commandType === 'sync');
  const hasActiveDismissCommand = activeCommands.some(
    command => command.commandType === 'dismiss_finding'
  );
  const startingAnalysisIds = useMemo(() => {
    const ids = new Set(providerState.optimisticStartingAnalysisIds);
    for (const command of activeCommands) {
      if (command.commandType === 'start_analysis' && command.findingId) {
        ids.add(command.findingId);
      }
    }
    return ids;
  }, [activeCommands, providerState.optimisticStartingAnalysisIds]);

  useEffect(() => {
    const terminalCommands = commandStatusQueries.flatMap(query => {
      const command = query.data;
      return command && command.status !== 'accepted' && command.status !== 'running'
        ? [command]
        : [];
    });
    const unprocessedTerminalCommands = terminalCommands.filter(
      command => !providerState.processedTerminalCommandIds.has(command.id)
    );
    if (unprocessedTerminalCommands.length === 0) return;

    let terminalGitHubError: string | undefined;
    for (const command of unprocessedTerminalCommands) {
      invalidateAcceptedQueueQueries();
      const successCallback = commandSuccessCallbacksRef.current?.get(command.id);
      commandSuccessCallbacksRef.current?.delete(command.id);
      if (command.status === 'failed') {
        const title =
          command.commandType === 'sync'
            ? 'Sync failed'
            : command.commandType === 'dismiss_finding'
              ? 'Failed to dismiss finding'
              : 'Failed to start analysis';
        if (command.resultCode === 'GITHUB_AUTH_INVALID') {
          terminalGitHubError = commandFailureDescription(command);
        }
        toast.error(title, { description: commandFailureDescription(command), duration: 8000 });
      } else {
        successCallback?.();
        if (command.commandType === 'dismiss_finding') {
          toast.success(
            command.status === 'no_op' ? 'Finding already dismissed' : 'Finding dismissed'
          );
        }
      }
    }

    dispatchProviderState({
      type: 'settle-commands',
      commands: unprocessedTerminalCommands,
      gitHubError: terminalGitHubError,
    });
  }, [
    commandStatusQueries,
    providerState.processedTerminalCommandIds,
    invalidateAcceptedQueueQueries,
  ]);

  // ---- Mutations (org) ----
  const { mutate: orgSyncMutate, isPending: isOrgSyncPending } = useMutation(
    trpc.organizations.securityAgent.triggerSync.mutationOptions({
      onSuccess: data => {
        dispatchProviderState({ type: 'set-github-error', error: null });
        toast.success('Sync queued');
        trackCommand(data.commandId);
      },
      onError: error => {
        const message = error instanceof Error ? error.message : String(error);
        if (isGitHubIntegrationError(error)) {
          dispatchProviderState({ type: 'set-github-error', error: message });
          toast.error('GitHub integration error', {
            description: 'GitHub App may have been uninstalled. Check integrations, then retry.',
          });
        } else {
          toast.error('Sync failed', { description: message });
        }
      },
    })
  );

  const { mutate: orgDismissMutate, isPending: isOrgDismissPending } = useMutation(
    trpc.organizations.securityAgent.dismissFinding.mutationOptions({
      onSuccess: data => {
        toast.success('Dismissal queued');
        trackCommand(data.commandId);
      },
      onError: error => {
        toast.error('Failed to dismiss finding', { description: error.message });
      },
    })
  );

  const { mutate: orgSaveConfigMutate, isPending: isOrgSaveConfigPending } = useMutation(
    trpc.organizations.securityAgent.saveConfig.mutationOptions({
      onSuccess: async data => {
        toast.success('Configuration saved');
        if (data.backlogAdmissionWarning) {
          toast.warning('Existing findings not queued', {
            description: data.backlogAdmissionWarning,
          });
        }
        await refetchConfig();
        invalidateAcceptedQueueQueries();
      },
      onError: error => {
        toast.error('Failed to save configuration', { description: error.message });
      },
    })
  );

  const { mutate: orgSetEnabledMutate, isPending: isOrgSetEnabledPending } = useMutation(
    trpc.organizations.securityAgent.setEnabled.mutationOptions({
      onSuccess: async data => {
        if ('initialSyncAdmissionFailed' in data && data.initialSyncAdmissionFailed) {
          toast.warning('Security Agent enabled', {
            description: 'Initial sync could not be queued. Sync findings to retry.',
          });
        } else if ('initialSync' in data && data.initialSync) {
          toast.success('Security Agent enabled', {
            description: 'Initial sync queued. Findings update as processing completes.',
          });
          trackCommand(data.initialSync.commandId);
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
      onSuccess: async data => {
        dispatchProviderState({ type: 'set-github-error', error: null });
        toast.success(manualAnalysisAdmissionCopy.successTitle);
        trackCommand(data.commandId);
      },
      onError: (error, variables) => {
        const message = error instanceof Error ? error.message : String(error);
        if (isGitHubIntegrationError(error)) {
          dispatchProviderState({ type: 'set-github-error', error: message });
          toast.error('GitHub integration error', {
            description: 'GitHub App may have been uninstalled. Check integrations, then retry.',
          });
        } else {
          toast.error(manualAnalysisAdmissionCopy.failureTitle, {
            description: message,
            duration: 8000,
          });
        }
        void queryClient.invalidateQueries();
        dispatchProviderState({
          type: 'remove-optimistic-analysis',
          findingId: variables.findingId,
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
      onSuccess: data => {
        dispatchProviderState({ type: 'set-github-error', error: null });
        toast.success('Sync queued');
        trackCommand(data.commandId);
      },
      onError: error => {
        const message = error instanceof Error ? error.message : String(error);
        if (isGitHubIntegrationError(error)) {
          dispatchProviderState({ type: 'set-github-error', error: message });
          toast.error('GitHub integration error', {
            description: 'GitHub App may have been uninstalled. Check integrations, then retry.',
          });
        } else {
          toast.error('Sync failed', { description: message });
        }
      },
    })
  );

  const { mutate: personalDismissMutate, isPending: isPersonalDismissPending } = useMutation(
    trpc.securityAgent.dismissFinding.mutationOptions({
      onSuccess: data => {
        toast.success('Dismissal queued');
        trackCommand(data.commandId);
      },
      onError: error => {
        toast.error('Failed to dismiss finding', { description: error.message });
      },
    })
  );

  const { mutate: personalSaveConfigMutate, isPending: isPersonalSaveConfigPending } = useMutation(
    trpc.securityAgent.saveConfig.mutationOptions({
      onSuccess: async data => {
        toast.success('Configuration saved');
        if (data.backlogAdmissionWarning) {
          toast.warning('Existing findings not queued', {
            description: data.backlogAdmissionWarning,
          });
        }
        await refetchConfig();
        invalidateAcceptedQueueQueries();
      },
      onError: error => {
        toast.error('Failed to save configuration', { description: error.message });
      },
    })
  );

  const { mutate: personalSetEnabledMutate, isPending: isPersonalSetEnabledPending } = useMutation(
    trpc.securityAgent.setEnabled.mutationOptions({
      onSuccess: async data => {
        if ('initialSyncAdmissionFailed' in data && data.initialSyncAdmissionFailed) {
          toast.warning('Security Agent enabled', {
            description: 'Initial sync could not be queued. Sync findings to retry.',
          });
        } else if ('initialSync' in data && data.initialSync) {
          toast.success('Security Agent enabled', {
            description: 'Initial sync queued. Findings update as processing completes.',
          });
          trackCommand(data.initialSync.commandId);
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
      onSuccess: async data => {
        dispatchProviderState({ type: 'set-github-error', error: null });
        toast.success(manualAnalysisAdmissionCopy.successTitle);
        trackCommand(data.commandId);
      },
      onError: (error, variables) => {
        const message = error instanceof Error ? error.message : String(error);
        if (isGitHubIntegrationError(error)) {
          dispatchProviderState({ type: 'set-github-error', error: message });
          toast.error('GitHub integration error', {
            description: 'GitHub App may have been uninstalled. Check integrations, then retry.',
          });
        } else {
          toast.error(manualAnalysisAdmissionCopy.failureTitle, {
            description: message,
            duration: 8000,
          });
        }
        void queryClient.invalidateQueries();
        dispatchProviderState({
          type: 'remove-optimistic-analysis',
          findingId: variables.findingId,
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
    (finding: SecurityFinding, reason: DismissReason, comment?: string, onSuccess?: () => void) => {
      if (isOrg && organizationId) {
        orgDismissMutate(
          { organizationId, findingId: finding.id, reason, comment },
          { onSuccess: data => trackCommand(data.commandId, onSuccess) }
        );
      } else {
        personalDismissMutate(
          { findingId: finding.id, reason, comment },
          { onSuccess: data => trackCommand(data.commandId, onSuccess) }
        );
      }
    },
    [isOrg, organizationId, orgDismissMutate, personalDismissMutate, trackCommand]
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
      dispatchProviderState({ type: 'add-optimistic-analysis', findingId });
      if (isOrg && organizationId) {
        orgStartAnalysisMutate({ organizationId, findingId, retrySandboxOnly });
      } else {
        personalStartAnalysisMutate({ findingId, retrySandboxOnly });
      }
    },
    [isOrg, organizationId, orgStartAnalysisMutate, personalStartAnalysisMutate]
  );

  const handleDeleteFindings = useCallback(
    (repoFullName: string, onSuccess?: () => void) => {
      if (isOrg && organizationId) {
        orgDeleteFindingsMutate({ organizationId, repoFullName }, { onSuccess });
      } else {
        personalDeleteFindingsMutate({ repoFullName }, { onSuccess });
      }
    },
    [isOrg, organizationId, orgDeleteFindingsMutate, personalDeleteFindingsMutate]
  );

  const hasIntegration = permissionData?.hasIntegration ?? false;
  const hasPermission = permissionData?.hasPermissions ?? false;
  const reauthorizeUrl = permissionData?.reauthorizeUrl ?? undefined;
  const isEnabled = configData ? configData.isEnabled : undefined;
  const allRepositories = reposData ?? EMPTY_REPOSITORIES;
  const repositorySelectionMode = configData?.repositorySelectionMode ?? 'selected';
  const selectedRepositoryIds = configData?.selectedRepositoryIds ?? EMPTY_REPOSITORY_IDS;

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
      isSyncing: hasActiveSyncCommand || (isOrg ? isOrgSyncPending : isPersonalSyncPending),
      isDismissing:
        hasActiveDismissCommand || (isOrg ? isOrgDismissPending : isPersonalDismissPending),
      isSavingConfig: isOrg ? isOrgSaveConfigPending : isPersonalSaveConfigPending,
      isTogglingEnabled: isOrg ? isOrgSetEnabledPending : isPersonalSetEnabledPending,
      isDeletingFindings: isOrg ? isOrgDeleteFindingsPending : isPersonalDeleteFindingsPending,
      startingAnalysisIds,
      gitHubError: providerState.gitHubError,
      orphanedRepositories: orphanedReposData ?? EMPTY_ORPHANED_REPOSITORIES,
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
      hasActiveSyncCommand,
      hasActiveDismissCommand,
      isOrgDismissPending,
      isPersonalDismissPending,
      isOrgSaveConfigPending,
      isPersonalSaveConfigPending,
      isOrgSetEnabledPending,
      isPersonalSetEnabledPending,
      isOrgDeleteFindingsPending,
      isPersonalDeleteFindingsPending,
      startingAnalysisIds,
      providerState.gitHubError,
      orphanedReposData,
      triageModelSlug,
      analysisModelSlug,
    ]
  );

  return value;
}

export function SecurityAgentProvider({ organizationId, children }: SecurityAgentProviderProps) {
  const value = useSecurityAgentProviderValue(organizationId);
  return <SecurityAgentContext.Provider value={value}>{children}</SecurityAgentContext.Provider>;
}
