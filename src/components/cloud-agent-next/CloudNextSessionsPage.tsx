'use client';

import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRefreshRepositories } from '@/hooks/useRefreshRepositories';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button, LinkButton } from '@/components/Button';
import { Button as UIButton } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useTRPC, useRawTRPCClient } from '@/lib/trpc/utils';
import { useRouter } from 'next/navigation';
import { AlertCircle, ExternalLink, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';
import { PageLayout } from '@/components/PageLayout';
import { useProfile, useProfiles, useCombinedProfiles } from '@/hooks/useCloudAgentProfiles';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import {
  manualEnvVarsAtom,
  manualSetupCommandsAtom,
  selectedProfileIdAtom,
  hasAutoSelectedDefaultAtom,
  profileConfigAtom,
  effectiveEnvVarsAtom,
  effectiveSetupCommandsAtom,
  resetSessionFormAtom,
} from '@/components/cloud-agent/store/session-form-atoms';
import { useOrganizationDefaults } from '@/app/api/organizations/hooks';
import { useModelSelectorList } from '@/app/api/openrouter/hooks';
import {
  RepositoryCombobox,
  type RepositoryOption,
  type RepositoryPlatform,
} from '@/components/shared/RepositoryCombobox';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { ModeCombobox, NEXT_MODE_OPTIONS } from '@/components/shared/ModeCombobox';
import { InsufficientBalanceBanner } from '@/components/shared/InsufficientBalanceBanner';
import { AdvancedConfig } from '@/components/shared/AdvancedConfig';
import { cn } from '@/lib/utils';
import type { AgentMode } from './types';

type CloudNextSessionsPageProps = {
  organizationId?: string;
};

type Repository = {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
};

export function CloudNextSessionsPage({ organizationId }: CloudNextSessionsPageProps) {
  const router = useRouter();
  const trpc = useTRPC();
  const trpcClient = useRawTRPCClient();
  const queryClient = useQueryClient();

  // Fetch eligibility to check if user can use Cloud Agent
  // Use separate queries for personal vs org context to ensure correct balance is checked
  const personalEligibilityQuery = useQuery({
    ...trpc.cloudAgent.checkEligibility.queryOptions(),
    enabled: !organizationId,
  });
  const orgEligibilityQuery = useQuery({
    ...trpc.organizations.cloudAgent.checkEligibility.queryOptions({
      organizationId: organizationId || '',
    }),
    enabled: !!organizationId,
  });
  const eligibilityData = organizationId ? orgEligibilityQuery.data : personalEligibilityQuery.data;
  const isEligibilityLoading = organizationId
    ? orgEligibilityQuery.isPending
    : personalEligibilityQuery.isPending;
  const hasInsufficientBalance =
    !isEligibilityLoading && eligibilityData && !eligibilityData.isEligible;

  // Fetch organization configuration and models
  const { data: modelsData } = useModelSelectorList(organizationId);
  const { data: defaultsData } = useOrganizationDefaults(organizationId);

  const allModels = modelsData?.data || [];

  // Format models for the combobox (ModelOption format: id, name)
  const modelOptions = useMemo<ModelOption[]>(
    () => allModels.map(model => ({ id: model.id, name: model.name })),
    [allModels]
  );

  // Form state
  const [prompt, setPrompt] = useState('');
  const [selectedRepo, setSelectedRepo] = useState('');
  const [selectedPlatform, setSelectedPlatform] = useState<RepositoryPlatform>('github');
  const [mode, setMode] = useState<AgentMode>('build');
  const [model, setModel] = useState<string>('');
  const [isModelUserSelected, setIsModelUserSelected] = useState(false);
  const [isPreparing, setIsPreparing] = useState(false);

  // Session form atoms (profile/env/commands)
  const [manualEnvVars, setManualEnvVars] = useAtom(manualEnvVarsAtom);
  const [manualSetupCommands, setManualSetupCommands] = useAtom(manualSetupCommandsAtom);
  const [selectedProfileId, setSelectedProfileId] = useAtom(selectedProfileIdAtom);
  const [hasAutoSelectedDefault, setHasAutoSelectedDefault] = useAtom(hasAutoSelectedDefaultAtom);
  const setProfileConfig = useSetAtom(profileConfigAtom);
  const effectiveEnvVars = useAtomValue(effectiveEnvVarsAtom);
  const effectiveSetupCommands = useAtomValue(effectiveSetupCommandsAtom);
  const resetSessionForm = useSetAtom(resetSessionFormAtom);

  // Clear any lingering manual overrides whenever the page loads
  useEffect(() => {
    resetSessionForm();
  }, [resetSessionForm]);

  // Set or reset model when defaults change (organization switch or initial load)
  useEffect(() => {
    // If no models are available, clear the selection to prevent invalid submissions
    if (modelOptions.length === 0) {
      if (model) {
        setModel('');
        setIsModelUserSelected(false);
      }
      return;
    }

    // If current model is not in the available models list, or if we don't have a model yet,
    // reset to an allowed model
    const isCurrentModelAvailable = modelOptions.some(m => m.id === model);
    if (!isCurrentModelAvailable || !model || !isModelUserSelected) {
      // Prefer the default model if it's in the allow list, otherwise use the first available
      const defaultModel = defaultsData?.defaultModel;
      const isDefaultAllowed = defaultModel && modelOptions.some(m => m.id === defaultModel);
      const newModel = isDefaultAllowed ? defaultModel : modelOptions[0]?.id;

      if (newModel && newModel !== model) {
        setModel(newModel);
        setIsModelUserSelected(false); // Auto-selected, not user-selected
      }
    }
  }, [defaultsData?.defaultModel, modelOptions, model, isModelUserSelected]);

  // Fetch profiles list to find default profile
  // In org context, use combined profiles to get both org and personal profiles
  const { data: combinedProfilesData } = useCombinedProfiles({
    organizationId: organizationId ?? '',
    enabled: !!organizationId,
  });
  const { data: personalProfiles } = useProfiles({
    organizationId: undefined,
    enabled: !organizationId,
  });

  // Get all profiles and effective default based on context
  const allProfiles = organizationId
    ? [
        ...(combinedProfilesData?.orgProfiles ?? []),
        ...(combinedProfilesData?.personalProfiles ?? []),
      ]
    : (personalProfiles ?? []);
  const effectiveDefaultId = organizationId
    ? combinedProfilesData?.effectiveDefaultId
    : personalProfiles?.find(p => p.isDefault)?.id;

  // Auto-select effective default profile on initial load
  useEffect(() => {
    if (!hasAutoSelectedDefault && !selectedProfileId && effectiveDefaultId) {
      setSelectedProfileId(effectiveDefaultId);
      setHasAutoSelectedDefault(true);
    } else if (!hasAutoSelectedDefault && allProfiles.length > 0) {
      // Mark as auto-selected even if no default exists
      setHasAutoSelectedDefault(true);
    }
  }, [
    allProfiles.length,
    effectiveDefaultId,
    hasAutoSelectedDefault,
    selectedProfileId,
    setSelectedProfileId,
    setHasAutoSelectedDefault,
  ]);

  // If a profile is deleted from the list, clear the selection so derived counts reset
  useEffect(() => {
    if (!selectedProfileId || allProfiles.length === 0) {
      return;
    }
    const stillPresent = allProfiles.some(p => p.id === selectedProfileId);
    if (!stillPresent) {
      setSelectedProfileId(null);
      setProfileConfig(null);
    }
  }, [allProfiles, selectedProfileId, setProfileConfig, setSelectedProfileId]);

  // Fetch selected profile data
  const { data: selectedProfile } = useProfile(selectedProfileId || '', {
    organizationId,
    enabled: !!selectedProfileId,
  });

  // Update profile config atom when profile data is loaded
  useEffect(() => {
    if (selectedProfile) {
      setProfileConfig({
        vars: selectedProfile.vars.map(v => ({
          key: v.key,
          value: v.value,
          isSecret: v.isSecret,
        })),
        commands: selectedProfile.commands
          .sort((a, b) => a.sequence - b.sequence)
          .map(c => c.command),
      });
    } else {
      setProfileConfig(null);
    }
  }, [selectedProfile, setProfileConfig]);

  // Profile selection handler
  const handleProfileSelect = useCallback(
    (profileId: string | null) => {
      setSelectedProfileId(profileId);
    },
    [setSelectedProfileId]
  );

  // Fetch GitHub repositories
  const {
    data: githubRepoData,
    isLoading: isLoadingGitHubRepos,
    error: githubRepoError,
  } = useQuery(
    organizationId
      ? trpc.organizations.cloudAgentNext.listGitHubRepositories.queryOptions({
          organizationId,
          forceRefresh: false,
        })
      : trpc.cloudAgentNext.listGitHubRepositories.queryOptions({
          forceRefresh: false,
        })
  );

  // Fetch GitLab repositories
  const {
    data: gitlabRepoData,
    isLoading: isLoadingGitLabRepos,
    error: gitlabRepoError,
  } = useQuery(
    organizationId
      ? trpc.organizations.cloudAgentNext.listGitLabRepositories.queryOptions({
          organizationId,
          forceRefresh: false,
        })
      : trpc.cloudAgentNext.listGitLabRepositories.queryOptions({
          forceRefresh: false,
        })
  );

  // Combined loading state - only show loading if both are loading
  const isLoadingRepos = isLoadingGitHubRepos && isLoadingGitLabRepos;

  // Refresh repositories hook (refreshes both GitHub and GitLab)
  const { refresh: refreshGitHubRepositories, isRefreshing: isRefreshingGitHubRepos } =
    useRefreshRepositories({
      getRefreshQueryOptions: useCallback(
        () =>
          organizationId
            ? trpc.organizations.cloudAgentNext.listGitHubRepositories.queryOptions({
                organizationId,
                forceRefresh: true,
              })
            : trpc.cloudAgentNext.listGitHubRepositories.queryOptions({
                forceRefresh: true,
              }),
        [organizationId, trpc]
      ),
      getCacheQueryKey: useCallback(
        () =>
          organizationId
            ? trpc.organizations.cloudAgentNext.listGitHubRepositories.queryKey({
                organizationId,
                forceRefresh: false,
              })
            : trpc.cloudAgentNext.listGitHubRepositories.queryKey({
                forceRefresh: false,
              }),
        [organizationId, trpc]
      ),
    });

  const { refresh: refreshGitLabRepositories, isRefreshing: isRefreshingGitLabRepos } =
    useRefreshRepositories({
      getRefreshQueryOptions: useCallback(
        () =>
          organizationId
            ? trpc.organizations.cloudAgentNext.listGitLabRepositories.queryOptions({
                organizationId,
                forceRefresh: true,
              })
            : trpc.cloudAgentNext.listGitLabRepositories.queryOptions({
                forceRefresh: true,
              }),
        [organizationId, trpc]
      ),
      getCacheQueryKey: useCallback(
        () =>
          organizationId
            ? trpc.organizations.cloudAgentNext.listGitLabRepositories.queryKey({
                organizationId,
                forceRefresh: false,
              })
            : trpc.cloudAgentNext.listGitLabRepositories.queryKey({
                forceRefresh: false,
              }),
        [organizationId, trpc]
      ),
    });

  // Combined refresh function
  const refreshRepositories = useCallback(async () => {
    await Promise.all([refreshGitHubRepositories(), refreshGitLabRepositories()]);
  }, [refreshGitHubRepositories, refreshGitLabRepositories]);

  const isRefreshingRepos = isRefreshingGitHubRepos || isRefreshingGitLabRepos;

  // Get repositories from both platforms
  const githubRepositories = (githubRepoData?.repositories || []) as Repository[];
  const gitlabRepositories = (gitlabRepoData?.repositories || []) as Repository[];

  // Combine repositories with platform tags
  const unifiedRepositories = useMemo<RepositoryOption[]>(() => {
    const github = githubRepositories.map(repo => ({
      id: repo.id,
      fullName: repo.fullName,
      private: repo.private,
      platform: 'github' as const,
    }));
    const gitlab = gitlabRepositories.map(repo => ({
      id: repo.id,
      fullName: repo.fullName,
      private: repo.private,
      platform: 'gitlab' as const,
    }));
    return [...github, ...gitlab];
  }, [githubRepositories, gitlabRepositories]);

  // Determine if grouping is needed (both platforms have repositories)
  const hasMultiplePlatforms = githubRepositories.length > 0 && gitlabRepositories.length > 0;

  // Handle repository selection - track platform based on selected repo
  const handleRepoSelect = useCallback(
    (repoFullName: string) => {
      setSelectedRepo(repoFullName);
      const repo = unifiedRepositories.find(r => r.fullName === repoFullName);
      if (repo?.platform) {
        setSelectedPlatform(repo.platform);
      }
    },
    [unifiedRepositories]
  );

  // Get the most recent sync time from either platform
  const syncedAt = githubRepoData?.syncedAt || gitlabRepoData?.syncedAt;

  // Combine errors - show first error if any
  const repoError = githubRepoError || gitlabRepoError;

  const handleStartSession = useCallback(async () => {
    if (!prompt.trim() || !selectedRepo) {
      return;
    }

    setIsPreparing(true);

    try {
      // Call prepareSession to create DB entry and cloud-agent-next DO
      // If a profile is selected, pass the profile name so the backend
      // can resolve encrypted secrets from the profile
      const baseInput = {
        prompt: prompt.trim(),
        mode,
        model,
        envVars: Object.keys(manualEnvVars).length > 0 ? manualEnvVars : undefined,
        setupCommands: manualSetupCommands.length > 0 ? manualSetupCommands : undefined,
        profileName: selectedProfile?.name,
        autoCommit: true,
      };

      let result: { kiloSessionId: string; cloudAgentSessionId: string };

      if (organizationId) {
        // Organization context - use org-scoped endpoint
        if (selectedPlatform === 'gitlab') {
          result = await trpcClient.organizations.cloudAgentNext.prepareSession.mutate({
            ...baseInput,
            gitlabProject: selectedRepo,
            organizationId,
          });
        } else {
          result = await trpcClient.organizations.cloudAgentNext.prepareSession.mutate({
            ...baseInput,
            githubRepo: selectedRepo,
            organizationId,
          });
        }
      } else {
        // Personal context
        if (selectedPlatform === 'gitlab') {
          result = await trpcClient.cloudAgentNext.prepareSession.mutate({
            ...baseInput,
            gitlabProject: selectedRepo,
          });
        } else {
          result = await trpcClient.cloudAgentNext.prepareSession.mutate({
            ...baseInput,
            githubRepo: selectedRepo,
          });
        }
      }

      // Invalidate the sessions list cache so the sidebar shows the new session
      void queryClient.invalidateQueries({
        queryKey: trpc.cliSessions.list.queryKey({
          limit: 3,
          createdOnPlatform: 'cloud-agent',
          orderBy: 'updated_at',
          organizationId: organizationId ?? null,
        }),
      });

      // Navigate to chat page with sessionId
      const basePath = organizationId
        ? `/organizations/${organizationId}/cloud-next`
        : '/cloud-next';
      router.push(`${basePath}/chat?sessionId=${result.kiloSessionId}`);
    } catch (error) {
      console.error('Failed to prepare session:', error);
      toast.error('Failed to create session. Please try again.');
    } finally {
      setIsPreparing(false);
    }
  }, [
    manualEnvVars,
    manualSetupCommands,
    model,
    mode,
    organizationId,
    prompt,
    queryClient,
    router,
    selectedPlatform,
    selectedRepo,
    selectedProfile,
    trpc.cliSessions.list,
    trpcClient,
  ]);

  const isFormValid =
    prompt.trim().length > 0 &&
    selectedRepo.length > 0 &&
    model.length > 0 &&
    !isPreparing &&
    !hasInsufficientBalance;

  const titleContent = (
    <div className="flex items-center gap-3">
      <h1 className="text-foreground text-3xl font-bold">Cloud Agent (Next)</h1>
      <Badge variant="new">beta</Badge>
    </div>
  );

  const subtitleContent = (
    <p className="text-muted-foreground">
      Start a new cloud agent session{' '}
      <a
        href="https://kilo.ai/docs/advanced-usage/cloud-agent"
        className="inline-flex items-center gap-1 text-blue-400 underline hover:text-blue-300"
      >
        Learn more
        <ExternalLink className="h-3 w-3" />
      </a>
    </p>
  );

  // Check if NEITHER platform has an integration installed
  const githubIntegrationMissing =
    !isLoadingGitHubRepos && githubRepoData?.integrationInstalled === false;
  const gitlabIntegrationMissing =
    !isLoadingGitLabRepos && gitlabRepoData?.integrationInstalled === false;
  const isIntegrationMissing = githubIntegrationMissing && gitlabIntegrationMissing;

  const content = (
    <>
      {/* Insufficient Balance Banner */}
      {hasInsufficientBalance && eligibilityData && (
        <div className="mb-6">
          <InsufficientBalanceBanner
            balance={eligibilityData.balance}
            content={{ type: 'productName', productName: 'Cloud Agent' }}
          />
        </div>
      )}

      {/* New Session Form */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5" />
            Start New Session
          </CardTitle>
          <CardDescription>
            Configure and launch a cloud agent to work on your repository
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Prompt */}
          <PromptField value={prompt} onChange={setPrompt} />

          {/* Repository Selector */}
          <RepositorySelector
            repositories={unifiedRepositories}
            value={selectedRepo}
            onChange={handleRepoSelect}
            isLoading={isLoadingRepos}
            error={repoError ? repoError.message : undefined}
            syncedAt={syncedAt}
            onRefresh={refreshRepositories}
            isRefreshing={isRefreshingRepos}
            groupByPlatform={hasMultiplePlatforms}
          />

          {/* Mode and Model Row */}
          <ModeModelRow
            mode={mode}
            model={model}
            onModeChange={setMode}
            onModelChange={newModel => {
              setModel(newModel);
              setIsModelUserSelected(true);
            }}
            modelOptions={modelOptions}
            isLoadingModels={!modelsData}
          />

          {/* Advanced Configuration */}
          <AdvancedConfig
            organizationId={organizationId}
            selectedProfileId={selectedProfileId}
            onProfileSelect={handleProfileSelect}
            manualEnvVars={manualEnvVars}
            manualSetupCommands={manualSetupCommands}
            effectiveEnvVars={effectiveEnvVars}
            effectiveSetupCommands={effectiveSetupCommands}
            onManualEnvVarsChange={setManualEnvVars}
            onManualSetupCommandsChange={setManualSetupCommands}
          />

          {/* Submit Button */}
          <SubmitButton
            onClick={handleStartSession}
            disabled={!isFormValid}
            isLoading={isPreparing}
          />
        </CardContent>
      </Card>
    </>
  );

  if (isIntegrationMissing) {
    const integrationsPath = organizationId
      ? `/organizations/${organizationId}/integrations`
      : '/integrations';
    const integrationMessage =
      githubRepoData?.errorMessage ||
      gitlabRepoData?.errorMessage ||
      'Connect a GitHub or GitLab integration to select a repository for the cloud agent.';

    const integrationContent = (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-amber-400" />
            Connect GitHub or GitLab to start a session
          </CardTitle>
          <CardDescription>{integrationMessage}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <p className="text-sm text-gray-300">
            We need access to your repositories to launch cloud agent sessions. Install the GitHub
            or GitLab integration to continue.
          </p>
          <div className="flex flex-wrap gap-3">
            <LinkButton href={integrationsPath} variant="primary" size="md">
              Open integrations
            </LinkButton>
            <Button variant="secondary" size="md" onClick={() => router.refresh()}>
              Refresh
            </Button>
          </div>
        </CardContent>
      </Card>
    );

    // When in organization context, skip PageLayout (OrganizationTrialWrapper provides PageContainer)
    if (organizationId) {
      return (
        <>
          <div className="flex items-start justify-between">
            <div className="flex flex-col gap-2">
              {titleContent}
              {subtitleContent}
            </div>
          </div>
          {integrationContent}
        </>
      );
    }

    return (
      <PageLayout title={titleContent} subtitle={subtitleContent}>
        {integrationContent}
      </PageLayout>
    );
  }

  // When in organization context, skip PageLayout (OrganizationTrialWrapper provides PageContainer)
  if (organizationId) {
    return (
      <>
        <div className="flex items-start justify-between">
          <div className="flex flex-col gap-2">
            {titleContent}
            {subtitleContent}
          </div>
        </div>
        {content}
      </>
    );
  }

  return (
    <PageLayout title={titleContent} subtitle={subtitleContent}>
      {content}
    </PageLayout>
  );
}

type PromptFieldProps = {
  value: string;
  onChange: (value: string) => void;
};

const PromptField = memo(function PromptField({ value, onChange }: PromptFieldProps) {
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onChange(e.target.value);
    },
    [onChange]
  );

  return (
    <div className="space-y-2">
      <Label htmlFor="prompt">Task Description</Label>
      <Textarea
        id="prompt"
        value={value}
        onChange={handleChange}
        placeholder="Describe your task..."
        rows={3}
        className="resize-y"
      />
      <p className="text-xs text-gray-400">Describe what you want the cloud agent to do</p>
    </div>
  );
});

