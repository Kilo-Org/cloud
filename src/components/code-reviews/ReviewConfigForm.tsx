'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Checkbox } from '@/components/ui/checkbox';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import {
  Settings,
  Save,
  RefreshCw,
  Webhook,
  AlertCircle,
  CheckCircle2,
  Copy,
  Check,
  ExternalLink,
  ChevronDown,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { useTRPC, useRawTRPCClient } from '@/lib/trpc/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useState, useEffect, useCallback } from 'react';
import { useRefreshRepositories } from '@/hooks/useRefreshRepositories';
import { useOrganizationModels } from '@/components/cloud-agent/hooks/useOrganizationModels';
import { ModelCombobox } from '@/components/shared/ModelCombobox';
import { cn } from '@/lib/utils';
import { RepositoryMultiSelect, type Repository } from './RepositoryMultiSelect';
import { PRIMARY_DEFAULT_MODEL } from '@/lib/models';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

type Platform = 'github' | 'gitlab';

export type GitLabStatusData = {
  connected: boolean;
  integration?: {
    isValid: boolean;
    webhookSecret?: string;
    instanceUrl?: string;
  };
};

export type ReviewConfigFormProps = {
  organizationId?: string;
  platform?: Platform;
  gitlabStatusData?: GitLabStatusData;
};

const FOCUS_AREAS = [
  { id: 'security', label: 'Security vulnerabilities', description: 'SQL injection, XSS, etc.' },
  { id: 'performance', label: 'Performance issues', description: 'N+1 queries, inefficient loops' },
  { id: 'bugs', label: 'Bug detection', description: 'Logic errors, edge cases' },
  { id: 'style', label: 'Code style', description: 'Formatting, naming conventions' },
  { id: 'testing', label: 'Test coverage', description: 'Missing or inadequate tests' },
  { id: 'documentation', label: 'Documentation', description: 'Missing comments, unclear APIs' },
] as const;

const REVIEW_STYLES = [
  {
    value: 'strict',
    label: 'Strict',
    description: 'Flag all potential issues, prioritize quality and security',
  },
  {
    value: 'balanced',
    label: 'Balanced',
    description: 'Focus on confidence, balance thoroughness with practicality',
  },
  {
    value: 'lenient',
    label: 'Lenient',
    description: 'Only critical bugs and security issues, be encouraging',
  },
] as const;

