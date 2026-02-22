'use client';

import { useState, useCallback } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SecurityFindingsCard } from './SecurityFindingsCard';
import { FindingDetailDialog } from './FindingDetailDialog';
import { DismissFindingDialog, type DismissReason } from './DismissFindingDialog';
import { SecurityConfigForm, type SlaConfig } from './SecurityConfigForm';
import { AnalysisJobsCard } from './AnalysisJobsCard';
import { ClearFindingsCard } from './ClearFindingsCard';
import { useTRPC } from '@/lib/trpc/utils';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ExternalLink,
  Rocket,
  ListChecks,
  Settings2,
  Brain,
  RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';
import type { SecurityFinding } from '@/db/schema';
import Link from 'next/link';

type SecurityAgentPageClientProps = {
  organizationId?: string;
  isAdmin: boolean;
};

const PAGE_SIZE = 20;

// Helper to detect GitHub integration errors from error messages
function isGitHubIntegrationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('GitHub token') ||
    message.includes('GitHub installation') ||
    message.includes('installation_id') ||
    message.includes('Bad credentials') ||
    message.includes('Not Found') || // GitHub API returns 404 for uninstalled apps
    message.includes('Forbidden') || // GitHub API returns 403 for permission issues
    message.includes('Resource not accessible') // GitHub returns this for missing permissions
  );
}