type RepositorySelectorProps = {
  repositories: RepositoryOption[];
  value: string;
  onChange: (value: string) => void;
  isLoading: boolean;
  error?: string;
  syncedAt?: string | null;
  onRefresh?: () => void;
  isRefreshing?: boolean;
  groupByPlatform?: boolean;
};

const RepositorySelector = memo(function RepositorySelector({
  repositories,
  value,
  onChange,
  isLoading,
  error,
  syncedAt,
  onRefresh,
  isRefreshing,
  groupByPlatform,
}: RepositorySelectorProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>Repository</Label>
        {onRefresh && (
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-xs">
              Last synced:{' '}
              {syncedAt ? formatDistanceToNow(new Date(syncedAt), { addSuffix: true }) : 'Never'}
            </span>
            <UIButton
              type="button"
              variant="outline"
              size="sm"
              onClick={onRefresh}
              disabled={isRefreshing}
            >
              <RefreshCw className={cn('h-4 w-4', isRefreshing && 'animate-spin')} />
            </UIButton>
          </div>
        )}
      </div>
      <RepositoryCombobox
        repositories={repositories}
        value={value}
        onValueChange={onChange}
        isLoading={isLoading}
        error={error}
        helperText="Select a repository to work on"
        placeholder="Select a repository"
        emptyStateText="No repositories found"
        hideLabel
        groupByPlatform={groupByPlatform}
      />
    </div>
  );
});