export function ReviewConfigForm({
  organizationId,
  platform = 'github',
  gitlabStatusData,
}: ReviewConfigFormProps) {
  const trpc = useTRPC();
  const trpcClient = useRawTRPCClient();
  const queryClient = useQueryClient();
  const isGitLab = platform === 'gitlab';
  const platformLabel = isGitLab ? 'GitLab' : 'GitHub';
  const prLabel = isGitLab ? 'merge requests' : 'pull requests';

  // Fetch current config
  const {
    data: configData,
    isLoading,
    refetch,
  } = useQuery(
    organizationId
      ? trpc.organizations.reviewAgent.getReviewConfig.queryOptions({
          organizationId,
          platform,
        })
      : trpc.personalReviewAgent.getReviewConfig.queryOptions({ platform })
  );

  // Fetch repositories based on platform (cached by default)
  const {
    data: repositoriesData,
    isLoading: isLoadingRepositories,
    error: repositoriesError,
  } = useQuery(
    organizationId
      ? isGitLab
        ? trpc.organizations.reviewAgent.listGitLabRepositories.queryOptions({
            organizationId,
            forceRefresh: false,
          })
        : trpc.organizations.reviewAgent.listGitHubRepositories.queryOptions({
            organizationId,
            forceRefresh: false,
          })
      : isGitLab
        ? trpc.personalReviewAgent.listGitLabRepositories.queryOptions({
            forceRefresh: false,
          })
        : trpc.personalReviewAgent.listGitHubRepositories.queryOptions({
            forceRefresh: false,
          })
  );

  // Refresh repositories hook
  const { refresh: refreshRepositories, isRefreshing: isRefreshingRepos } = useRefreshRepositories({
    getRefreshQueryOptions: useCallback(
      () =>
        organizationId
          ? isGitLab
            ? trpc.organizations.reviewAgent.listGitLabRepositories.queryOptions({
                organizationId,
                forceRefresh: true,
              })
            : trpc.organizations.reviewAgent.listGitHubRepositories.queryOptions({
                organizationId,
                forceRefresh: true,
              })
          : isGitLab
            ? trpc.personalReviewAgent.listGitLabRepositories.queryOptions({
                forceRefresh: true,
              })
            : trpc.personalReviewAgent.listGitHubRepositories.queryOptions({
                forceRefresh: true,
              }),
      [organizationId, trpc, isGitLab]
    ),
    getCacheQueryKey: useCallback(
      () =>
        organizationId
          ? isGitLab
            ? trpc.organizations.reviewAgent.listGitLabRepositories.queryKey({
                organizationId,
                forceRefresh: false,
              })
            : trpc.organizations.reviewAgent.listGitHubRepositories.queryKey({
                organizationId,
                forceRefresh: false,
              })
          : isGitLab
            ? trpc.personalReviewAgent.listGitLabRepositories.queryKey({
                forceRefresh: false,
              })
            : trpc.personalReviewAgent.listGitHubRepositories.queryKey({
                forceRefresh: false,
              }),
      [organizationId, trpc, isGitLab]
    ),
  });

  // Fetch available models
  const { modelOptions, isLoadingModels } = useOrganizationModels(organizationId);

  // Local state
  const [isEnabled, setIsEnabled] = useState(false);
  const [reviewStyle, setReviewStyle] = useState<'strict' | 'balanced' | 'lenient'>('balanced');
  const [focusAreas, setFocusAreas] = useState<string[]>([]);
  const [customInstructions, setCustomInstructions] = useState('');
  const [maxReviewTime, setMaxReviewTime] = useState([10]);
  const [selectedModel, setSelectedModel] = useState(PRIMARY_DEFAULT_MODEL);
  const [repositorySelectionMode, setRepositorySelectionMode] = useState<'all' | 'selected'>('all');
  const [selectedRepositoryIds, setSelectedRepositoryIds] = useState<number[]>([]);
  // Manually added repositories (for GitLab where pagination limits results)
  const [manuallyAddedRepos, setManuallyAddedRepos] = useState<Repository[]>([]);
  // GitLab-specific: auto-configure webhooks
  const [autoConfigureWebhooks, setAutoConfigureWebhooks] = useState(true);
  // Webhook sync result from last save
  const [webhookSyncResult, setWebhookSyncResult] = useState<{
    created: number;
    updated: number;
    deleted: number;
    errors: Array<{ projectId: number; error: string; operation: string }>;
  } | null>(null);
  // Manual webhook configuration state
  const [showManualWebhookSetup, setShowManualWebhookSetup] = useState(false);
  const [copiedWebhookUrl, setCopiedWebhookUrl] = useState(false);
  const [copiedWebhookSecret, setCopiedWebhookSecret] = useState(false);
  const [regeneratedSecret, setRegeneratedSecret] = useState<string | null>(null);

  // Get webhook URL for GitLab
  const webhookUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/webhooks/gitlab`
      : '/api/webhooks/gitlab';

  // Mutation for regenerating webhook secret
  const regenerateSecretMutation = useMutation(
    trpc.gitlab.regenerateWebhookSecret.mutationOptions({
      onSuccess: data => {
        setRegeneratedSecret(data.webhookSecret);
        toast.success('Webhook secret regenerated successfully');
        // Invalidate the GitLab status query to refresh the data
        void queryClient.invalidateQueries({
          queryKey: trpc.personalReviewAgent.getGitLabStatus.queryKey(),
        });
      },
      onError: error => {
        toast.error('Failed to regenerate webhook secret', {
          description: error.message,
        });
      },
    })
  );

  const handleRegenerateSecret = () => {
    setRegeneratedSecret(null); // Clear any previously shown secret
    regenerateSecretMutation.mutate({});
  };

  const handleCopyWebhookUrl = async () => {
    await navigator.clipboard.writeText(webhookUrl);
    setCopiedWebhookUrl(true);
    toast.success('Webhook URL copied to clipboard');
    setTimeout(() => setCopiedWebhookUrl(false), 2000);
  };

  const handleCopyWebhookSecret = async () => {
    const secret = gitlabStatusData?.integration?.webhookSecret;
    if (secret) {
      await navigator.clipboard.writeText(secret);
      setCopiedWebhookSecret(true);
      toast.success('Webhook secret copied to clipboard');
      setTimeout(() => setCopiedWebhookSecret(false), 2000);
    }
  };

  const handleCopyRegeneratedSecret = async () => {
    if (regeneratedSecret) {
      await navigator.clipboard.writeText(regeneratedSecret);
      setCopiedWebhookSecret(true);
      toast.success('New webhook secret copied to clipboard');
      setTimeout(() => setCopiedWebhookSecret(false), 2000);
    }
  };

  // Update local state when config loads
  useEffect(() => {
    if (configData) {
      setIsEnabled(configData.isEnabled);
      setReviewStyle(configData.reviewStyle);
      setFocusAreas(configData.focusAreas);
      setCustomInstructions(configData.customInstructions || '');
      setMaxReviewTime([configData.maxReviewTimeMinutes]);
      setSelectedModel(configData.modelSlug);
      // For GitLab, default to 'selected' mode since 'all' is not supported
      const repoMode = configData.repositorySelectionMode || 'all';
      setRepositorySelectionMode(isGitLab ? 'selected' : repoMode);
      setSelectedRepositoryIds(configData.selectedRepositoryIds || []);
      // Load manually added repositories from config
      if (configData.manuallyAddedRepositories) {
        setManuallyAddedRepos(
          configData.manuallyAddedRepositories.map(repo => ({
            id: repo.id,
            name: repo.name,
            full_name: repo.full_name,
            private: repo.private,
          }))
        );
      }
    }
  }, [configData, isGitLab]);

  // Organization mutations
  const orgToggleMutation = useMutation(
    trpc.organizations.reviewAgent.toggleReviewAgent.mutationOptions({
      onSuccess: async data => {
        toast.success(data.isEnabled ? 'Code Reviewer enabled' : 'Code Reviewer disabled');
        setIsEnabled(data.isEnabled);
        await refetch();
      },
      onError: error => {
        toast.error('Failed to toggle Code Reviewer', {
          description: error.message,
        });
      },
    })
  );

  const orgSaveMutation = useMutation(
    trpc.organizations.reviewAgent.saveReviewConfig.mutationOptions({
      onSuccess: async data => {
        // Handle webhook sync result for GitLab
        if (data.webhookSync) {
          setWebhookSyncResult(data.webhookSync);
          const { created, updated, deleted, errors } = data.webhookSync;
          if (errors.length > 0) {
            toast.warning('Configuration saved with webhook errors', {
              description: `${errors.length} webhook(s) failed to configure`,
            });
          } else if (created > 0 || updated > 0 || deleted > 0) {
            toast.success('Configuration saved', {
              description: `Webhooks: ${created} created, ${updated} updated, ${deleted} removed`,
            });
          } else {
            toast.success('Review configuration saved');
          }
        } else {
          toast.success('Review configuration saved');
        }
        await refetch();
      },
      onError: error => {
        toast.error('Failed to save configuration', {
          description: error.message,
        });
      },
    })
  );

  // Personal mutations
  const personalToggleMutation = useMutation(
    trpc.personalReviewAgent.toggleReviewAgent.mutationOptions({
      onSuccess: async data => {
        toast.success(data.isEnabled ? 'Code Reviewer enabled' : 'Code Reviewer disabled');
        setIsEnabled(data.isEnabled);
        await refetch();
      },
      onError: error => {
        toast.error('Failed to toggle Code Reviewer', {
          description: error.message,
        });
      },
    })
  );

  const personalSaveMutation = useMutation(
    trpc.personalReviewAgent.saveReviewConfig.mutationOptions({
      onSuccess: async data => {
        // Handle webhook sync result for GitLab
        if (data.webhookSync) {
          setWebhookSyncResult(data.webhookSync);
          const { created, updated, deleted, errors } = data.webhookSync;
          if (errors.length > 0) {
            toast.warning('Configuration saved with webhook errors', {
              description: `${errors.length} webhook(s) failed to configure`,
            });
          } else if (created > 0 || updated > 0 || deleted > 0) {
            toast.success('Configuration saved', {
              description: `Webhooks: ${created} created, ${updated} updated, ${deleted} removed`,
            });
          } else {
            toast.success('Review configuration saved');
          }
        } else {
          toast.success('Review configuration saved');
        }
        await refetch();
      },
      onError: error => {
        toast.error('Failed to save configuration', {
          description: error.message,
        });
      },
    })
  );

  const handleToggle = (checked: boolean) => {
    if (organizationId) {
      orgToggleMutation.mutate({
        organizationId,
        platform,
        isEnabled: checked,
      });
    } else {
      personalToggleMutation.mutate({
        platform,
        isEnabled: checked,
      });
    }
  };

  const handleSave = () => {
    // Clear previous webhook sync result
    setWebhookSyncResult(null);

    // Convert manually added repos to the format expected by the API
    const manuallyAddedRepositories = manuallyAddedRepos.map(repo => ({
      id: repo.id,
      name: repo.name,
      full_name: repo.full_name,
      private: repo.private,
    }));

    if (organizationId) {
      orgSaveMutation.mutate({
        organizationId,
        platform,
        reviewStyle,
        focusAreas,
        customInstructions: customInstructions.trim() || undefined,
        maxReviewTimeMinutes: maxReviewTime[0],
        modelSlug: selectedModel,
        repositorySelectionMode,
        selectedRepositoryIds,
        manuallyAddedRepositories,
        // GitLab-specific: auto-configure webhooks
        autoConfigureWebhooks: isGitLab ? autoConfigureWebhooks : undefined,
      });
    } else {
      personalSaveMutation.mutate({
        platform,
        reviewStyle,
        focusAreas,
        customInstructions: customInstructions.trim() || undefined,
        maxReviewTimeMinutes: maxReviewTime[0],
        modelSlug: selectedModel,
        repositorySelectionMode,
        selectedRepositoryIds,
        manuallyAddedRepositories,
        // GitLab-specific: auto-configure webhooks
        autoConfigureWebhooks: isGitLab ? autoConfigureWebhooks : undefined,
      });
    }
  };

  const handleFocusAreaToggle = (areaId: string) => {
    setFocusAreas(prev =>
      prev.includes(areaId) ? prev.filter(id => id !== areaId) : [...prev, areaId]
    );
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5" />
            Review Configuration
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="animate-pulse space-y-4">
            <div className="bg-muted h-20 rounded" />
            <div className="bg-muted h-32 rounded" />
            <div className="bg-muted h-20 rounded" />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="mb-4">
        <CardTitle className="flex items-center gap-2">
          <Settings className="h-5 w-5" />
          Review Configuration
        </CardTitle>
        <CardDescription>
          Customize how Code Reviewer analyzes your {prLabel} and the AI model
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-8">
          {/* Enable/Disable Toggle */}
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="space-y-0.5">
              <Label htmlFor="enable-agent" className="text-base font-semibold">
                Enable AI Code Review
              </Label>
              <p className="text-muted-foreground text-sm">
                Automatically review {prLabel} when they are opened or updated
              </p>
            </div>
            <Switch
              id="enable-agent"
              checked={isEnabled}
              onCheckedChange={handleToggle}
              disabled={orgToggleMutation.isPending || personalToggleMutation.isPending}
            />
          </div>

          {/* Configuration Fields */}
          <div className={cn('space-y-8', !isEnabled && 'pointer-events-none opacity-50')}>
            {/* AI Model Selection */}
            <ModelCombobox
              label="AI Model"
              models={modelOptions}
              value={selectedModel}
              onValueChange={setSelectedModel}
              isLoading={isLoadingModels}
              helperText="Choose the AI model to use for code reviews"
            />

            {/* Review Style */}
            <div className="space-y-3">
              <Label>Review Style</Label>
              <RadioGroup
                value={reviewStyle}
                onValueChange={value => setReviewStyle(value as 'strict' | 'balanced' | 'lenient')}
              >
                {REVIEW_STYLES.map(style => (
                  <div key={style.value} className="flex items-start space-y-0 space-x-3">
                    <RadioGroupItem value={style.value} id={style.value} />
                    <div className="flex-1 space-y-1">
                      <Label htmlFor={style.value} className="font-medium">
                        {style.label}
                      </Label>
                      <p className="text-muted-foreground text-sm">{style.description}</p>
                    </div>
                  </div>
                ))}
              </RadioGroup>
            </div>

            {/* Repository Selection */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <Label>Repository Selection</Label>
                  <p className="text-muted-foreground text-sm">
                    Choose which repositories should trigger automatic code reviews
                  </p>
                </div>
                {repositoriesData?.integrationInstalled && (
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground text-xs">
                      Last synced:{' '}
                      {repositoriesData.syncedAt
                        ? formatDistanceToNow(new Date(repositoriesData.syncedAt), {
                            addSuffix: true,
                          })
                        : 'Never'}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={refreshRepositories}
                      disabled={isRefreshingRepos || isLoadingRepositories}
                    >
                      <RefreshCw className={cn('h-4 w-4', isRefreshingRepos && 'animate-spin')} />
                    </Button>
                  </div>
                )}
              </div>

              {isLoadingRepositories ? (
                <div className="rounded-md border border-gray-600 bg-gray-800/50 p-3">
                  <p className="text-sm text-gray-400">Loading repositories...</p>
                </div>
              ) : repositoriesError ? (
                <div className="rounded-md border border-red-500/50 bg-red-500/10 p-3">
                  <p className="text-sm text-red-200">
                    Failed to load repositories. Please try refreshing the page.
                  </p>
                </div>
              ) : !repositoriesData?.integrationInstalled ? (
                <div className="rounded-md border border-yellow-500/50 bg-yellow-500/10 p-3">
                  <p className="text-sm text-yellow-200">
                    {repositoriesData?.errorMessage ||
                      `${platformLabel} integration is not connected. Please connect ${platformLabel} in the Integrations page to configure repository selection.`}
                  </p>
                </div>
              ) : repositoriesData.repositories.length === 0 ? (
                <div className="rounded-md border border-yellow-500/50 bg-yellow-500/10 p-3">
                  <p className="text-sm text-yellow-200">
                    No repositories found. Please ensure the {platformLabel}{' '}
                    {isGitLab ? 'integration' : 'App'} has access to your repositories.
                  </p>
                </div>
              ) : (
                <>
                  {/* For GitLab, only show "Selected repositories" since "All" is not supported */}
                  {!isGitLab && (
                    <RadioGroup
                      value={repositorySelectionMode}
                      onValueChange={value =>
                        setRepositorySelectionMode(value as 'all' | 'selected')
                      }
                      className="space-y-3"
                    >
                      <div className="flex items-center space-x-3">
                        <RadioGroupItem value="all" id="all-repos" />
                        <Label htmlFor="all-repos" className="cursor-pointer font-normal">
                          All repositories ({repositoriesData.repositories.length})
                        </Label>
                      </div>
                      <div className="flex items-start space-x-3">
                        <RadioGroupItem value="selected" id="selected-repos" className="mt-1" />
                        <Label htmlFor="selected-repos" className="cursor-pointer font-normal">
                          Selected repositories
                        </Label>
                      </div>
                    </RadioGroup>
                  )}

                  {/* For GitLab, always show the multi-select; for GitHub, only when 'selected' mode */}
                  {(isGitLab || repositorySelectionMode === 'selected') && (
                    <div className="mt-4">
                      <RepositoryMultiSelect
                        repositories={
                          [
                            ...repositoriesData.repositories.map(repo => ({
                              id: repo.id,
                              name: repo.name,
                              full_name: repo.fullName,
                              private: repo.private,
                            })),
                            ...manuallyAddedRepos,
                          ] as Repository[]
                        }
                        selectedIds={selectedRepositoryIds}
                        onSelectionChange={setSelectedRepositoryIds}
                        allowManualAdd={isGitLab}
                        onManualAdd={repo => {
                          // Add to manually added repos and auto-select it
                          setManuallyAddedRepos(prev => [...prev, repo]);
                          setSelectedRepositoryIds(prev => [...prev, repo.id]);
                        }}
                        onSearch={
                          isGitLab
                            ? async (query: string) => {
                                // Call the appropriate search endpoint based on context
                                if (organizationId) {
                                  const result =
                                    await trpcClient.organizations.reviewAgent.searchGitLabRepositories.query(
                                      {
                                        organizationId,
                                        query,
                                      }
                                    );
                                  return result.repositories.map(repo => ({
                                    id: repo.id,
                                    name: repo.name,
                                    full_name: repo.fullName,
                                    private: repo.private,
                                  }));
                                } else {
                                  const result =
                                    await trpcClient.personalReviewAgent.searchGitLabRepositories.query(
                                      {
                                        query,
                                      }
                                    );
                                  return result.repositories.map(repo => ({
                                    id: repo.id,
                                    name: repo.name,
                                    full_name: repo.fullName,
                                    private: repo.private,
                                  }));
                                }
                              }
                            : undefined
                        }
                      />
                    </div>
                  )}
                </>
              )}
            </div>

            {/* GitLab Webhook Configuration */}
            {isGitLab &&
              repositorySelectionMode === 'selected' &&
              repositoriesData?.integrationInstalled && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Webhook className="text-muted-foreground h-4 w-4" />
                    <Label>Webhook Configuration</Label>
                  </div>
                  <div className="flex items-start space-x-3">
                    <Checkbox
                      id="auto-configure-webhooks"
                      checked={autoConfigureWebhooks}
                      onCheckedChange={checked => setAutoConfigureWebhooks(checked === true)}
                    />
                    <div className="grid gap-1.5 leading-none">
                      <Label
                        htmlFor="auto-configure-webhooks"
                        className="cursor-pointer leading-none font-medium"
                      >
                        Automatically configure webhooks
                      </Label>
                      <p className="text-muted-foreground text-sm">
                        Automatically create and manage webhooks for selected repositories. Webhooks
                        will be created when repositories are added and removed when they are
                        deselected.
                      </p>
                    </div>
                  </div>

                  {/* Webhook Sync Result */}
                  {webhookSyncResult && (
                    <div className="mt-3">
                      {webhookSyncResult.errors.length > 0 ? (
                        <Alert variant="destructive">
                          <AlertCircle className="h-4 w-4" />
                          <AlertTitle>Webhook Configuration Errors</AlertTitle>
                          <AlertDescription>
                            <p className="mb-2">
                              Some webhooks could not be configured. You may need to configure them
                              manually.
                            </p>
                            <ul className="list-disc pl-4 text-sm">
                              {webhookSyncResult.errors.map((err, idx) => (
                                <li key={idx}>
                                  Project {err.projectId}: {err.error}
                                </li>
                              ))}
                            </ul>
                          </AlertDescription>
                        </Alert>
                      ) : (
                        (webhookSyncResult.created > 0 ||
                          webhookSyncResult.updated > 0 ||
                          webhookSyncResult.deleted > 0) && (
                          <Alert>
                            <CheckCircle2 className="h-4 w-4" />
                            <AlertTitle>Webhooks Configured</AlertTitle>
                            <AlertDescription>
                              {webhookSyncResult.created > 0 && (
                                <span className="mr-3">{webhookSyncResult.created} created</span>
                              )}
                              {webhookSyncResult.updated > 0 && (
                                <span className="mr-3">{webhookSyncResult.updated} updated</span>
                              )}
                              {webhookSyncResult.deleted > 0 && (
                                <span>{webhookSyncResult.deleted} removed</span>
                              )}
                            </AlertDescription>
                          </Alert>
                        )
                      )}
                    </div>
                  )}

                  {/* Manual Webhook Setup - Expandable Section */}
                  <div className="mt-4">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowManualWebhookSetup(!showManualWebhookSetup)}
                      className="text-muted-foreground hover:text-foreground flex h-auto items-center gap-2 p-0 text-sm"
                    >
                      <ChevronDown
                        className={cn(
                          'h-4 w-4 transition-transform',
                          showManualWebhookSetup && 'rotate-180'
                        )}
                      />
                      {showManualWebhookSetup ? 'Hide' : 'Show'} manual webhook setup instructions
                    </Button>

                    {showManualWebhookSetup && (
                      <div className="mt-4 space-y-4 rounded-lg border p-4">
                        <p className="text-muted-foreground text-sm">
                          If automatic webhook configuration fails or you prefer to configure
                          webhooks manually, use the following details:
                        </p>

                        {/* Webhook URL */}
                        <div className="space-y-2">
                          <label className="text-sm font-medium">Webhook URL</label>
                          <div className="flex items-center gap-2">
                            <code className="bg-muted flex-1 rounded px-3 py-2 font-mono text-sm break-all">
                              {webhookUrl}
                            </code>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={handleCopyWebhookUrl}
                              className="shrink-0"
                            >
                              {copiedWebhookUrl ? (
                                <Check className="h-4 w-4 text-green-500" />
                              ) : (
                                <Copy className="h-4 w-4" />
                              )}
                            </Button>
                          </div>
                        </div>

                        {/* Secret Token */}
                        <div className="space-y-2">
                          <label className="text-sm font-medium">Secret Token</label>
                          {regeneratedSecret ? (
                            <>
                              <div className="flex items-center gap-2">
                                <code className="bg-muted flex-1 rounded px-3 py-2 font-mono text-sm break-all">
                                  {regeneratedSecret}
                                </code>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={handleCopyRegeneratedSecret}
                                  className="shrink-0"
                                >
                                  {copiedWebhookSecret ? (
                                    <Check className="h-4 w-4 text-green-500" />
                                  ) : (
                                    <Copy className="h-4 w-4" />
                                  )}
                                </Button>
                              </div>
                              <div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 p-2">
                                <p className="text-xs text-yellow-200">
                                  <strong>Important:</strong> Copy this secret now! It won't be
                                  shown again. Update your GitLab webhook settings with this new
                                  secret.
                                </p>
                              </div>
                            </>
                          ) : gitlabStatusData?.integration?.webhookSecret ? (
                            <>
                              <div className="flex items-center gap-2">
                                <code className="bg-muted flex-1 rounded px-3 py-2 font-mono text-sm">
                                  ••••••••••••••••
                                </code>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={handleCopyWebhookSecret}
                                  className="shrink-0"
                                >
                                  {copiedWebhookSecret ? (
                                    <Check className="h-4 w-4 text-green-500" />
                                  ) : (
                                    <Copy className="h-4 w-4" />
                                  )}
                                </Button>
                              </div>
                              <p className="text-muted-foreground text-xs">
                                Use this secret token in your GitLab webhook configuration for
                                security.
                              </p>
                            </>
                          ) : (
                            <p className="text-muted-foreground text-sm">
                              No webhook secret configured. Click regenerate to create one.
                            </p>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={handleRegenerateSecret}
                            disabled={regenerateSecretMutation.isPending}
                            className="mt-2"
                          >
                            <RefreshCw
                              className={cn(
                                'mr-2 h-4 w-4',
                                regenerateSecretMutation.isPending && 'animate-spin'
                              )}
                            />
                            {regenerateSecretMutation.isPending
                              ? 'Regenerating...'
                              : 'Regenerate Secret'}
                          </Button>
                        </div>

                        {/* Setup Instructions */}
                        <div className="rounded-md border border-blue-500/30 bg-blue-500/10 p-3">
                          <p className="text-sm text-blue-200">
                            <strong>Setup Instructions:</strong>
                          </p>
                          <ol className="mt-2 list-inside list-decimal space-y-1 text-sm text-blue-200/80">
                            <li>Go to your GitLab project → Settings → Webhooks</li>
                            <li>Paste the Webhook URL above</li>
                            <li>Add the Secret Token for security</li>
                            <li>Select "Merge request events" as the trigger</li>
                            <li>Click "Add webhook"</li>
                          </ol>
                        </div>

                        <a
                          href={`${gitlabStatusData?.integration?.instanceUrl || 'https://gitlab.com'}/-/profile/applications`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-sm text-blue-400 hover:text-blue-300"
                        >
                          Open GitLab Settings
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      </div>
                    )}
                  </div>
                </div>
              )}

            {/* Focus Areas */}
            <div className="space-y-3">
              <Label>Focus Areas</Label>
              <p className="text-muted-foreground mb-3 text-sm">
                Select specific areas for the agent to pay special attention to
              </p>
              <div className="space-y-3">
                {FOCUS_AREAS.map(area => (
                  <div key={area.id} className="flex items-start space-x-3">
                    <Checkbox
                      id={area.id}
                      checked={focusAreas.includes(area.id)}
                      onCheckedChange={() => handleFocusAreaToggle(area.id)}
                    />
                    <div className="grid gap-1.5 leading-none">
                      <Label
                        htmlFor={area.id}
                        className="cursor-pointer leading-none font-medium peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                      >
                        {area.label}
                      </Label>
                      <p className="text-muted-foreground text-sm">{area.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Max Review Time */}
            <div className="space-y-3">
              <Label>Maximum Review Time: {maxReviewTime[0]} minutes</Label>
              <Slider
                value={maxReviewTime}
                onValueChange={setMaxReviewTime}
                min={5}
                max={30}
                step={1}
                className="w-full"
              />
              <p className="text-muted-foreground text-sm">
                Timeout for the code review workflow (5-30 minutes)
              </p>
            </div>

            {/* Custom Instructions */}
            <div className="space-y-3">
              <Label htmlFor="custom-instructions">Custom Instructions (Optional)</Label>
              <Textarea
                id="custom-instructions"
                placeholder="e.g., 'Always check for TypeScript strict mode compliance' or 'Focus on React best practices'"
                value={customInstructions}
                onChange={e => setCustomInstructions(e.target.value)}
                rows={4}
                className="resize-none"
              />
              <p className="text-muted-foreground text-sm">
                Add specific guidelines for your team's code review standards
              </p>
            </div>

            {/* Save Button */}
            <div className="flex justify-end pt-2">
              <Button
                onClick={handleSave}
                disabled={orgSaveMutation.isPending || personalSaveMutation.isPending || !isEnabled}
              >
                <Save className="mr-2 h-4 w-4" />
                {orgSaveMutation.isPending || personalSaveMutation.isPending
                  ? 'Saving...'
                  : 'Save Configuration'}
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