export function SecurityAgentPageClient({ organizationId, isAdmin }: SecurityAgentPageClientProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  // Default to config tab if security reviews is disabled
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<{
    status?: string;
    severity?: string;
    repoFullName?: string;
    exploitability?: string;
    suggestedAction?: string;
    analysisStatus?: string;
  }>({ status: 'open' });
  const [selectedFinding, setSelectedFinding] = useState<SecurityFinding | null>(null);
  const [detailDialogOpen, setDetailDialogOpen] = useState(false);
  const [dismissDialogOpen, setDismissDialogOpen] = useState(false);
  const [startingAnalysisId, setStartingAnalysisId] = useState<string | null>(null);
  const [gitHubError, setGitHubError] = useState<string | null>(null);

  // Determine which router to use based on organizationId
  const isOrg = !!organizationId;

  // Permission status query
  const { data: permissionData, isLoading: isLoadingPermission } = useQuery(
    isOrg
      ? trpc.organizations.securityAgent.getPermissionStatus.queryOptions({ organizationId })
      : trpc.securityAgent.getPermissionStatus.queryOptions()
  );

  // Config query
  const { data: configData, refetch: refetchConfig } = useQuery(
    isOrg
      ? trpc.organizations.securityAgent.getConfig.queryOptions({ organizationId })
      : trpc.securityAgent.getConfig.queryOptions()
  );

  // Stats query
  const { data: statsData } = useQuery(
    isOrg
      ? trpc.organizations.securityAgent.getStats.queryOptions({ organizationId })
      : trpc.securityAgent.getStats.queryOptions()
  );

  // Repositories query
  const { data: reposData } = useQuery(
    isOrg
      ? trpc.organizations.securityAgent.getRepositories.queryOptions({ organizationId })
      : trpc.securityAgent.getRepositories.queryOptions()
  );

  // Findings query - polls when there are active analysis jobs
  const { data: findingsData, isLoading: isLoadingFindings } = useQuery({
    ...(isOrg
      ? trpc.organizations.securityAgent.listFindings.queryOptions({
          organizationId,
          status: filters.status as 'open' | 'fixed' | 'ignored' | 'closed' | undefined,
          severity: filters.severity as 'critical' | 'high' | 'medium' | 'low' | undefined,
          exploitability: filters.exploitability as
            | 'all'
            | 'exploitable'
            | 'not_exploitable'
            | undefined,
          suggestedAction: filters.suggestedAction as 'all' | 'dismissable' | undefined,
          analysisStatus: filters.analysisStatus as
            | 'all'
            | 'not_analyzed'
            | 'pending'
            | 'running'
            | 'completed'
            | 'failed'
            | undefined,
          repoFullName: filters.repoFullName,
          limit: PAGE_SIZE,
          offset: (page - 1) * PAGE_SIZE,
        })
      : trpc.securityAgent.listFindings.queryOptions({
          status: filters.status as 'open' | 'fixed' | 'ignored' | 'closed' | undefined,
          severity: filters.severity as 'critical' | 'high' | 'medium' | 'low' | undefined,
          exploitability: filters.exploitability as
            | 'all'
            | 'exploitable'
            | 'not_exploitable'
            | undefined,
          suggestedAction: filters.suggestedAction as 'all' | 'dismissable' | undefined,
          analysisStatus: filters.analysisStatus as
            | 'all'
            | 'not_analyzed'
            | 'pending'
            | 'running'
            | 'completed'
            | 'failed'
            | undefined,
          repoFullName: filters.repoFullName,
          limit: PAGE_SIZE,
          offset: (page - 1) * PAGE_SIZE,
        })),
    refetchInterval: query => {
      const result = query.state.data;
      if (!result || !Array.isArray(result)) return false;
      // Poll every 5s if any finding has an active analysis job
      const hasActiveAnalysis = result.some(
        f => f.analysis_status === 'pending' || f.analysis_status === 'running'
      );
      return hasActiveAnalysis ? 5000 : false;
    },
  });

  // Last sync time query
  const { data: lastSyncData } = useQuery(
    isOrg
      ? trpc.organizations.securityAgent.getLastSyncTime.queryOptions({
          organizationId,
          repoFullName: filters.repoFullName,
        })
      : trpc.securityAgent.getLastSyncTime.queryOptions({
          repoFullName: filters.repoFullName,
        })
  );

  // Orphaned repositories query (repos with findings but no longer in GitHub integration)
  const { data: orphanedReposData } = useQuery(
    isOrg
      ? trpc.organizations.securityAgent.getOrphanedRepositories.queryOptions({ organizationId })
      : trpc.securityAgent.getOrphanedRepositories.queryOptions()
  );

  // Organization mutations
  const { mutate: orgSyncMutate, isPending: isOrgSyncPending } = useMutation(
    trpc.organizations.securityAgent.triggerSync.mutationOptions({
      onSuccess: () => {
        setGitHubError(null); // Clear any previous error on success
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
        setDismissDialogOpen(false);
        setDetailDialogOpen(false);
        setSelectedFinding(null);
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
    })
  );

  // Personal mutations
  const { mutate: personalSyncMutate, isPending: isPersonalSyncPending } = useMutation(
    trpc.securityAgent.triggerSync.mutationOptions({
      onSuccess: () => {
        setGitHubError(null); // Clear any previous error on success
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
        setDismissDialogOpen(false);
        setDetailDialogOpen(false);
        setSelectedFinding(null);
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
    })
  );

  // Analysis mutations - Organization
  const { mutate: orgStartAnalysisMutate, isPending: _isOrgStartAnalysisPending } = useMutation(
    trpc.organizations.securityAgent.startAnalysis.mutationOptions({
      onSuccess: async () => {
        setGitHubError(null); // Clear any previous error on success
        toast.success('Analysis started');
        void queryClient.invalidateQueries();
        setStartingAnalysisId(null);
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
          toast.error('Failed to start analysis', {
            description: message,
            duration: 8000,
          });
        }
        setStartingAnalysisId(null);
      },
    })
  );

  // Analysis mutations - Personal
  const { mutate: personalStartAnalysisMutate, isPending: _isPersonalStartAnalysisPending } =
    useMutation(
      trpc.securityAgent.startAnalysis.mutationOptions({
        onSuccess: async () => {
          setGitHubError(null); // Clear any previous error on success
          toast.success('Analysis started');
          void queryClient.invalidateQueries();
          setStartingAnalysisId(null);
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
            toast.error('Failed to start analysis', {
              description: message,
              duration: 8000,
            });
          }
          setStartingAnalysisId(null);
        },
      })
    );

  // Delete findings mutations - Organization
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

  // Delete findings mutations - Personal
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

  // Refresh installation mutations - Organization
  const { mutate: orgRefreshMutate, isPending: isOrgRefreshPending } = useMutation(
    trpc.organizations.githubApps.refreshInstallation.mutationOptions({
      onSuccess: () => {
        toast.success('Permissions refreshed', {
          description: 'GitHub App permissions have been updated from GitHub.',
        });
        void queryClient.invalidateQueries();
      },
      onError: error => {
        toast.error('Failed to refresh permissions', { description: error.message });
      },
    })
  );

  // Refresh installation mutations - Personal
  const { mutate: personalRefreshMutate, isPending: isPersonalRefreshPending } = useMutation(
    trpc.githubApps.refreshInstallation.mutationOptions({
      onSuccess: () => {
        toast.success('Permissions refreshed', {
          description: 'GitHub App permissions have been updated from GitHub.',
        });
        void queryClient.invalidateQueries();
      },
      onError: error => {
        toast.error('Failed to refresh permissions', { description: error.message });
      },
    })
  );

  // Handlers
  const handleSync = useCallback(
    (repoFullName?: string) => {
      if (isOrg && organizationId) {
        orgSyncMutate({
          organizationId,
          repoFullName,
        });
      } else if (!isOrg) {
        personalSyncMutate({
          repoFullName,
        });
      }
    },
    [isOrg, organizationId, orgSyncMutate, personalSyncMutate]
  );

  const handleDismiss = useCallback(
    (reason: DismissReason, comment?: string) => {
      if (!selectedFinding) return;

      if (isOrg && organizationId) {
        orgDismissMutate({
          organizationId,
          findingId: selectedFinding.id,
          reason,
          comment,
        });
      } else if (!isOrg) {
        personalDismissMutate({
          findingId: selectedFinding.id,
          reason,
          comment,
        });
      }
    },
    [isOrg, organizationId, selectedFinding, orgDismissMutate, personalDismissMutate]
  );

  const handleSaveConfig = useCallback(
    (
      config: SlaConfig & {
        repositorySelectionMode: 'all' | 'selected';
        selectedRepositoryIds: number[];
        modelSlug: string;
        analysisMode: 'auto' | 'shallow' | 'deep';
        autoDismissEnabled: boolean;
        autoDismissConfidenceThreshold: 'high' | 'medium' | 'low';
      }
    ) => {
      if (isOrg && organizationId) {
        orgSaveConfigMutate({
          organizationId,
          slaCriticalDays: config.critical,
          slaHighDays: config.high,
          slaMediumDays: config.medium,
          slaLowDays: config.low,
          repositorySelectionMode: config.repositorySelectionMode,
          selectedRepositoryIds: config.selectedRepositoryIds,
          modelSlug: config.modelSlug,
          analysisMode: config.analysisMode,
          autoDismissEnabled: config.autoDismissEnabled,
          autoDismissConfidenceThreshold: config.autoDismissConfidenceThreshold,
        });
      } else if (!isOrg) {
        personalSaveConfigMutate({
          slaCriticalDays: config.critical,
          slaHighDays: config.high,
          slaMediumDays: config.medium,
          slaLowDays: config.low,
          repositorySelectionMode: config.repositorySelectionMode,
          selectedRepositoryIds: config.selectedRepositoryIds,
          modelSlug: config.modelSlug,
          analysisMode: config.analysisMode,
          autoDismissEnabled: config.autoDismissEnabled,
          autoDismissConfidenceThreshold: config.autoDismissConfidenceThreshold,
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
      if (isOrg && organizationId) {
        orgSetEnabledMutate({
          organizationId,
          isEnabled: enabled,
          repositorySelectionMode: repositorySelection.repositorySelectionMode,
          selectedRepositoryIds: repositorySelection.selectedRepositoryIds,
        });
      } else if (!isOrg) {
        personalSetEnabledMutate({
          isEnabled: enabled,
          repositorySelectionMode: repositorySelection.repositorySelectionMode,
          selectedRepositoryIds: repositorySelection.selectedRepositoryIds,
        });
      }
    },
    [isOrg, organizationId, orgSetEnabledMutate, personalSetEnabledMutate]
  );

  const handleFindingClick = useCallback((finding: SecurityFinding) => {
    setSelectedFinding(finding);
    setDetailDialogOpen(true);
  }, []);

  const handleOpenDismissDialog = useCallback(() => {
    setDetailDialogOpen(false);
    setDismissDialogOpen(true);
  }, []);

  const handleStartAnalysis = useCallback(
    (findingId: string) => {
      setStartingAnalysisId(findingId);
      if (isOrg && organizationId) {
        orgStartAnalysisMutate({ organizationId, findingId });
      } else {
        personalStartAnalysisMutate({ findingId });
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

  const handleRefreshPermissions = useCallback(() => {
    if (isOrg && organizationId) {
      orgRefreshMutate({ organizationId });
    } else {
      personalRefreshMutate();
    }
  }, [isOrg, organizationId, orgRefreshMutate, personalRefreshMutate]);

  // Check integration and permissions
  const hasIntegration = permissionData?.hasIntegration ?? false;
  const hasPermission = permissionData?.hasPermissions ?? false;
  const reauthorizeUrl = permissionData?.reauthorizeUrl;

  // Get config data
  const isEnabled = configData?.isEnabled ?? false;

  // Set default tab based on whether security reviews is enabled
  // Only set once when configData is first loaded
  // If no integration, always show findings tab (config tab will be hidden)
  const effectiveTab = activeTab ?? (hasIntegration && !isEnabled ? 'config' : 'findings');
  const slaConfig = {
    critical: configData?.slaCriticalDays ?? 15,
    high: configData?.slaHighDays ?? 30,
    medium: configData?.slaMediumDays ?? 45,
    low: configData?.slaLowDays ?? 90,
  } satisfies SlaConfig;

  // Get stats data - already flat from the API
  const stats = statsData ?? {
    total: 0,
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    open: 0,
    fixed: 0,
    ignored: 0,
  };

  // Get findings data - API returns array directly
  const findings = findingsData ?? [];
  // For total count: use stats.total when no filters are applied,
  // otherwise we can only know if there are more pages by checking if we got a full page
  const hasFilters =
    filters.status ||
    filters.severity ||
    filters.repoFullName ||
    filters.exploitability ||
    filters.suggestedAction ||
    filters.analysisStatus;
  const totalCount = hasFilters
    ? // When filters are applied, we don't have an exact count
      // Use a heuristic: if we got a full page, there might be more
      findings.length === PAGE_SIZE
      ? page * PAGE_SIZE + 1 // Indicate there's at least one more
      : (page - 1) * PAGE_SIZE + findings.length
    : stats.total;

  // Get repositories - filter to only show selected repositories in the findings tab
  const allRepositories = reposData ?? [];
  const repositorySelectionMode = configData?.repositorySelectionMode ?? 'selected';
  const selectedRepositoryIds = configData?.selectedRepositoryIds ?? [];

  // For the findings tab, only show repositories that are selected for security reviews
  const filteredRepositories =
    repositorySelectionMode === 'all'
      ? allRepositories
      : allRepositories.filter(repo => selectedRepositoryIds.includes(repo.id));

  // Mutation states
  const isSyncing = isOrg ? isOrgSyncPending : isPersonalSyncPending;
  const isDismissing = isOrg ? isOrgDismissPending : isPersonalDismissPending;
  const isSavingConfig = isOrg ? isOrgSaveConfigPending : isPersonalSaveConfigPending;
  const isTogglingEnabled = isOrg ? isOrgSetEnabledPending : isPersonalSetEnabledPending;
  const isDeletingFindings = isOrg ? isOrgDeleteFindingsPending : isPersonalDeleteFindingsPending;
  const isRefreshing = isOrg ? isOrgRefreshPending : isPersonalRefreshPending;

  // Orphaned repositories data
  const orphanedRepositories = orphanedReposData ?? [];

  // GitHub App not installed - show install prompt
  const showGitHubAppRequired = !hasIntegration && !isLoadingPermission;

  // GitHub App installed but missing permissions - show reauthorize prompt
  const showPermissionRequired = hasIntegration && !hasPermission && !isLoadingPermission;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <h1 className="text-3xl font-bold">Security Agent</h1>
          <Badge variant="new">new</Badge>
        </div>
        <p className="text-muted-foreground">
          Monitor and manage Dependabot security alerts for your repositories
        </p>
        <a
          href="https://kilo.ai/docs/contributing/architecture/security-reviews"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex items-center gap-1 text-sm text-blue-400 hover:text-blue-300"
        >
          Learn how to use it
          <ExternalLink className="size-4" />
        </a>
      </div>

      {/* GitHub App Required Alert */}
      {showGitHubAppRequired && (
        <Alert>
          <Rocket className="h-4 w-4" />
          <AlertTitle>GitHub App Required</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>
              The Kilo GitHub App must be installed to use Security Agent. The app automatically
              syncs Dependabot alerts and manages security findings.
            </p>
            <Link
              href={
                isOrg ? `/organizations/${organizationId}/integrations` : '/integrations/github'
              }
            >
              <Button variant="default" size="sm">
                Install GitHub App
                <ExternalLink className="ml-2 h-3 w-3" />
              </Button>
            </Link>
          </AlertDescription>
        </Alert>
      )}

      {/* Additional Permissions Required Alert */}
      {showPermissionRequired && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Additional Permissions Required</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>
              Security Agent requires the <code>vulnerability_alerts</code> permission to access
              Dependabot alerts. Please re-authorize the GitHub App to grant this permission.
            </p>
            <div className="flex flex-wrap gap-3">
              {reauthorizeUrl && (
                <Button asChild>
                  <a href={reauthorizeUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="mr-2 h-4 w-4" />
                    Re-authorize GitHub App
                  </a>
                </Button>
              )}
              <Button
                variant="outline"
                onClick={handleRefreshPermissions}
                disabled={isRefreshing}
                className="border-border bg-background text-foreground hover:bg-accent hover:text-accent-foreground"
              >
                <RefreshCw className={`mr-2 h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
                {isRefreshing ? 'Refreshing...' : 'Refresh Permissions'}
              </Button>
            </div>
            <p className="text-sm opacity-80">
              Already approved the new permissions in GitHub? Click &quot;Refresh Permissions&quot;
              to update.
            </p>
          </AlertDescription>
        </Alert>
      )}

      {/* GitHub Integration Error Alert */}
      {gitHubError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>GitHub Integration Error</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>Failed to access GitHub: {gitHubError}</p>
            <p className="text-sm">
              This usually happens when the GitHub App has been uninstalled or permissions have
              changed. Please reinstall the GitHub App to continue running security analyses.
            </p>
            <Link href={isOrg ? `/organizations/${organizationId}/integrations` : '/integrations'}>
              <Button variant="outline" size="sm">
                Go to Integrations
                <ExternalLink className="ml-2 h-3 w-3" />
              </Button>
            </Link>
          </AlertDescription>
        </Alert>
      )}

      {/* Tabs - only show config and jobs tabs when GitHub integration is available */}
      <Tabs value={effectiveTab} onValueChange={setActiveTab} className="w-full">
        <TabsList
          className={`grid w-full max-w-lg ${hasIntegration ? 'grid-cols-3' : 'grid-cols-1'}`}
        >
          <TabsTrigger value="findings" className="flex items-center gap-2">
            <ListChecks className="h-4 w-4" />
            Findings
          </TabsTrigger>
          {hasIntegration && (
            <>
              <TabsTrigger value="jobs" className="flex items-center gap-2">
                <Brain className="h-4 w-4" />
                Analysis Jobs
              </TabsTrigger>
              <TabsTrigger value="config" className="flex items-center gap-2">
                <Settings2 className="h-4 w-4" />
                Config
              </TabsTrigger>
            </>
          )}
        </TabsList>

        {/* Findings Tab */}
        <TabsContent value="findings" className="space-y-6">
          <SecurityFindingsCard
            findings={findings}
            repositories={filteredRepositories}
            stats={stats}
            totalCount={totalCount}
            page={page}
            pageSize={PAGE_SIZE}
            onPageChange={setPage}
            onFindingClick={handleFindingClick}
            onSync={handleSync}
            isSyncing={isSyncing}
            isLoading={isLoadingFindings}
            filters={filters}
            onFiltersChange={setFilters}
            isEnabled={isEnabled}
            hasIntegration={hasIntegration}
            onEnableClick={() => setActiveTab('config')}
            lastSyncTime={lastSyncData?.lastSyncTime}
            onStartAnalysis={handleStartAnalysis}
            startingAnalysisId={startingAnalysisId}
            isAdmin={isAdmin}
          />
        </TabsContent>

        {/* Analysis Jobs Tab - only available when GitHub integration exists */}
        {hasIntegration && (
          <TabsContent value="jobs" className="space-y-6">
            <AnalysisJobsCard organizationId={organizationId} onGitHubError={setGitHubError} />
          </TabsContent>
        )}

        {/* Config Tab - only available when GitHub integration exists */}
        {hasIntegration && (
          <TabsContent value="config" className="space-y-6">
            <SecurityConfigForm
              enabled={isEnabled}
              slaConfig={slaConfig}
              repositorySelectionMode={configData?.repositorySelectionMode ?? 'selected'}
              selectedRepositoryIds={configData?.selectedRepositoryIds ?? []}
              modelSlug={configData?.modelSlug ?? ''}
              analysisMode={configData?.analysisMode ?? 'auto'}
              autoDismissEnabled={configData?.autoDismissEnabled ?? false}
              autoDismissConfidenceThreshold={configData?.autoDismissConfidenceThreshold ?? 'high'}
              repositories={allRepositories}
              onSave={handleSaveConfig}
              onToggleEnabled={handleToggleEnabled}
              isSaving={isSavingConfig}
              isToggling={isTogglingEnabled}
            />
            {/* Clear Orphaned Findings Card - only shown when there are orphaned repos */}
            <ClearFindingsCard
              orphanedRepositories={orphanedRepositories}
              onDeleteFindings={handleDeleteFindings}
              isDeleting={isDeletingFindings}
            />
          </TabsContent>
        )}
      </Tabs>

      {/* Finding Detail Dialog */}
      <FindingDetailDialog
        finding={selectedFinding}
        open={detailDialogOpen}
        onOpenChange={setDetailDialogOpen}
        onDismiss={handleOpenDismissDialog}
        canDismiss={selectedFinding?.status === 'open'}
        organizationId={organizationId}
      />

      {/* Dismiss Finding Dialog */}
      <DismissFindingDialog
        finding={selectedFinding}
        open={dismissDialogOpen}
        onOpenChange={setDismissDialogOpen}
        onDismiss={handleDismiss}
        isLoading={isDismissing}
      />
    </div>
  );
}