type ModeModelRowProps = {
  mode: AgentMode;
  model: string;
  onModeChange: (value: AgentMode) => void;
  onModelChange: (value: string) => void;
  modelOptions: ModelOption[];
  isLoadingModels: boolean;
};

const ModeModelRow = memo(function ModeModelRow({
  mode,
  model,
  onModeChange,
  onModelChange,
  modelOptions,
  isLoadingModels,
}: ModeModelRowProps) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <ModeCombobox<AgentMode>
        label="Mode"
        value={mode}
        onValueChange={onModeChange}
        options={NEXT_MODE_OPTIONS}
      />

      <ModelCombobox
        label="Model"
        models={modelOptions}
        value={model}
        onValueChange={onModelChange}
        isLoading={isLoadingModels}
        required
      />
    </div>
  );
});

type SubmitButtonProps = {
  onClick: () => void;
  disabled: boolean;
  isLoading?: boolean;
};

const SubmitButton = memo(function SubmitButton({
  onClick,
  disabled,
  isLoading,
}: SubmitButtonProps) {
  return (
    <div className="pt-2">
      <Button
        onClick={onClick}
        disabled={disabled}
        variant="primary"
        size="lg"
        className="w-full md:w-auto"
      >
        {isLoading ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Creating Session...
          </>
        ) : (
          <>
            <Sparkles className="mr-2 h-4 w-4" />
            Start Session
          </>
        )}
      </Button>
    </div>
  );
});
